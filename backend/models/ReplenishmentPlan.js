/**
 * Replenishment Plan — monthly allocation of the already-calculated Required
 * Stock across the months of the working quarter.
 *
 * This is NOT demand distribution: it controls WHEN the Required Stock is
 * replenished. Percentages are converted to integer quantities that sum
 * exactly to the Required Stock using a deterministic largest-remainder
 * algorithm.
 *
 * One document per material + depot + FY + quarter.
 *
 * distributionMode:
 *   "MANUAL"        — a planner-saved override. ONLY this mode is persisted.
 *   "AUTO_FORECAST" — the automatic forecast-driven allocation. It is NEVER
 *                     stored here: it is recomputed live on every planning
 *                     view from the XGBoost demand forecast + current
 *                     inventory (utils/replenishmentPrediction.js) so it can
 *                     never go stale, and a saved MANUAL plan is never
 *                     overwritten by it.
 */
const mongoose = require("mongoose");

const REQUIRED_STOCK_MONTHS = ["July", "August", "September", "October", "November", "December", "January", "February", "March", "April", "May", "June"];

const distributionEntrySchema = new mongoose.Schema(
  {
    month: { type: String, required: true, trim: true },
    percentage: { type: Number, required: true, min: 0, max: 100 },
    quantity: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ["actual", "forecast", "none"], required: true },
  },
  { _id: false }
);

const replenishmentPlanSchema = new mongoose.Schema(
  {
    materialNo: { type: String, required: true, trim: true },
    depotId: { type: String, trim: true, default: "" },
    financialYear: { type: String, required: true, trim: true },
    quarter: { type: String, required: true, trim: true },
    requiredStock: { type: Number, required: true, min: 0 },
    // Only MANUAL is persisted (AUTO_FORECAST is recomputed live and never
    // stored, so it can be refreshed when the forecast regenerates).
    distributionMode: { type: String, enum: ["AUTO_FORECAST", "MANUAL"], default: "MANUAL" },
    distribution: { type: [distributionEntrySchema], required: true },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true }
);

// One allocation per material + depot + FY + quarter.
replenishmentPlanSchema.index({ materialNo: 1, depotId: 1, financialYear: 1, quarter: 1 }, { unique: true });

module.exports = mongoose.model("ReplenishmentPlan", replenishmentPlanSchema);
module.exports.REQUIRED_STOCK_MONTHS = REQUIRED_STOCK_MONTHS;
