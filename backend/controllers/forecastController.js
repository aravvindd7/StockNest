const ForecastPredictions = require("../models/ForecastPredictions");
const mlServiceClient = require("../services/mlServiceClient");
const { currentFinancialYearStart } = require("../utils/forecastTargets");
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
 * ROLLING WINDOW: generates the NEXT 6 months starting from the first
 * month after the latest available actual Sales month (e.g. latest actual
 * September 2026 → forecasts October 2026 … March 2027). The window is
 * anchored to the DATA, not to a financial year — no FY anchor is passed
 * to the ML service, which begins at the month after its last real data
 * month and emits exactly `horizonMonths` consecutive months. The window
 * rolls forward with time and may cross an FY boundary naturally; Planning
 * Master maps each forecast month to its own FY.
 *
 * Calls the ML service, then upserts every Material+Plant+Month prediction
 * into ForecastPredictions — one document per period, so re-generating
 * overwrites the prior prediction for that exact period rather than
 * accumulating duplicates (see the model's unique index).
 *
 * Stale cleanup: after upserting the new window, any stored prediction
 * OUTSIDE the active 6-month rolling window is deleted — a month that has
 * since become actual (previously forecast month 1), and any leftover rows
 * beyond the horizon, must not linger. Rows within the window are untouched
 * (upsert overwrites them, keeping regeneration idempotent).
 */
async function generateForecast(req, res) {
  try {
    const now = new Date();
    const currentFy = currentFinancialYearStart(now);
    const horizonMonths = 6; // Phase B: production horizon reduced from 36 to 6

    // No FY anchor is passed: the ML service anchors at the first month
    // after the latest actual Sales month and emits exactly horizonMonths
    // consecutive months (crossing an FY boundary naturally).
    const result = await mlServiceClient.requestForecast({ horizonMonths });

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

    // Stale cleanup: remove any stored prediction outside the active rolling
    // window. The window is the set of (financialYear, month) pairs just
    // generated; anything else — a month that has since become actual, or a
    // leftover row beyond the horizon — is no longer a forecast and is
    // deleted. Within-window rows are preserved and overwritten by the
    // upserts above (idempotent regeneration, unique key intact).
    const windowMonths = [...new Set(result.forecasts.map((f) => `${f.financialYear}|${f.month}`))];
    const stale = windowMonths.length
      ? await ForecastPredictions.deleteMany({
          $nor: windowMonths.map((pair) => {
            const [fy, month] = pair.split("|");
            return { financialYear: fy, month };
          }),
        })
      : { deletedCount: 0 };

    const modelCounts = result.forecasts.reduce((acc, f) => {
      acc[f.model] = (acc[f.model] || 0) + 1;
      return acc;
    }, {});

    const first = result.forecasts.find((f) => f.monthsAheadInHorizon === 1);
    const last = result.forecasts.reduce((a, b) => (b.monthsAheadInHorizon > a.monthsAheadInHorizon ? b : a), result.forecasts[0]);

    res.json({
      message: `Generated and stored ${ops.length} forecast predictions — the next ${horizonMonths} months from the latest actual Sales month.`,
      dataSource: result.dataSource,
      modelVersion: result.modelVersion,
      horizonMonths,
      forecastRange: first && last ? `${first.month} ${first.financialYear} → ${last.month} ${last.financialYear}` : null,
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
