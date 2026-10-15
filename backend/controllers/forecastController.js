const ForecastPredictions = require("../models/ForecastPredictions");
const mlServiceClient = require("../services/mlServiceClient");
const derivedDataPipeline = require("../services/derivedDataPipeline");
const { finYearStartCalendarYear, calendarYearOfMonth } = require("../utils/financialYear");

/**
 * "September" + FY "2026-27" → "September 2026" — a month rendered with its
 * CALENDAR year (Apr–Dec in the FY start year, Jan–Mar in the next). Used
 * for range labels so a window reads "September 2026 → March 2027", never
 * the ambiguous "September 2026-27 → March 2026-27".
 */
function monthYearLabel(fyLabel, month) {
  return `${month} ${calendarYearOfMonth(month, finYearStartCalendarYear(fyLabel))}`;
}

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
 * POST /api/forecast/generate — Admin only. "Regenerate Forecast": a forced,
 * manual regeneration. Normally the forecast regenerates automatically when
 * Sales Master changes (services/derivedDataPipeline.js); this remains as a
 * recovery action. It runs through the same pipeline (never alongside an
 * automatic run), and recommendations are brought up to date afterwards.
 *
 * ROLLING WINDOW: the current quarter + next 2 quarters, from the month after
 * the latest actual Sales month (services/forecastGenerationService.js).
 */
async function generateForecast(req, res) {
  try {
    const r = await derivedDataPipeline.regenerateForecast({ actor: req.user?.username });
    const { first, last, latestActual, range, horizonMonths } = r;
    res.json({
      message: `Generated and stored ${r.predictionsStored} forecast predictions — covering the current quarter + next 2 quarters (${horizonMonths} months from the latest actual Sales month).`,
      dataSource: r.dataSource,
      modelVersion: r.modelVersion,
      horizonMonths,
      forecastRange: first && last ? `${monthYearLabel(first.financialYear, first.month)} → ${monthYearLabel(last.financialYear, last.month)}` : null,
      anchorMonth: monthYearLabel(latestActual.financialYear, latestActual.month),
      horizonWindow: `${monthYearLabel(range.startFy, range.startMonth)} → ${monthYearLabel(range.endFy, range.endMonth)}`,
      currentFY: r.currentFY,
      predictionsStored: r.predictionsStored,
      stalePredictionsRemoved: r.stalePredictionsRemoved,
      modelUsage: r.modelUsage,
      generatedAt: r.generatedAt,
    });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ message: err.message });
    console.error("[forecastController.generateForecast]", err);
    res.status(503).json({ message: "Could not reach the ML service to generate forecasts.", detail: err.message });
  }
}

module.exports = { getStatus, runBacktest, generateForecast };
