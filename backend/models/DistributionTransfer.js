const mongoose = require("mongoose");
const {
  TRANSFER_STATUSES,
  TRANSFER_INITIAL_STATUS,
  TRANSFER_TRANSITIONS,
  canTransition,
} = require("../utils/distributionLifecycle");

const TRANSFER_ID_PATTERN = /^TRF-\d{6,}$/;

/**
 * Distribution Transfer — the actual inter-depot business transaction,
 * deliberately separate from DistributionRecommendation (a suggestion).
 * A transfer may originate from an approved recommendation (recommendationId)
 * or be raised manually; either way only a transfer ever represents stock
 * that is being, or has been, moved.
 *
 * Lifecycle (utils/distributionLifecycle.js):
 *   REQUESTED → APPROVED → DISPATCHED → IN_TRANSIT → RECEIVED
 *   REQUESTED | APPROVED → CANCELLED
 *
 * Each stage reached must carry its quantity/actor/timestamp, and data for a
 * stage not yet reached must be absent — so a record can never claim to be
 * received without a dispatch, or carry a dispatch while still REQUESTED.
 * Quantities may only shrink along the chain (requested ≥ approved ≥
 * dispatched ≥ received); a received shortfall is kept as recorded, not
 * corrected here. Stage 1 never mutates Stock Master — stock movement is a
 * later stage.
 *
 * statusHistory is an append-only audit trail written on every status change
 * (see appendStatusHistory, called from pre("save")).
 *
 * Stage 4 — physical movement identity. At DISPATCH the exact Stock Master
 * rows that move are resolved (depot → plant via DepotPlantMapping → the one
 * Stock row for material + plant) and persisted here, together with the unit
 * cost used to value the movement, so RECEIPT reverses the in-transit value
 * exactly and every movement is traceable (see services/stockMovementService.js
 * and the StockMovement ledger). A short receipt keeps dispatched and received
 * quantities as recorded; the difference is stored as transitLossQuantity with
 * a mandatory discrepancyReason.
 *
 * optimisticConcurrency: every save is conditional on the version read, so a
 * stale concurrent lifecycle update fails instead of overwriting.
 */
const STAGE_RANK = { REQUESTED: 0, APPROVED: 1, DISPATCHED: 2, IN_TRANSIT: 3, RECEIVED: 4 };

// Fields that belong to each stage, checked cumulatively by STAGE_RANK.
const STAGE_FIELDS = {
  APPROVED: ["approvedQuantity", "approvedBy", "approvedAt"],
  DISPATCHED: ["dispatchedQuantity", "dispatchedBy", "dispatchedAt",
    "sourcePlantName", "sourceStockId", "destinationPlantName", "destinationStockId", "unitCost"],
  IN_TRANSIT: ["inTransitBy", "inTransitAt"],
  RECEIVED: ["receivedQuantity", "receivedBy", "receivedAt", "transitLossQuantity"],
};
const CANCEL_FIELDS = ["cancelledBy", "cancelledAt", "cancellationReason"];

// Who/when to record in statusHistory for each status.
const STATUS_ACTOR = {
  REQUESTED: ["requestedBy", "requestedAt"],
  APPROVED: ["approvedBy", "approvedAt"],
  DISPATCHED: ["dispatchedBy", "dispatchedAt"],
  IN_TRANSIT: ["inTransitBy", "inTransitAt"],
  RECEIVED: ["receivedBy", "receivedAt"],
  CANCELLED: ["cancelledBy", "cancelledAt"],
};

const wholeNumber = (min) => ({
  validator: (v) => v === undefined || v === null || (Number.isInteger(v) && v >= min),
  message: `{PATH} must be a whole number ≥ ${min}.`,
});

const isPresent = (v) => v !== undefined && v !== null && v !== "";

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: TRANSFER_STATUSES, required: true },
    changedAt: { type: Date, required: true },
    changedBy: { type: String, required: true, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const distributionTransferSchema = new mongoose.Schema(
  {
    transferId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      immutable: true,
      match: [TRANSFER_ID_PATTERN, 'transferId must look like "TRF-000001".'],
    },
    materialNo: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    sourceDepotId: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    destinationDepotId: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: "DistributionRecommendation", immutable: true },

    status: { type: String, enum: TRANSFER_STATUSES, required: true, default: TRANSFER_INITIAL_STATUS },
    reason: { type: String, required: true, trim: true },
    notes: { type: String, trim: true },

    requestedQuantity: { type: Number, required: true, immutable: true, validate: wholeNumber(1) },
    approvedQuantity: { type: Number, validate: wholeNumber(1) },
    dispatchedQuantity: { type: Number, validate: wholeNumber(1) },
    receivedQuantity: { type: Number, validate: wholeNumber(0) },

    requestedBy: { type: String, required: true, trim: true, immutable: true },
    requestedAt: { type: Date, required: true, default: Date.now, immutable: true },
    approvedBy: { type: String, trim: true },
    approvedAt: { type: Date },
    dispatchedBy: { type: String, trim: true },
    dispatchedAt: { type: Date },
    inTransitBy: { type: String, trim: true },
    inTransitAt: { type: Date },
    receivedBy: { type: String, trim: true },
    receivedAt: { type: Date },
    cancelledBy: { type: String, trim: true },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true },

    // ---- Stage 4: resolved physical stock rows (set at DISPATCH) ----
    sourcePlantName: { type: String, trim: true },
    sourceStockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock" },
    destinationPlantName: { type: String, trim: true },
    destinationStockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock" },
    unitCost: { type: Number, min: 0 }, // Material.invCost at dispatch — values the in-transit stock
    // ---- Stage 4: receipt discrepancy (set at RECEIPT) ----
    transitLossQuantity: { type: Number, validate: wholeNumber(0) }, // dispatchedQuantity − receivedQuantity
    discrepancyReason: { type: String, trim: true },

    statusHistory: { type: [statusHistorySchema], default: [] },
  },
  { timestamps: true, optimisticConcurrency: true }
);

