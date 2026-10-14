/**
 * DepotSafetyStock — Distribution Stage 2: forecast-error-based Safety Stock
 * per Material × Depot.
 *
 * Same methodology as ForecastErrorStats (90th percentile of positive
 * underforecast errors from the leakage-safe walk-forward backtest; see
 * services/safetyStockService.js), but at DEPOT scale: errors are measured
 * on the depot's own demand (actuals and predictions summed across the
 * plants mapped to that depot, per month) instead of being pooled across
 * every plant of a material. That is the scale a depot's stock is compared
 * against.
 *
 * A separate collection on purpose: ForecastErrorStats and Planning Master's
 * Safety Stock are untouched by Distribution.
 */
const mongoose = require("mongoose");

const nonNegative = (label) => ({
  validator: (v) => Number.isFinite(v) && v >= 0,
  message: `${label} must be finite and non-negative`,
});

const depotSafetyStockSchema = new mongoose.Schema(
  {
    materialNo: { type: String, required: true, uppercase: true, trim: true },
    depotId: { type: String, required: true, uppercase: true, trim: true },
    plants: { type: [String], default: [] }, // plants whose backtest observations were aggregated into this depot

    safetyStock: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && Number.isInteger(v) && v >= 0,
        message: "safetyStock must be a finite, non-negative integer",
      },
    },
    percentile: { type: Number, required: true, default: 0.9 },
    status: {
      type: String,
      required: true,
      enum: ["FORECAST_ERROR_BASED", "INSUFFICIENT_HISTORY", "NO_HISTORICAL_UNDERFORECAST", "ERROR"],
    },
    observationCount: { type: Number, required: true, validate: nonNegative("observationCount") },
    underForecastCount: { type: Number, required: true, validate: nonNegative("underForecastCount") },
    meanUnderforecast: { type: Number, required: true, validate: nonNegative("meanUnderforecast") },
    mae: { type: Number, required: true, validate: nonNegative("MAE") },
    rmse: { type: Number, required: true, validate: nonNegative("RMSE") },
    lastEvaluatedPeriod: { type: String, default: null },
    calculatedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "depotsafetystocks" }
);

depotSafetyStockSchema.index({ materialNo: 1, depotId: 1 }, { unique: true });
depotSafetyStockSchema.index({ depotId: 1 });

module.exports = mongoose.model("DepotSafetyStock", depotSafetyStockSchema);
