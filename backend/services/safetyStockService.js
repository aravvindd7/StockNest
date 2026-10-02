/**
 * Stage 3: Safety Stock Service
 *
 * Calculates forecast-error-based Safety Stock statistics from historical
 * backtest predictions. Aggregates Material+Plant backtest rows to material
 * level, computes the 90th percentile of positive underforecast errors, and
 * persists ForecastErrorStats documents.
 *
 * This service does NOT modify ForecastPredictions or Planning Master logic.
 * It is a standalone statistics calculation layer.
 */
const ForecastErrorStats = require("../models/ForecastErrorStats");
const { requestBacktestRows } = require("./mlServiceClient");
const { percentile } = require("../utils/statistics");

// Configuration
const MIN_BACKTEST_OBSERVATIONS = 6;
const UNDERFORECAST_PERCENTILE = 0.90;

/**
 * Normalize material number to uppercase trimmed form.
 */
function normalizeMaterialNo(matNo) {
  return String(matNo || "").trim().toUpperCase();
}

/**
 * Calculate error statistics from backtest observations.
 *
 * @param {Array} observations - Array of {actual, xgb_pred} objects
 * @returns {Object} - { errors, absoluteErrors, squaredErrors, underforecasts }
 */
function calculateErrors(observations) {
  const errors = [];
  const absoluteErrors = [];
  const squaredErrors = [];
  const underforecasts = [];

  for (const obs of observations) {
    const { actual, xgb_pred } = obs;

    // Validate numeric values
    if (!Number.isFinite(actual) || !Number.isFinite(xgb_pred)) {
      continue; // Skip invalid observations
    }

    const signedError = actual - xgb_pred;

    errors.push(signedError);
    absoluteErrors.push(Math.abs(signedError));
    squaredErrors.push(signedError * signedError);

    // Underforecast: actual > prediction (positive error only)
    if (signedError > 0) {
      underforecasts.push(signedError);
    }
  }

  return { errors, absoluteErrors, squaredErrors, underforecasts };
}

/**
 * Calculate MAE (Mean Absolute Error).
 */
function calculateMAE(absoluteErrors) {
  if (absoluteErrors.length === 0) return 0;
  const sum = absoluteErrors.reduce((acc, val) => acc + val, 0);
  return sum / absoluteErrors.length;
}

/**
 * Calculate RMSE (Root Mean Squared Error).
 */
function calculateRMSE(squaredErrors) {
  if (squaredErrors.length === 0) return 0;
  const sum = squaredErrors.reduce((acc, val) => acc + val, 0);
  return Math.sqrt(sum / squaredErrors.length);
}

/**
 * Calculate mean of underforecasts.
 */
function calculateMeanUnderforecast(underforecasts) {
  if (underforecasts.length === 0) return 0;
  const sum = underforecasts.reduce((acc, val) => acc + val, 0);
  return sum / underforecasts.length;
}

/**
 * Calculate forecast-error-based Safety Stock for a single material.
 *
 * @param {string} materialNo - Material number
 * @param {Array} observations - Array of backtest rows for this material
 * @returns {Object} - ForecastErrorStats document data
 */
function calculateSafetyStockForMaterial(materialNo, observations) {
  const observationCount = observations.length;

  // Calculate error statistics
  const { absoluteErrors, squaredErrors, underforecasts } = calculateErrors(observations);

  const mae = calculateMAE(absoluteErrors);
  const rmse = calculateRMSE(squaredErrors);
  const underForecastCount = underforecasts.length;
  const meanUnderforecast = calculateMeanUnderforecast(underforecasts);

  // Insufficient history check
  if (observationCount < MIN_BACKTEST_OBSERVATIONS) {
    return {
      materialNo,
      safetyStock: 0,
      percentile: UNDERFORECAST_PERCENTILE,
      status: "INSUFFICIENT_HISTORY",
      observationCount,
      underForecastCount,
      meanUnderforecast,
      mae,
      rmse,
      lastEvaluatedPeriod: null,
      calculatedAt: new Date(),
    };
  }

  // Find last evaluated period (most recent FY|Month from observations)
  let lastEvaluatedPeriod = null;
  if (observations.length > 0) {
    // Sort by month_index descending to find the latest
    const sorted = [...observations].sort((a, b) => b.month_index - a.month_index);
    const latest = sorted[0];
    lastEvaluatedPeriod = `${latest.FinancialYear}|${latest.Month}`;
  }

  // No underforecasts case
  if (underForecastCount === 0) {
    return {
      materialNo,
      safetyStock: 0,
      percentile: UNDERFORECAST_PERCENTILE,
      status: "NO_HISTORICAL_UNDERFORECAST",
      observationCount,
      underForecastCount,
      meanUnderforecast,
      mae,
      rmse,
      lastEvaluatedPeriod,
      calculatedAt: new Date(),
    };
  }

  // Calculate Safety Stock from 90th percentile of underforecasts
  let safetyStock = 0;
  let status = "FORECAST_ERROR_BASED";

  try {
    const p90 = percentile(underforecasts, UNDERFORECAST_PERCENTILE);

    // Round to nearest integer, clamp to >= 0
    safetyStock = Math.max(0, Math.round(p90));

    // Final validation
    if (!Number.isFinite(safetyStock) || !Number.isInteger(safetyStock)) {
      status = "ERROR";
      safetyStock = 0;
    }
  } catch (error) {
    status = "ERROR";
    safetyStock = 0;
  }

  return {
    materialNo,
    safetyStock,
    percentile: UNDERFORECAST_PERCENTILE,
    status,
    observationCount,
    underForecastCount,
    meanUnderforecast,
    mae,
    rmse,
    lastEvaluatedPeriod,
    calculatedAt: new Date(),
  };
}

