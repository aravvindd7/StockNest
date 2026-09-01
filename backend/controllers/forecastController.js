const ForecastPredictions = require("../models/ForecastPredictions");
const mlServiceClient = require("../services/mlServiceClient");

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
 * Calls the ML service, then upserts every Material+Plant+Month
 * prediction into ForecastPredictions — one document per period, so
 * re-generating overwrites the prior prediction for that exact period
 * rather than accumulating duplicates (see the model's unique index).
 */
async function generateForecast(req, res) {
  try {
    const horizonMonths = Number(req.body?.horizonMonths) || 12;
    const result = await mlServiceClient.requestForecast(horizonMonths);

    const generatedAt = new Date();
    const ops = result.forecasts.map((f) => ({
      updateOne: {
        filter: { materialNo: f.materialNo, plant: f.plant, financialYear: f.financialYear, month: f.month },
        update: {
          $set: {
            materialNo: f.materialNo, plant: f.plant, financialYear: f.financialYear,
            month: f.month, quarter: f.quarter, predictedSalesQty: f.predictedSalesQty,
            model: f.model, modelVersion: f.modelVersion, generatedAt,
            monthsAheadInHorizon: f.monthsAheadInHorizon,
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

    const modelCounts = result.forecasts.reduce((acc, f) => {
      acc[f.model] = (acc[f.model] || 0) + 1;
      return acc;
    }, {});

    res.json({
      message: `Generated and stored ${ops.length} forecast predictions.`,
      dataSource: result.dataSource,
      modelVersion: result.modelVersion,
      horizonMonths: result.horizonMonths,
      predictionsStored: ops.length,
      modelUsage: modelCounts,
      generatedAt,
    });
  } catch (err) {
    console.error("[forecastController.generateForecast]", err);
    res.status(503).json({ message: "Could not reach the ML service to generate forecasts.", detail: err.message });
  }
}

module.exports = { getStatus, runBacktest, generateForecast };
