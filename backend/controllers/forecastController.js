const ForecastPredictions = require("../models/ForecastPredictions");
const mlServiceClient = require("../services/mlServiceClient");
const { currentFinancialYearStart, forecastStartYear } = require("../utils/forecastTargets");
const { finYearLabel } = require("../utils/financialYear");

/**
 * GET /api/forecast/status — Admin only. Whether the ML service is
 * reachable right now, plus when forecasts were last generated. Planning
 * Master's WMA fallback does not depend on this endpoint at all — this is
 * purely informational, for an admin checking whether the ML path is live.
 */
async function getStatus(req, res) {
  try {
    const health = await mlServiceClient.checkHealth();
    const latest = await ForecastPredictions.findOne({}).sort({ generatedAt: -1 }).select("generatedAt model modelVersion");
    res.json({
      mlServiceReachable: true,
      mlService: health,
      lastGeneratedAt: latest?.generatedAt || null,
      lastModel: latest?.model || null,
      lastModelVersion: latest?.modelVersion || null,
    });
  } catch (err) {
    res.json({ mlServiceReachable: false, error: err.message, lastGeneratedAt: null });
  }
}

/**
 * POST /api/forecast/backtest — Admin only. Runs the WMA vs XGBoost
 * chronological backtest and returns the comparison report directly —
 * does not persist anything (Section 9's evaluation step, kept separate
 * from Section 10's persistence step, per Section 18's explicit
 * training/backtesting vs. inference separation).
 */
async function runBacktest(req, res) {
  try {
    const result = await mlServiceClient.requestBacktest();
    res.json(result);
  } catch (err) {
    console.error("[forecastController.runBacktest]", err);
    res.status(503).json({ message: "Could not reach the ML service to run the backtest.", detail: err.message });
  }
}

/**
 * POST /api/forecast/generate — Admin only. Manually triggered (Section
 * 18: "Do not retrain the model every time Planning Master is opened" —
 * this is the explicit trigger that stands in for a future scheduler).
 *
 * Phase B: generates the next 6 months of forecasts (H1-H6) anchored at
 * the FY following the current FY, derived from the server clock. Client
 * body params are accepted but ignored — the window is always computed
 * server-side for correctness.
 *
 * Calls the ML service, then upserts every Material+Plant+Month
 * prediction into ForecastPredictions — one document per period, so
 * re-generating overwrites the prior prediction for that exact period
 * rather than accumulating duplicates (see the model's unique index).
 *
 * Phase B cleanup: stale production forecasts from the previous 36-month
 * window (horizons 7-36) are deleted after the new 6-month generation, so
 * the collection never holds out-of-window/orphaned quarters that Planning
 * Master would otherwise render.
 */
async function generateForecast(req, res) {
  try {
    const now = new Date();
    const currentFy = currentFinancialYearStart(now);
    const startYear = forecastStartYear(currentFy); // FY start year of first forecast month
    const startFinancialYear = finYearLabel(startYear); // e.g. "2027-28"
    const horizonMonths = 6; // Phase B: production horizon reduced from 36 to 6

    const result = await mlServiceClient.requestForecast({ horizonMonths, startFinancialYear });

    const generatedAt = new Date();
    const ops = result.forecasts.map((f) => ({
      updateOne: {
        filter: { materialNo: f.materialNo, plant: f.plant, financialYear: f.financialYear, month: f.month },
        update: {
          $set: {
            materialNo: f.materialNo, plant: f.plant, financialYear: f.financialYear,
            month: f.month, quarter: f.quarter, predictedSalesQty: f.predictedSalesQty,
            model: f.model, modelVersion: f.modelVersion, generatedAt,
            monthsAheadInHorizon: f.monthsAheadInHorizon, horizonMonths: result.horizonMonths || horizonMonths,
            confidence: f.confidence, confidenceTier: f.confidenceTier,
            segmentWmape: f.segmentWmape, horizonAdjustedWmape: f.horizonAdjustedWmape, historyMonths: f.historyMonths,
            trend: f.trend, seasonality: f.seasonality, seasonalityPeakQuarter: f.seasonalityPeakQuarter,
            reason: f.reason,
          },
        },
        upsert: true,
      },
    }));

    if (ops.length > 0) await ForecastPredictions.bulkWrite(ops);

    // Phase B: remove stale H7-H36 production forecasts left over from the
    // previous 36-month generation. The 6-month window only produces
    // horizons 1-6; anything beyond that is no longer generated and must not
    // remain (Planning Master would otherwise show orphaned out-of-window
    // quarters). Rows within the window are untouched — upsert overwrites them.
    const stale = await ForecastPredictions.deleteMany({
      monthsAheadInHorizon: { $gt: horizonMonths },
    });

    const modelCounts = result.forecasts.reduce((acc, f) => {
      acc[f.model] = (acc[f.model] || 0) + 1;
      return acc;
    }, {});

    res.json({
      message: `Generated and stored ${ops.length} forecast predictions (${horizonMonths}-month horizon anchored at ${startFinancialYear}).`,
      dataSource: result.dataSource,
      modelVersion: result.modelVersion,
      horizonMonths,
      startFinancialYear,
      currentFY: finYearLabel(currentFy),
      predictionsStored: ops.length,
      stalePredictionsRemoved: stale.deletedCount,
      modelUsage: modelCounts,
      generatedAt,
    });
  } catch (err) {
    console.error("[forecastController.generateForecast]", err);
    res.status(503).json({ message: "Could not reach the ML service to generate forecasts.", detail: err.message });
  }
}

module.exports = { getStatus, runBacktest, generateForecast };
