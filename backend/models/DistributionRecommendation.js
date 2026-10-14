const mongoose = require("mongoose");
const { isValidFinancialYear, isValidMonth } = require("../utils/financialYear");
const {
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_INITIAL_STATUS,
  RECOMMENDATION_TRANSITIONS,
  canTransition,
} = require("../utils/distributionLifecycle");

const PRIORITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/**
 * Distribution Recommendation — one generated, explainable suggestion to move
 * a material from a surplus depot to a shortage depot. It is a decision-support
 * record ONLY: it never moves stock. Acting on it creates a separate
 * DistributionTransfer (the business transaction), linked back via transferId.
 *
 * Source-of-truth rule: Material Master, Depot Master, Stock Master, Sales
 * Master and ForecastErrorStats stay the single sources of truth. This record
 * references them by the same business keys the rest of the project uses
 * (materialNo ↔ Material.materialNo, depotId ↔ Depot.depotId — exactly like
 * ReplenishmentPlan) and stores the numbers the engine used as an immutable
 * point-in-time SNAPSHOT, so the reason stays auditable after stock, sales or
 * safety stock change. It is not a second copy of those masters.
 *
 * Snapshot math (computed by services/distributionRecommendationService.js;
 * only basic invariants are enforced here so the formula can evolve without a
 * schema change):
 *   sourceSurplus        = max(0, sourceStockInHand − sourceOpenCommitments − sourceSafetyStock − sourceForecastDemand)
 *                          (stock IN HAND only — stock in transit cannot be shipped; stock already
 *                          committed to open REQUESTED/APPROVED transfers is not available again)
 *   destinationShortage  = max(0, destinationForecastDemand + destinationSafetyStock − destinationCurrentStock − destinationOpenInbound)
 *                          (open inbound transfers already cover part of the need)
 * Enforced invariants: every snapshot quantity is a whole number ≥ 0; the
 * recommended (and approved) quantity never exceeds the source's surplus or
 * the destination's shortage; source ≠ destination.
 */
const wholeNumber = {
  validator: (v) => v === undefined || v === null || Number.isInteger(v),
  message: "{PATH} must be a whole number.",
};
const quantity = (extra = {}) => ({ type: Number, required: true, min: 0, immutable: true, validate: wholeNumber, ...extra });
const positiveInteger = {
  validator: (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 1),
  message: "{PATH} must be a positive whole number.",
};

const forecastPeriodSchema = new mongoose.Schema(
  {
    financialYear: {
      type: String,
      required: true,
      trim: true,
      validate: { validator: isValidFinancialYear, message: 'forecastPeriod.financialYear must be "YYYY-YY", e.g. "2026-27".' },
    },
    startMonth: {
      type: String,
      required: true,
      trim: true,
      validate: { validator: isValidMonth, message: "forecastPeriod.startMonth must be a month name, e.g. \"October\"." },
    },
    horizonMonths: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      validate: { validator: Number.isInteger, message: "forecastPeriod.horizonMonths must be a whole number." },
    },
  },
  { _id: false }
);

