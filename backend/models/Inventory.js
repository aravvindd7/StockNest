const mongoose = require("mongoose");

const STOCK_STATUSES = ["IN STOCK", "LOW STOCK", "OUT OF STOCK", "OVERSTOCK"];

/**
 * One document = one material at one branch (in one warehouse).
 * A material stocked in 5 branches produces 5 Inventory documents —
 * this is what lets the Inventory page show branch-wise rows like:
 *   MAT0007   Chennai      150
 *   MAT0007   Coimbatore   420
 */
const inventorySchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "Material", required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },

    currentStock: { type: Number, required: true, min: 0, default: 0 },
    reservedStock: { type: Number, required: true, min: 0, default: 0 },
    damagedStock: { type: Number, required: true, min: 0, default: 0 },
    returnedStock: { type: Number, required: true, min: 0, default: 0 },
    // availableStock is derived (currentStock - reservedStock - damagedStock),
    // recomputed in the pre-save hook below rather than trusted from input.
    availableStock: { type: Number, min: 0, default: 0 },

    reorderLevel: { type: Number, required: true, min: 0, default: 10 },
    maximumCapacity: { type: Number, required: true, min: 0, default: 500 },

    unitCost: { type: Number, required: true, min: 0 }, // used to derive inventoryValue

    stockStatus: { type: String, enum: STOCK_STATUSES, default: "IN STOCK" },

    lastRestocked: { type: Date, default: Date.now },
  },
  { timestamps: true } // createdAt / updatedAt — updatedAt doubles as "Last Updated"
);

// One material can only have one inventory record per branch+warehouse combination.
inventorySchema.index({ materialId: 1, branchId: 1, warehouseId: 1 }, { unique: true });
inventorySchema.index({ stockStatus: 1 });
inventorySchema.index({ branchId: 1 });
inventorySchema.index({ warehouseId: 1 });

function computeStatus(doc) {
  if (doc.availableStock <= 0) return "OUT OF STOCK";
  if (doc.availableStock <= doc.reorderLevel) return "LOW STOCK";
  if (doc.availableStock > doc.maximumCapacity) return "OVERSTOCK";
  return "IN STOCK";
}

inventorySchema.pre("save", function (next) {
  this.availableStock = Math.max(0, this.currentStock - this.reservedStock - this.damagedStock);
  this.stockStatus = computeStatus(this);
  next();
});

// findOneAndUpdate bypasses pre('save'), so recompute here too for any
// future update endpoints (e.g. adjusting stock from a purchase order).
inventorySchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();
  const $set = update.$set || update;

  const current = $set.currentStock;
  const reserved = $set.reservedStock;
  const damaged = $set.damagedStock;

  if (current !== undefined || reserved !== undefined || damaged !== undefined) {
    // Only safe to recompute here if the full triplet is present; otherwise
    // leave it to a controller-level read-modify-write for partial updates.
    if (current !== undefined && reserved !== undefined && damaged !== undefined) {
      const availableStock = Math.max(0, current - reserved - damaged);
      $set.availableStock = availableStock;

      const reorderLevel = $set.reorderLevel ?? this.getQuery().reorderLevel;
      const maximumCapacity = $set.maximumCapacity ?? this.getQuery().maximumCapacity;
      if (reorderLevel !== undefined && maximumCapacity !== undefined) {
        $set.stockStatus = computeStatus({ availableStock, reorderLevel, maximumCapacity });
      }
    }
  }
  next();
});

module.exports = mongoose.model("Inventory", inventorySchema);
module.exports.STOCK_STATUSES = STOCK_STATUSES;