distributionTransferSchema.post("init", function rememberStatus() {
  this.$locals.persistedStatus = this.status;
});

distributionTransferSchema.pre("validate", function enforceTransferRules(next) {
  if (this.sourceDepotId && this.sourceDepotId === this.destinationDepotId) {
    this.invalidate("destinationDepotId", "Source and destination depot must be different.");
  }

  // Lifecycle: new records start REQUESTED; existing ones may only move along the map.
  const from = this.$locals.persistedStatus;
  if (this.isNew && this.status !== TRANSFER_INITIAL_STATUS) {
    this.invalidate("status", `A new transfer must start as ${TRANSFER_INITIAL_STATUS}.`);
  } else if (!this.isNew && from && from !== this.status && !canTransition(TRANSFER_TRANSITIONS, from, this.status)) {
    this.invalidate("status", `Invalid transfer status transition: ${from} → ${this.status}.`);
  }

  // Stage data: required once the stage is reached, absent before it.
  const cancelled = this.status === "CANCELLED";
  const rank = cancelled ? (isPresent(this.approvedAt) ? STAGE_RANK.APPROVED : STAGE_RANK.REQUESTED) : STAGE_RANK[this.status];
  Object.entries(STAGE_FIELDS).forEach(([stage, fields]) => {
    const reached = STAGE_RANK[stage] <= rank;
    fields.forEach((f) => {
      if (reached && !isPresent(this[f])) this.invalidate(f, `${f} is required once a transfer is ${stage}.`);
      if (!reached && isPresent(this[f])) this.invalidate(f, `${f} cannot be set before a transfer is ${stage}.`);
    });
  });
  CANCEL_FIELDS.forEach((f) => {
    if (cancelled && !isPresent(this[f])) this.invalidate(f, `${f} is required for a CANCELLED transfer.`);
    if (!cancelled && isPresent(this[f])) this.invalidate(f, `${f} is only set on a CANCELLED transfer.`);
  });

  // Quantities only shrink along the chain.
  const chain = [
    ["approvedQuantity", "requestedQuantity"],
    ["dispatchedQuantity", "approvedQuantity"],
    ["receivedQuantity", "dispatchedQuantity"],
  ];
  chain.forEach(([later, earlier]) => {
    if (isPresent(this[later]) && isPresent(this[earlier]) && this[later] > this[earlier]) {
      this.invalidate(later, `${later} cannot exceed ${earlier}.`);
    }
  });

  // Receipt discrepancy: loss = dispatched − received, and a short receipt must say why.
  if (this.status === "RECEIVED" && isPresent(this.dispatchedQuantity) && isPresent(this.receivedQuantity)) {
    const loss = this.dispatchedQuantity - this.receivedQuantity;
    if (isPresent(this.transitLossQuantity) && this.transitLossQuantity !== loss) {
      this.invalidate("transitLossQuantity", "transitLossQuantity must equal dispatchedQuantity − receivedQuantity.");
    }
    if (loss > 0 && !isPresent(this.discrepancyReason)) {
      this.invalidate("discrepancyReason", "A discrepancy reason is required when less is received than was dispatched.");
    }
  }
  if (this.status !== "RECEIVED" && isPresent(this.discrepancyReason)) {
    this.invalidate("discrepancyReason", "discrepancyReason is only recorded on a RECEIVED transfer.");
  }

  // Timestamps must follow the lifecycle order.
  const times = ["requestedAt", "approvedAt", "dispatchedAt", "inTransitAt", "receivedAt"].filter((f) => isPresent(this[f]));
  for (let i = 1; i < times.length; i += 1) {
    if (this[times[i]] < this[times[i - 1]]) this.invalidate(times[i], `${times[i]} cannot be earlier than ${times[i - 1]}.`);
  }
  if (cancelled && isPresent(this.cancelledAt) && this.cancelledAt < this.requestedAt) {
    this.invalidate("cancelledAt", "cancelledAt cannot be earlier than requestedAt.");
  }
  next();
});

/**
 * Appends one audit entry for the current status when the record is new or
 * its status changed. `this.$locals.changedBy` / `statusNote` let a later
 * service name the acting user explicitly; otherwise the stage's own actor
 * and timestamp fields are used.
 */
distributionTransferSchema.methods.appendStatusHistory = function appendStatusHistory() {
  if (!this.isNew && !this.isModified("status")) return;
  const [byField, atField] = STATUS_ACTOR[this.status] || [];
  this.statusHistory.push({
    status: this.status,
    changedAt: (atField && this[atField]) || new Date(),
    changedBy: this.$locals.changedBy || (byField && this[byField]) || "system",
    note: this.$locals.statusNote,
  });
};

distributionTransferSchema.pre("save", function recordStatusHistory(next) {
  this.appendStatusHistory();
  next();
});

distributionTransferSchema.index({ status: 1, requestedAt: -1 });
distributionTransferSchema.index({ materialNo: 1, status: 1 });
distributionTransferSchema.index({ sourceDepotId: 1, status: 1 });
distributionTransferSchema.index({ destinationDepotId: 1, status: 1 });
distributionTransferSchema.index({ recommendationId: 1 });

module.exports = mongoose.model("DistributionTransfer", distributionTransferSchema);
module.exports.STATUS_VALUES = TRANSFER_STATUSES;
module.exports.TRANSFER_ID_PATTERN = TRANSFER_ID_PATTERN;
