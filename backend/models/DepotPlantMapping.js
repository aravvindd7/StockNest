const mongoose = require("mongoose");

/**
 * Depot ↔ Plant mapping — Distribution Stage 2.
 *
 * Links a Depot Master record (depotId) to the Plant identity that Sales
 * Master (Plant) and Stock Master (PlantName) use, so Distribution can turn
 * Material × Plant data (history, forecasts, stock) into Material × Depot.
 *
 * Kept as a separate configuration model on purpose:
 *   - Depot Master stays a clean two-field business master (see Depot.js) —
 *     no plant fields are added to it.
 *   - The relationship is explicit data, never inferred by matching names
 *     ("Chennai" → "Chennai Plant" is never assumed).
 *   - Many plants may feed one depot; a plant may be re-pointed to another
 *     depot over time (deactivate the old mapping, add a new one with its
 *     own effectiveFrom), and each company can configure its own topology.
 *
 * Uniqueness: a plant can have at most ONE active mapping (a plant's demand
 * must resolve to exactly one depot) — enforced by a partial unique index.
 * depotId is deliberately NOT unique, so several plants can share a depot.
 * Inactive mappings are kept as history and are not constrained.
 *
 * Reference checks (depot exists in Depot Master; plant exists in Sales or
 * Stock) need the database, so they live in services/depotPlantMappingService.js
 * and run on every create, update and import before anything is written.
 */
const depotPlantMappingSchema = new mongoose.Schema(
  {
    depotId: { type: String, required: true, trim: true, uppercase: true },
    plantName: { type: String, required: true, trim: true }, // exact Sales.Plant / Stock.PlantName value
    isActive: { type: Boolean, default: true },
    effectiveFrom: { type: Date },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

depotPlantMappingSchema.index({ plantName: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
depotPlantMappingSchema.index({ depotId: 1, isActive: 1 });

module.exports = mongoose.model("DepotPlantMapping", depotPlantMappingSchema);
