const mongoose = require("mongoose");

/**
 * Forecast Predictions — Phase 4. Deliberately minimal (Section 13:
 * "Keep this schema minimal for Phase 4. Do not add speculative fields
 * just because they may be useful later").
 *
 * This is NOT Sales Master. Sales Master represents historical actual
 * sales ("what happened") and is never written to by the forecasting
 * pipeline. This collection holds predicted future values only, produced
 * by the Python ML service (backend/services/mlServiceClient.js calls it
 * over HTTP) and persisted here by Node — the ML service itself never
 * writes to MongoDB directly (see ml-service/app/main.py's top comment).
 *
 * One document = one Material + Plant + forecast Month prediction.
 * Planning Service aggregates across Plant (and Month -> Quarter) when
 * reading these, the same way it already aggregates Sales Master's raw
 * monthly rows — this collection is not pre-aggregated.
 *
 * FORECAST INTELLIGENCE (added this phase, not speculative — each field
 * here backs a specific line item Part 5 explicitly requires the
 * Forecast Details panel to show): confidence/confidenceTier are derived
 * from this material's own measured backtest accuracy (segmentWmape), not
 * an arbitrary percentage — see ml-service/app/intelligence.py for the
 * full methodology and where the tier thresholds come from. trend/
 * seasonality are computed from this material's actual sales history via
 * the same method Phase 3's independent audit used. reason is a sentence
 * built only from these same already-computed values — never a fabricated
 * explanation.
 */
const forecastPredictionSchema = new mongoose.Schema(
  {
    materialNo: { type: String, required: true, trim: true, uppercase: true },
    plant: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true, trim: true }, // e.g. "2027-28"
    month: { type: String, required: true, trim: true },
    quarter: { type: String, required: true, trim: true }, // Q1-Q4, derived the same way Sales Master derives it — never entered independently
    predictedSalesQty: { type: Number, required: true, min: 0 },
    model: { type: String, required: true, enum: ["XGBoost", "WMA_FALLBACK"] },
    modelVersion: { type: String, required: true },
    generatedAt: { type: Date, required: true, default: Date.now },

    // Forecast intelligence — all optional so older/partial documents
    // (or a WMA_FALLBACK row with no backtest evidence) remain valid.
    monthsAheadInHorizon: { type: Number },
    confidence: { type: Number, min: 0, max: 100 },
    confidenceTier: { type: String, enum: ["HIGH", "MEDIUM", "LOW"] },
    segmentWmape: { type: Number },
    horizonAdjustedWmape: { type: Number }, // Phase 6: segmentWmape adjusted by the empirically-measured horizon multiplier — see ml-service/app/intelligence.py
    historyMonths: { type: Number },
    trend: { type: String },
    seasonality: { type: String },
    seasonalityPeakQuarter: { type: String },
    reason: { type: String },

    // Rolling multi-year metadata — records how many total months the
    // generation request targeted (e.g. 36), so the frontend and
    // planningService can display the correct denominator in the forecast
    // horizon label without assuming 12.
    horizonMonths: { type: Number },
  },
  { timestamps: true }
);

// One prediction per Material+Plant+FinancialYear+Month — re-generating
// forecasts overwrites the prior prediction for that exact period rather
// than accumulating duplicates.
forecastPredictionSchema.index({ materialNo: 1, plant: 1, financialYear: 1, month: 1 }, { unique: true });

module.exports = mongoose.model("ForecastPredictions", forecastPredictionSchema);
