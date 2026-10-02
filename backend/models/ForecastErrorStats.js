/**
 * ForecastErrorStats — Stage 3: Forecast-Error-Based Safety Stock Statistics
 *
 * One document per material. Aggregates historical backtest errors across all
 * plants for that material to compute a material-level Safety Stock based on
 * the 90th percentile of positive underforecast errors (actual > prediction).
 *
 * This is NOT per-plant Safety Stock. Planning Master operates at material
 * level (aggregating across plants), so Safety Stock is also material-level.
 */
const mongoose = require("mongoose");

const forecastErrorStatsSchema = new mongoose.Schema(
  {
    materialNo: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    safetyStock: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && Number.isInteger(v) && v >= 0,
        message: "safetyStock must be a finite, non-negative integer",
      },
    },

    percentile: {
      type: Number,
      required: true,
      default: 0.90,
    },

    status: {
      type: String,
      required: true,
      enum: [
        "FORECAST_ERROR_BASED",
        "INSUFFICIENT_HISTORY",
        "NO_HISTORICAL_UNDERFORECAST",
        "ERROR",
      ],
    },

    observationCount: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v >= 0,
        message: "observationCount must be finite and non-negative",
      },
    },

    underForecastCount: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v >= 0,
        message: "underForecastCount must be finite and non-negative",
      },
    },

    meanUnderforecast: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v >= 0,
        message: "meanUnderforecast must be finite and non-negative",
      },
    },

    mae: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v >= 0,
        message: "MAE must be finite and non-negative",
      },
    },

    rmse: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v >= 0,
        message: "RMSE must be finite and non-negative",
      },
    },

    lastEvaluatedPeriod: {
      type: String,
      default: null,
    },

    calculatedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "forecasterrorstats",
  }
);

// Unique index on materialNo
forecastErrorStatsSchema.index({ materialNo: 1 }, { unique: true });

module.exports = mongoose.model("ForecastErrorStats", forecastErrorStatsSchema);