const distributionRecommendationSchema = new mongoose.Schema(
  {
    materialNo: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    sourceDepotId: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    destinationDepotId: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    forecastPeriod: { type: forecastPeriodSchema, required: true, immutable: true },

    // ---- Source depot snapshot ----
    sourceCurrentStock: quantity(), // total stock (in hand + in transit) — context only
    sourceStockInHand: quantity(), // SIHQty — the only stock a transfer can physically ship
    sourceOpenCommitments: quantity({ required: false, default: 0 }), // open REQUESTED/APPROVED transfers out of the source
    sourceSafetyStock: quantity(),
    sourceForecastDemand: quantity({ required: false, default: 0 }),
    sourceSurplus: quantity(),

    // ---- Destination depot snapshot ----
    destinationCurrentStock: quantity(),
    destinationSafetyStock: quantity(),
    destinationForecastDemand: quantity(),
    destinationShortage: quantity(),
    destinationOpenInbound: quantity({ required: false, default: 0 }), // open REQUESTED/APPROVED transfers into the destination

    // ---- Recommendation ----
    recommendedQuantity: quantity({ validate: positiveInteger }),
    priority: { type: String, enum: PRIORITY_VALUES, required: true, immutable: true },
    reason: { type: String, required: true, trim: true, immutable: true },
    generatedAt: { type: Date, required: true, default: Date.now, immutable: true },
    generationRunId: { type: String, trim: true, immutable: true }, // groups one engine run, so a re-run can supersede it
    generatedBy: { type: String, trim: true, immutable: true },

    // ---- Admin review ----
    status: { type: String, enum: RECOMMENDATION_STATUSES, required: true, default: RECOMMENDATION_INITIAL_STATUS },
    approvedQuantity: { type: Number, validate: positiveInteger }, // the (possibly edited) quantity the admin approved
    reviewedBy: { type: String, trim: true },
    reviewedAt: { type: Date },
    reviewNotes: { type: String, trim: true },
    transferId: { type: String, trim: true, uppercase: true }, // DistributionTransfer.transferId created from this approval
    supersededByRunId: { type: String, trim: true }, // the generation run that replaced this PENDING suggestion
    supersededAt: { type: Date },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Remember the persisted status so a later save can be checked as a transition.
distributionRecommendationSchema.post("init", function rememberStatus() {
  this.$locals.persistedStatus = this.status;
});

distributionRecommendationSchema.pre("validate", function enforceRecommendationRules(next) {
  if (this.sourceDepotId && this.sourceDepotId === this.destinationDepotId) {
    this.invalidate("destinationDepotId", "Source and destination depot must be different.");
  }
  if (this.sourceStockInHand > this.sourceCurrentStock) {
    this.invalidate("sourceStockInHand", "Source stock in hand cannot exceed the source's total stock.");
  }
  if (this.sourceSurplus > Math.max(0, this.sourceStockInHand - (this.sourceOpenCommitments || 0))) {
    this.invalidate("sourceSurplus", "Source surplus cannot exceed the source's uncommitted stock in hand (stock in transit is not transferable).");
  }
  if (this.recommendedQuantity > this.sourceSurplus) {
    this.invalidate("recommendedQuantity", "Recommended quantity cannot exceed the source depot's surplus.");
  } else if (this.recommendedQuantity > this.destinationShortage) {
    this.invalidate("recommendedQuantity", "Recommended quantity cannot exceed the destination depot's shortage.");
  }

  // Lifecycle: new records start PENDING; existing ones may only move along the map.
  const from = this.$locals.persistedStatus;
  if (this.isNew && this.status !== RECOMMENDATION_INITIAL_STATUS) {
    this.invalidate("status", `A new recommendation must start as ${RECOMMENDATION_INITIAL_STATUS}.`);
  } else if (!this.isNew && from && from !== this.status && !canTransition(RECOMMENDATION_TRANSITIONS, from, this.status)) {
    this.invalidate("status", `Invalid recommendation status transition: ${from} → ${this.status}.`);
  }

  // Status-dependent review data.
  if (this.status === "APPROVED") {
    if (!this.approvedQuantity) this.invalidate("approvedQuantity", "An approved recommendation needs an approved quantity.");
    else if (this.approvedQuantity > this.sourceSurplus) {
      this.invalidate("approvedQuantity", "Approved quantity cannot exceed the source depot's surplus.");
    } else if (this.approvedQuantity > this.destinationShortage) {
      this.invalidate("approvedQuantity", "Approved quantity cannot exceed the destination depot's shortage.");
    }
  } else {
    if (this.approvedQuantity) this.invalidate("approvedQuantity", "Approved quantity is only set on an APPROVED recommendation.");
    if (this.transferId) this.invalidate("transferId", "Only an APPROVED recommendation can link to a transfer.");
  }
  if (this.status !== "SUPERSEDED" && (this.supersededByRunId || this.supersededAt)) {
    this.invalidate("supersededByRunId", "Only a SUPERSEDED recommendation records the run that replaced it.");
  }
  if (["APPROVED", "REJECTED"].includes(this.status)) {
    if (!this.reviewedBy) this.invalidate("reviewedBy", `A ${this.status} recommendation needs reviewedBy.`);
    if (!this.reviewedAt) this.invalidate("reviewedAt", `A ${this.status} recommendation needs reviewedAt.`);
  }
  next();
});

distributionRecommendationSchema.index({ status: 1, generatedAt: -1 });
distributionRecommendationSchema.index({ materialNo: 1, destinationDepotId: 1, status: 1 });
distributionRecommendationSchema.index({ sourceDepotId: 1, status: 1 });
distributionRecommendationSchema.index({ generationRunId: 1 });
// At most one open (PENDING) suggestion per material + route + forecast period.
distributionRecommendationSchema.index(
  { materialNo: 1, sourceDepotId: 1, destinationDepotId: 1, "forecastPeriod.financialYear": 1, "forecastPeriod.startMonth": 1 },
  { unique: true, partialFilterExpression: { status: "PENDING" } }
);
// Within one generation run, one recommendation per material + route + forecast period.
distributionRecommendationSchema.index(
  { generationRunId: 1, materialNo: 1, sourceDepotId: 1, destinationDepotId: 1, "forecastPeriod.financialYear": 1, "forecastPeriod.startMonth": 1 },
  { unique: true, partialFilterExpression: { generationRunId: { $type: "string" } } }
);

module.exports = mongoose.model("DistributionRecommendation", distributionRecommendationSchema);
module.exports.PRIORITY_VALUES = PRIORITY_VALUES;
module.exports.STATUS_VALUES = RECOMMENDATION_STATUSES;