/**
 * Refresh ForecastErrorStats for all materials from the ML backtest.
 *
 * Requests row-level backtest predictions, aggregates by material (across
 * plants), calculates Safety Stock, and upserts ForecastErrorStats documents.
 *
 * @returns {Promise<Object>} - Summary of processed materials
 */
async function refreshForecastErrorStats() {
  // Request row-level backtest predictions from ML service
  let backtestData;
  try {
    backtestData = await requestBacktestRows();
  } catch (error) {
    throw new Error(`Failed to fetch backtest rows from ML service: ${error.message}`);
  }

  if (!backtestData || !backtestData.rows || !Array.isArray(backtestData.rows)) {
    throw new Error("Invalid backtest response: missing or invalid rows array");
  }

  const rows = backtestData.rows;

  // Group observations by material (aggregate across plants)
  const materialObservations = new Map();

  for (const row of rows) {
    const matNo = normalizeMaterialNo(row.MatNo);

    if (!matNo) {
      continue; // Skip rows with missing material numbers
    }

    // Validate required fields
    if (!Number.isFinite(row.actual) || !Number.isFinite(row.xgb_pred)) {
      continue; // Skip rows with invalid predictions
    }

    // Create observation key for deduplication: MatNo|Plant|FY|Month
    const obsKey = `${matNo}|${row.Plant}|${row.FinancialYear}|${row.Month}`;

    if (!materialObservations.has(matNo)) {
      materialObservations.set(matNo, new Map());
    }

    // Store observation (deduplicates by key)
    materialObservations.get(matNo).set(obsKey, {
      actual: row.actual,
      xgb_pred: row.xgb_pred,
      month_index: row.month_index,
      FinancialYear: row.FinancialYear,
      Month: row.Month,
      Plant: row.Plant,
    });
  }

  // Calculate Safety Stock for each material
  const summary = {
    processedMaterials: 0,
    forecastErrorBased: 0,
    insufficientHistory: 0,
    noHistoricalUnderforecast: 0,
    errors: 0,
  };

  const upsertPromises = [];

  for (const [matNo, obsMap] of materialObservations.entries()) {
    const observations = Array.from(obsMap.values());

    const stats = calculateSafetyStockForMaterial(matNo, observations);

    // Upsert ForecastErrorStats document
    const upsertPromise = ForecastErrorStats.findOneAndUpdate(
      { materialNo: stats.materialNo },
      stats,
      { upsert: true, new: true, runValidators: true }
    ).then(() => {
      summary.processedMaterials++;

      // Track status distribution
      if (stats.status === "FORECAST_ERROR_BASED") {
        summary.forecastErrorBased++;
      } else if (stats.status === "INSUFFICIENT_HISTORY") {
        summary.insufficientHistory++;
      } else if (stats.status === "NO_HISTORICAL_UNDERFORECAST") {
        summary.noHistoricalUnderforecast++;
      } else if (stats.status === "ERROR") {
        summary.errors++;
      }
    }).catch((error) => {
      // Log individual material errors but continue processing others
      console.error(`Failed to upsert ForecastErrorStats for ${matNo}:`, error.message);
      summary.errors++;
    });

    upsertPromises.push(upsertPromise);
  }

  // Wait for all upserts to complete
  await Promise.all(upsertPromises);

  return summary;
}

/**
 * Get Safety Stock for a specific material.
 *
 * @param {string} materialNo - Material number
 * @returns {Promise<number>} - Safety Stock quantity (0 if not found)
 */
async function getSafetyStock(materialNo) {
  const normalized = normalizeMaterialNo(materialNo);
  const stats = await ForecastErrorStats.findOne({ materialNo: normalized });
  return stats ? stats.safetyStock : 0;
}

/**
 * Get ForecastErrorStats for a specific material.
 *
 * @param {string} materialNo - Material number
 * @returns {Promise<Object|null>} - ForecastErrorStats document or null
 */
async function getForecastErrorStats(materialNo) {
  const normalized = normalizeMaterialNo(materialNo);
  return ForecastErrorStats.findOne({ materialNo: normalized });
}

module.exports = {
  refreshForecastErrorStats,
  getSafetyStock,
  getForecastErrorStats,
  calculateSafetyStockForMaterial, // Exported for testing
  calculateErrors, // Exported for testing
  MIN_BACKTEST_OBSERVATIONS,
  UNDERFORECAST_PERCENTILE,
};
