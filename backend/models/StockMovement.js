const mongoose = require("mongoose");

const MOVEMENT_TYPES = ["DISPATCH", "RECEIPT", "TRANSIT_LOSS"];
const SIDES = ["SOURCE", "DESTINATION"];

/**
 * StockMovement — Distribution Stage 4: append-only AUDIT LEDGER of every
 * physical Stock Master change Distribution makes. It is NOT a second source
 * of truth: current balances live only in Stock Master; this records the
 * change applied to one Stock row, with its before/after values, inside the
 * same MongoDB transaction as the change itself.
 *
 *   DISPATCH / SOURCE       source row:      SIH −q, Total −q            (goods leave)
 *   DISPATCH / DESTINATION  destination row: SIT +q, Total +q            (goods inbound)
 *   RECEIPT / DESTINATION   destination row: SIT −received, SIH +received
 *   TRANSIT_LOSS / DEST.    destination row: SIT −loss, Total −loss      (short receipt)
 *
 * Exactly-once: the unique index on (transferId, movementType, side) makes it
 * impossible to apply the same movement twice — a duplicate aborts the whole
 * transaction. Append-only: updates and deletes are refused at the model level.
 */
const quantitySnapshotSchema = new mongoose.Schema(
  {
    SIHQty: { type: Number, required: true },
    SITQTY: { type: Number, required: true },
    TotalStockQty: { type: Number, required: true },
    SIHCV: { type: Number, required: true },
    SITCV: { type: Number, required: true },
    TotalStockCV: { type: Number, required: true },
  },
  { _id: false }
);

const deltaSchema = new mongoose.Schema(
  {
    SIHQty: { type: Number, default: 0 },
    SITQTY: { type: Number, default: 0 },
    TotalStockQty: { type: Number, default: 0 },
  },
  { _id: false }
);

const stockMovementSchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, trim: true, uppercase: true },
    movementType: { type: String, enum: MOVEMENT_TYPES, required: true },
    side: { type: String, enum: SIDES, required: true },
    materialNo: { type: String, required: true, trim: true, uppercase: true },
    depotId: { type: String, required: true, trim: true, uppercase: true },
    plantName: { type: String, required: true, trim: true },
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
    storageLocation: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 }, // magnitude of the movement
    change: { type: deltaSchema, required: true }, // signed per-field quantity change
    unitCost: { type: Number, required: true, min: 0 },
    before: { type: quantitySnapshotSchema, required: true },
    after: { type: quantitySnapshotSchema, required: true },
    actor: { type: String, required: true, trim: true },
    idempotencyKey: { type: String, required: true, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ transferId: 1, movementType: 1, side: 1 }, { unique: true });
stockMovementSchema.index({ stockId: 1, createdAt: 1 });
stockMovementSchema.index({ materialNo: 1, depotId: 1, createdAt: 1 });

// ---- Append-only enforcement ----
function refuse(next) {
  next(new Error("StockMovement is an append-only ledger — entries cannot be modified or deleted."));
}
["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"].forEach((op) => {
  stockMovementSchema.pre(op, { document: false, query: true }, refuse);
});
stockMovementSchema.pre("deleteOne", { document: true, query: false }, refuse);
stockMovementSchema.pre("save", function appendOnly(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

module.exports = mongoose.model("StockMovement", stockMovementSchema);
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
module.exports.SIDES = SIDES;
