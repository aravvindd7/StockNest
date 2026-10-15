/**
 * Forecast generation — calls the ML service and stores ForecastPredictions.
 * Moved unchanged from controllers/forecastController.js so the manual
 * "Regenerate Forecast" action and the automatic pipeline
 * (services/derivedDataPipeline.js) share one implementation. The XGBoost
 * model, its features and the rolling-window rule are untouched.
 *
 * ROLLING WINDOW: the CURRENT QUARTER + NEXT 2 QUARTERS. The window starts at
 * the month AFTER the latest actual Sales month and ends at the last month of
 * (working quarter + 2); it may cross an FY boundary.
 *
 * Failure safety: predictions are upserted first and only then are rows
 * outside the new window removed — a failed ML call writes nothing, so the
 * last stored forecast stays in place.
 */
const ForecastPredictions = require("../models/ForecastPredictions");
const Sales = require("../models/Sales");
const mlServiceClient = require("./mlServiceClient");
const { currentFinancialYearStart, planForecastHorizonRange } = require("../utils/forecastTargets");
const { finYearLabel, ALL_MONTHS, finYearStartCalendarYear } = require("../utils/financialYear");

/** (financialYear, month) of the most recent actual Sales Master row (Indian-FY order). */
async function latestActualSalesMonth() {
  const distinct = await Sales.distinct("FinancialYear").then((fys) =>
    fys.map((fy) => ({ fy, fyIdx: finYearStartCalendarYear(fy) || 0 }))
  );
  if (!distinct.length) return null;
  const startYear = Math.min(...distinct.map((d) => d.fyIdx));
  const endYear = Math.max(...distinct.map((d) => d.fyIdx));
  for (let year = endYear; year >= 0 && year >= startYear; year--) {
    for (let i = ALL_MONTHS.length - 1; i >= 0; i--) {
      const fyLabel = finYearLabel(year);
      const month = ALL_MONTHS[i];
      const exists = await Sales.exists({ FinancialYear: fyLabel, Month: month });
      if (exists) return { financialYear: fyLabel, month, monthIdx: i };
    }
  }
  return null;
}

/**
 * The rolling forecast window for "now". `key` identifies it (data anchor +
 * clock-derived horizon), so a forecast generated for an older window is
 * recognisably stale. Null when Sales Master is empty.
 */
async function currentForecastWindow(now = new Date()) {
  const latestActual = await latestActualSalesMonth();
  if (!latestActual) return null;
  const range = planForecastHorizonRange(now, latestActual.financialYear, latestActual.month);
  return { latestActual, range, key: `${latestActual.financialYear}|${latestActual.month}|${range.startFy}|${range.startMonth}|${range.horizonMonths}` };
}

/**
 * Generates and stores the forecast for the current window.
 * @param {{ now?: Date, window?: object, stamp?: { forecastVersion?: number, sourceSalesVersion?: number } }} opts
 *   stamp — traceability written onto every stored prediction.
 */
async function generateAndStoreForecast({ now = new Date(), window, stamp = {} } = {}) {
  const win = window || (await currentForecastWindow(now));
  if (!win) {
    const err = new Error("No Sales Master data — cannot derive a forecast window.");
    err.status = 422;
    throw err;
  }
  const { latestActual, range } = win;
  const horizonMonths = range.horizonMonths;
  const result = await mlServiceClient.requestForecast({ horizonMonths });
  if (!Array.isArray(result?.forecasts) || result.forecasts.length === 0) {
    throw new Error("The ML service returned no forecasts — the stored forecast was kept.");
  }

  const generatedAt = new Date();
  const traceability = {};
  if (Number.isInteger(stamp.forecastVersion)) traceability.forecastVersion = stamp.forecastVersion;
  if (Number.isInteger(stamp.sourceSalesVersion)) traceability.sourceSalesVersion = stamp.sourceSalesVersion;
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
          ...traceability,
        },
      },
      upsert: true,
    },
  }));
  await ForecastPredictions.bulkWrite(ops);

  // Remove predictions outside the active rolling window (months that became
  // actual, leftovers beyond the horizon). Within-window rows were overwritten above.
  const windowMonths = [...new Set(result.forecasts.map((f) => `${f.financialYear}|${f.month}`))];
  const stale = await ForecastPredictions.deleteMany({
    $nor: windowMonths.map((pair) => {
      const [fy, month] = pair.split("|");
      return { financialYear: fy, month };
    }),
  });

  const modelUsage = result.forecasts.reduce((acc, f) => {
    acc[f.model] = (acc[f.model] || 0) + 1;
    return acc;
  }, {});
  const first = result.forecasts.find((f) => f.monthsAheadInHorizon === 1);
  const last = result.forecasts.reduce((a, b) => (b.monthsAheadInHorizon > a.monthsAheadInHorizon ? b : a), result.forecasts[0]);
  return {
    dataSource: result.dataSource,
    modelVersion: result.modelVersion,
    horizonMonths,
    latestActual,
    range,
    first,
    last,
    currentFY: finYearLabel(currentFinancialYearStart(now)),
    predictionsStored: ops.length,
    stalePredictionsRemoved: stale.deletedCount,
    modelUsage,
    generatedAt,
  };
}

module.exports = { latestActualSalesMonth, currentForecastWindow, generateAndStoreForecast };
