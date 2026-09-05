/**
 * Planning Engine — all forecasting/aggregation logic lives here, not in
 * the controller or the frontend. The React table only ever renders what
 * this service returns; if the forecasting algorithm changes later, this
 * is the only file that should need to change.
 *
 * Planning Master owns no data of its own — everything here is computed
 * fresh from Material Master (materialNo, description, safety stock basis),
 * Stock Master (current stock), and Sales Master (historical sales, the
 * foundation for every forecast).
 *
 * Rolling multi-year upgrade: the FY dropdown is now a pure view/filter
 * control. Selecting a year shows that year's Q1-Q4 + Total. Current/
 * historical FYs show actuals; future FYs show forecast data with a
 * "Forecasted Data — XGBoost" badge. The rolling 36-month forecast
 * window is always derived server-side (see utils/forecastTargets.js).
 */
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const Sales = require("../models/Sales");
const ForecastPredictions = require("../models/ForecastPredictions");
const { computeSafetyStock } = require("../utils/safetyStock");
const { buildInventoryDecision } = require("../utils/inventoryDecision");
const { MONTHS_BY_QUARTER, finYearLabel, finYearStartCalendarYear } = require("../utils/financialYear");
const { currentFinancialYearStart, buildYearOptions } = require("../utils/forecastTargets");

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------
// Forecast Hierarchy: Historical Sales -> Monthly Forecast -> Quarter
// Forecast -> Year Forecast. Quarter/Year are what the table displays;
// Monthly is computed and retained on every forecast quarter (returned in
// the API payload) specifically so a future Distribution Master can
// consume it directly without this module needing to change.
// ---------------------------------------------------------------------

/**
 * Weighted moving average across a material's full sales history for one
 * specific quarter position (e.g. every Q2 the material has ever had),
 * weighted toward more recent years — this is the seasonal baseline.
 */
function weightedSeasonalAverage(valuesChronological) {
  if (valuesChronological.length === 0) return 0;
  const weights = valuesChronological.map((_, i) => i + 1); // oldest=1 ... newest=N
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const weighted = valuesChronological.reduce((sum, v, i) => sum + v * weights[i], 0);
  return weighted / weightSum;
}

/**
 * Average year-over-year growth rate across a material's full yearly
 * sales totals, clamped to a sane range so a single volatile year can't
 * produce an unreasonable extrapolation.
 */
function computeTrendGrowthRate(yearlyTotalsChronological) {
  const growthRates = [];
  for (let i = 1; i < yearlyTotalsChronological.length; i += 1) {
    const prev = yearlyTotalsChronological[i - 1];
    const curr = yearlyTotalsChronological[i];
    if (prev > 0) growthRates.push((curr - prev) / prev);
  }
  if (growthRates.length === 0) return 0;
  const avg = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
  return Math.max(-0.3, Math.min(0.5, avg)); // clamp to [-30%, +50%]
}

/** Confidence is higher when a quarter's historical values are consistent (low variance) year to year. */
function computeConfidence(valuesChronological) {
  const nonZero = valuesChronological.filter((v) => v > 0);
  if (nonZero.length < 2) return 60; // not enough history to be confident
  const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  const variance = nonZero.reduce((sum, v) => sum + (v - mean) ** 2, 0) / nonZero.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? stdDev / mean : 1;
  const confidence = Math.round(100 - coefficientOfVariation * 100);
  return Math.max(55, Math.min(97, confidence));
}

/** Splits a quarter's forecast total into 3 months with a mild within-quarter growth pattern, summing exactly to the quarter total. */
function buildMonthlyBreakdown(quarter, quarterTotal) {
  const months = MONTHS_BY_QUARTER[quarter];
  const m1 = Math.round(quarterTotal * 0.3);
  const m2 = Math.round(quarterTotal * 0.33);
  const m3 = quarterTotal - m1 - m2; // remainder, so the three always sum exactly
  return [
    { month: months[0], qty: m1 },
    { month: months[1], qty: m2 },
    { month: months[2], qty: m3 },
  ];
}

/**
 * Builds the full forecast block for one material using the WMA fallback
 * (when no ML predictions are available for a forecast year).
 */
function buildForecast(materialSalesHistory, forecastYear) {
  const historyYears = Object.keys(materialSalesHistory).map(Number).sort((a, b) => a - b);
  const yearlyTotals = historyYears.map(
    (y) => QUARTERS.reduce((sum, q) => sum + (materialSalesHistory[y]?.[q] || 0), 0)
  );
  const growthRate = computeTrendGrowthRate(yearlyTotals);
  const growthPct = Math.round(growthRate * 100);

  const quarters = {};
  let total = 0;

  QUARTERS.forEach((q) => {
    const historicalForThisQuarter = historyYears.map((y) => materialSalesHistory[y]?.[q] || 0);
    const baseline = weightedSeasonalAverage(historicalForThisQuarter);
    const qty = Math.max(0, Math.round(baseline * (1 + growthRate)));
    const confidence = computeConfidence(historicalForThisQuarter);

    quarters[q] = {
      qty,
      confidence,
      growthPct,
      monthly: buildMonthlyBreakdown(q, qty),
      reason:
        historicalForThisQuarter.some((v) => v > 0)
          ? `Forecast generated using ${historyYears.length} year(s) of historical sales trends and seasonal demand patterns for ${q}, reflecting a ${growthRate >= 0 ? "growing" : "declining"} year-over-year trend of ${Math.abs(growthPct)}%.`
          : "No historical sales found for this material — forecast defaults to zero until sales history is available.",
    };
    total += qty;
  });

  const avgConfidence = Math.round(QUARTERS.reduce((sum, q) => sum + quarters[q].confidence, 0) / 4);

  return { year: finYearLabel(forecastYear), quarters, total, avgConfidence, growthPct, source: "WMA" };
}

/**
 * PHASE 4: builds the identical forecast shape buildForecast() returns,
 * but sourced from persisted XGBoost/WMA_FALLBACK predictions
 * (ForecastPredictions) instead of computing them here.
 *
 * mlPredictionsForMaterial: ForecastPredictions docs for one materialNo,
 *   already filtered to the target financialYear (may span multiple
 *   plants — this function sums across all of them, same aggregation
 *   principle Sales Master's own Plant->Material rollup already uses).
 * materialSalesHistory / forecastYear: same inputs buildForecast takes —
 *   still used as a graceful-degradation fallback.
 */
function buildForecastFromML(mlPredictionsForMaterial, materialSalesHistory, forecastYear) {
  const historyYears = Object.keys(materialSalesHistory).map(Number).sort((a, b) => a - b);
  const yearlyTotals = historyYears.map(
    (y) => QUARTERS.reduce((sum, q) => sum + (materialSalesHistory[y]?.[q] || 0), 0)
  );
  const latestHistoricalTotal = yearlyTotals[yearlyTotals.length - 1] || 0;

  const quarters = {};
  let total = 0;
  let anyXgboost = false;

  QUARTERS.forEach((q) => {
    const monthsInQuarter = MONTHS_BY_QUARTER[q];
    const rowsForQuarter = mlPredictionsForMaterial.filter((p) => p.quarter === q);
    anyXgboost = anyXgboost || rowsForQuarter.some((p) => p.model === "XGBoost");

    const monthlyTotals = monthsInQuarter.map((month) => ({
      month,
      qty: Math.round(rowsForQuarter.filter((p) => p.month === month).reduce((s, p) => s + p.predictedSalesQty, 0)),
    }));
    const qty = monthlyTotals.reduce((s, m) => s + m.qty, 0);

    // Confidence/reason: sourced from the stored, evidence-based values
    // computed at forecast-generation time (ml-service/app/intelligence.py
    // — real backtest WMAPE, real trend/seasonality detection, never an
    // arbitrary percentage). Rows within the same quarter share the same
    // material-level trend/seasonality/segmentWmape but differ slightly in
    // confidence by month (horizon decay), so confidence is averaged
    // across the quarter's available rows.
    //
    // GRACEFUL DEGRADATION: if a row predates this phase (no `confidence`
    // stored) or the field is otherwise missing, fall back to the
    // original historical-variance calculation — Part 9's explicit
    // "a prediction is missing" case. This never throws and never shows a
    // blank confidence value.
    const rowsWithConfidence = rowsForQuarter.filter((p) => Number.isFinite(p.confidence));
    const historicalForThisQuarter = historyYears.map((y) => materialSalesHistory[y]?.[q] || 0);

    const confidence = rowsWithConfidence.length
      ? Math.round(rowsWithConfidence.reduce((s, p) => s + p.confidence, 0) / rowsWithConfidence.length)
      : computeConfidence(historicalForThisQuarter);
    const confidenceTier = rowsWithConfidence.length ? rowsWithConfidence[rowsWithConfidence.length - 1].confidenceTier : null;
    const segmentWmape = rowsWithConfidence.length ? rowsWithConfidence[0].segmentWmape : null;
    const horizonAdjustedRows = rowsForQuarter.filter((p) => Number.isFinite(p.horizonAdjustedWmape));
    const horizonAdjustedWmape = horizonAdjustedRows.length
      ? Math.round((horizonAdjustedRows.reduce((s, p) => s + p.horizonAdjustedWmape, 0) / horizonAdjustedRows.length) * 100) / 100
      : null;
    const historyMonths = rowsWithConfidence.length ? rowsWithConfidence[0].historyMonths : null;
    const trend = rowsWithConfidence.length ? rowsWithConfidence[0].trend : null;
    const seasonality = rowsWithConfidence.length ? rowsWithConfidence[0].seasonality : null;
    const seasonalityPeakQuarter = rowsWithConfidence.length ? rowsWithConfidence[0].seasonalityPeakQuarter : null;

    // Rolling upgrade: horizon denominator from stored horizonMonths on
    // any doc, falling back to max monthsAheadInHorizon across the
    // quarter's rows, then to 12 for backward compatibility.
    const horizonDenominator = rowsForQuarter.length
      ? (rowsForQuarter[0].horizonMonths
        || Math.max(...rowsForQuarter.map((p) => p.monthsAheadInHorizon || 0))
        || 12)
      : 12;
    const monthsAheadRange = rowsForQuarter.length
      ? [Math.min(...rowsForQuarter.map((p) => p.monthsAheadInHorizon || 0)), Math.max(...rowsForQuarter.map((p) => p.monthsAheadInHorizon || 0))]
      : null;

    const reason = rowsForQuarter.length
      ? rowsWithConfidence.length
        ? rowsWithConfidence[0].reason || "Forecast generated by the ML forecasting pipeline."
        : `Forecast generated by ${anyXgboost ? "the XGBoost forecasting model" : "the WMA fallback"} (model version ${rowsForQuarter[0].modelVersion}), trained on this material's monthly sales history across ${new Set(rowsForQuarter.map((p) => p.plant)).size} plant(s).`
      : "No stored ML prediction found for this quarter.";

    quarters[q] = {
      qty,
      confidence,
      confidenceTier,
      segmentWmape,
      horizonAdjustedWmape,
      historyMonths,
      trend,
      seasonality,
      seasonalityPeakQuarter,
      forecastHorizon: monthsAheadRange ? `Month ${monthsAheadRange[0]}-${monthsAheadRange[1]} / ${horizonDenominator}` : null,
      growthPct: latestHistoricalTotal > 0 ? Math.round(((qty - latestHistoricalTotal / 4) / (latestHistoricalTotal / 4)) * 100) : 0,
      monthly: monthlyTotals,
      reason,
    };
    total += qty;
  });

  const avgConfidence = Math.round(QUARTERS.reduce((sum, q) => sum + quarters[q].confidence, 0) / 4);
  const growthPct = latestHistoricalTotal > 0 ? Math.round(((total - latestHistoricalTotal) / latestHistoricalTotal) * 100) : 0;

  return {
    year: finYearLabel(forecastYear), quarters, total, avgConfidence, growthPct,
    source: anyXgboost ? "XGBoost" : "WMA_FALLBACK",
  };
}

function computeOverallTrend(historicalTotal, forecastTotal) {
  if (forecastTotal > historicalTotal) return "up";
  if (forecastTotal < historicalTotal) return "down";
  return "flat";
}

/**
 * A simple, transparent stock-risk label derived purely from numbers the
 * engine already computed — not part of the forecasting algorithm itself,
 * just a comparison applied after it.
 */
function computeStockRisk(currentStock, safetyStock) {
  if (currentStock < safetyStock) return "Low";
  return "Healthy";
}

/**
 * Post-filters the already-computed row data — this runs strictly AFTER
 * the forecasting engine, never touches it. filters: { trend?: string[],
 * stockRisk?: string[], growthPct?: {min,max}, confidence?: {min,max} }
 */
function matchesNumberFilter(actual, spec) {
  if (!spec) return true;
  const { op, value, min, max } = spec;
  if (op === "equals" && value !== undefined && value !== "") return actual === Number(value);
  if (op === "gt" && value !== undefined && value !== "") return actual > Number(value);
  if (op === "lt" && value !== undefined && value !== "") return actual < Number(value);
  if (min !== undefined && min !== "" && actual < Number(min)) return false;
  if (max !== undefined && max !== "" && actual > Number(max)) return false;
  return true;
}

function applyPlanningFilters(data, filters = {}) {
  return data.filter((row) => {
    if (filters.trend?.length && !filters.trend.includes(row.trend)) return false;
    if (filters.stockRisk?.length && !filters.stockRisk.includes(row.stockRisk)) return false;
    if (!matchesNumberFilter(row.growthPct, filters.growthPct)) return false;
    if (!matchesNumberFilter(row.confidence, filters.confidence)) return false;
    return true;
  });
}

/**
 * A forecast-year quarter block with nothing to show — used for a forecast
 * FY that lies beyond the generated horizon (e.g. FY 2028-29 when only a
 * 6-month window into 2027-28 has been generated). Deliberately EMPTY:
 * no WMA fabrication, no seasonal extrapolation, no invented numbers. The
 * frontend renders such a group as "No forecast data" instead of implying
 * a 36-month forecast exists.
 */
function emptyForecast(year) {
  const quarters = {};
  QUARTERS.forEach((q) => {
    quarters[q] = {
      qty: 0, confidence: null, confidenceTier: null, segmentWmape: null,
      horizonAdjustedWmape: null, historyMonths: null, trend: null, seasonality: null,
      seasonalityPeakQuarter: null, forecastHorizon: null, growthPct: null,
      monthly: MONTHS_BY_QUARTER[q].map((month) => ({ month, qty: 0 })),
      reason: null,
    };
  });
  return { year, quarters, total: 0, avgConfidence: null, growthPct: null, source: "NO_DATA" };
}

/**
 * GET /api/planning's full payload — the 3-slot FY comparison.
 *
 * Three INDEPENDENT, user-selectable FY column slots, passed as
 * `viewYears` (an array of FY start calendar years, comma-separated in the
 * query). Defaults to Previous | Current | Next-Forecast FY
 * (e.g. 2025-26 | 2026-27 | 2027-28). Any slot can be re-pointed at any
 * available financial year via that group's header filter — the window is
 * not fixed, only defaulted. The frontend can change any slot's FY without
 * touching the underlying forecast engine.
 *
 * Each row carries:
 *   - row-level attributes (safetyStock, currentStock, trend, stockRisk)
 *     that are FY-independent and drive the sticky columns + filters;
 *   - `years[fyStart]` per-FY blocks ({isForecastYear, quarters, total}
 *     for actuals, or {isForecastYear, forecast, total} for forecasts);
 *   - `growthPct`/`confidence`/`inventoryDecision` sourced from the
 *     forecast slot(s) — the nearest future forecast FY among the selected
 *     slots (the decision-relevant, in-horizon forecast) — null when no
 *     selected slot is a forecast year (NO_DATA).
 *
 * Actual-year quarters include a `monthly` array of real month-level
 * Sales actuals (Month 1/2/3) so the historical drill-down drawer has
 * genuine data — this is the one backend addition the drawer required.
 *
 * Filters (trend/stockRisk/growthPct/confidence) are applied once across
 * the row set AFTER all FY blocks are built, so the same materials appear
 * in every FY group (a consistent row set, not three independently
 * filtered lists).
 */
async function buildPlanningView({ search, trend, stockRisk, growthPct, confidence, viewYears } = {}) {
  const now = new Date();
  const currentFyStart = currentFinancialYearStart(now);

  // Three independent FY slots. Default: Previous | Current | Next-Forecast.
  let fyStarts = (Array.isArray(viewYears) ? viewYears : [])
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y));
  if (fyStarts.length === 0) {
    fyStarts = [currentFyStart - 1, currentFyStart, currentFyStart + 1];
  }
  fyStarts = fyStarts.slice(0, 3);
  const fyLabels = fyStarts.map(finYearLabel);

  const groupMeta = fyStarts.map((y, i) => ({
    index: i,
    viewYear: { value: y, label: finYearLabel(y), current: y === currentFyStart, forecast: y > currentFyStart },
    isForecastYear: y > currentFyStart,
  }));

  const materialQuery = { isActive: true };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    materialQuery.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
  }
  const materials = await Material.find(materialQuery).sort("materialNo").lean();

  // Stock: current totals per material. Sales: aggregated to Month level so
  // each actual quarter can carry both its total and a real monthly
  // breakdown for the drill-down drawer. ML predictions: loaded once for
  // all three FY labels in the window.
  const [stockRows, salesRows, mlPredictionRows] = await Promise.all([
    Stock.find({}).select("MatNo TotalStockQty").lean(),
    Sales.aggregate([
      { $group: { _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter", Month: "$Month" }, qty: { $sum: "$SalesQty" } } },
    ]),
    ForecastPredictions.find({ financialYear: { $in: fyLabels } }).lean(),
  ]);

  const stockByMat = {};
  stockRows.forEach((s) => {
    const key = String(s.MatNo || "").trim().toUpperCase();
    if (!key) return;
    stockByMat[key] = (stockByMat[key] || 0) + (Number(s.TotalStockQty) || 0);
  });

  // salesByMat: materialNo -> { year -> { Q1..Q4 total } }
  // monthlyByMat: materialNo -> { year -> { Q1..Q4 -> { Month: qty } } }
  const salesByMat = {};
  const monthlyByMat = {};
  salesRows.forEach((s) => {
    const key = String(s._id.MatNo || "").trim().toUpperCase();
    const year = finYearStartCalendarYear(s._id.FinancialYear);
    const quarter = s._id.Quarter;
    const month = s._id.Month;
    if (!key || year === null || !QUARTERS.includes(quarter) || !month) return;
    const qty = Number(s.qty) || 0;
    if (!salesByMat[key]) salesByMat[key] = {};
    if (!salesByMat[key][year]) salesByMat[key][year] = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    salesByMat[key][year][quarter] += qty;
    if (!monthlyByMat[key]) monthlyByMat[key] = {};
    if (!monthlyByMat[key][year]) monthlyByMat[key][year] = {};
    if (!monthlyByMat[key][year][quarter]) monthlyByMat[key][year][quarter] = {};
    monthlyByMat[key][year][quarter][month] = (monthlyByMat[key][year][quarter][month] || 0) + qty;
  });

  // ML predictions grouped by materialNo then financialYear label.
  const mlByMaterialAndYear = {};
  mlPredictionRows.forEach((p) => {
    if (!mlByMaterialAndYear[p.materialNo]) mlByMaterialAndYear[p.materialNo] = {};
    if (!mlByMaterialAndYear[p.materialNo][p.financialYear]) mlByMaterialAndYear[p.materialNo][p.financialYear] = [];
    mlByMaterialAndYear[p.materialNo][p.financialYear].push(p);
  });

  const data = materials.map((m) => {
    const key = m.materialNo;
    const currentStock = stockByMat[key] || 0;
    const materialSalesHistory = salesByMat[key] || {};
    const materialMonthly = monthlyByMat[key] || {};

    // Safety stock: computed from ALL quarterly history — FY-independent.
    const allQuarterValues = [];
    Object.values(materialSalesHistory).forEach((yearData) => {
      QUARTERS.forEach((q) => allQuarterValues.push(yearData[q] || 0));
    });
    const safetyStock = computeSafetyStock(allQuarterValues);

    // Row-level trend from the CURRENT FY's actuals vs the prior FY.
    const currentYearTotal = QUARTERS.reduce((s, q) => s + (materialSalesHistory[currentFyStart]?.[q] || 0), 0);
    const priorYearTotal = QUARTERS.reduce((s, q) => s + (materialSalesHistory[currentFyStart - 1]?.[q] || 0), 0);
    const trend = computeOverallTrend(priorYearTotal, currentYearTotal);
    const stockRisk = computeStockRisk(currentStock, safetyStock);

    // Per-FY blocks keyed by FY start year.
    const years = {};
    fyStarts.forEach((fyStart) => {
      const isForecastYear = fyStart > currentFyStart;
      if (!isForecastYear) {
        const yearData = materialSalesHistory[fyStart] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
        const monthData = materialMonthly[fyStart] || {};
        const quarters = {};
        QUARTERS.forEach((q) => {
          const m = monthData[q] || {};
          quarters[q] = {
            qty: yearData[q],
            monthly: MONTHS_BY_QUARTER[q].map((month) => ({ month, qty: m[month] || 0 })),
          };
        });
        years[fyStart] = { isForecastYear, quarters, total: yearData.Q1 + yearData.Q2 + yearData.Q3 + yearData.Q4 };
      } else {
        const fyLabel = finYearLabel(fyStart);
        const mlForMaterial = mlByMaterialAndYear[key]?.[fyLabel];
        const forecast = mlForMaterial?.length
          ? buildForecastFromML(mlForMaterial, materialSalesHistory, fyStart)
          : emptyForecast(fyLabel); // no stored predictions -> genuinely no data, never fabricate
        years[fyStart] = { isForecastYear, forecast, total: forecast.total };
      }
    });

    // Row-level filter/sticky values + inventory decisions from the nearest
    // future forecast FY among the selected slots (the in-horizon,
    // decision-relevant forecast). Null when no selected slot is a forecast
    // year — so historical-only slot arrangements show no confidence and no
    // inventory decision.
    const forecastFyStarts = fyStarts.filter((y) => y > currentFyStart);
    const primaryForecastYear = forecastFyStarts.length ? Math.min(...forecastFyStarts) : null;
    const firstForecast = primaryForecastYear != null ? years[primaryForecastYear]?.forecast : null;
    const hasRealForecast = Boolean(firstForecast && firstForecast.source !== "NO_DATA");
    const growthPct = hasRealForecast ? firstForecast.growthPct : null;
    const confidence = hasRealForecast ? firstForecast.avgConfidence : null;

    let inventoryDecision = null;
    if (hasRealForecast) {
      inventoryDecision = {};
      QUARTERS.forEach((q) => {
        inventoryDecision[q] = buildInventoryDecision({
          currentStock,
          safetyStock,
          quarterForecast: firstForecast.quarters[q],
        });
      });
    }

    return {
      materialNo: m.materialNo,
      materialName: m.description,
      model: m.model,
      safetyStock,
      currentStock,
      trend,
      stockRisk,
      growthPct,
      confidence,
      inventoryDecision,
      years,
    };
  });

  const filteredData = applyPlanningFilters(data, {
    trend: trend ? String(trend).split(",").filter(Boolean) : undefined,
    stockRisk: stockRisk ? String(stockRisk).split(",").filter(Boolean) : undefined,
    growthPct,
    confidence,
  });

  // Per-group "hasData": at least one row has a non-empty block for that FY
  // (any real actual for current, or a real forecast source for forecast FYs).
  const hasDataByFy = {};
  fyStarts.forEach((fyStart) => {
    const isForecast = fyStart > currentFyStart;
    hasDataByFy[fyStart] = filteredData.some((row) => {
      const block = row.years[fyStart];
      if (isForecast) return block.forecast.source !== "NO_DATA";
      return block.total > 0;
    });
  });

  return {
    currentFY: { value: currentFyStart, label: finYearLabel(currentFyStart) },
    groups: groupMeta.map((g) => ({ ...g, hasData: hasDataByFy[g.viewYear.value] })),
    data: filteredData,
  };
}

/**
 * Financial year options for the dropdown — includes historical years
 * from Sales Master, the current FY, and the immediate next forecast FY.
 */
async function getAvailableStartYears() {
  const now = new Date();
  const currentFyStart = currentFinancialYearStart(now);
  const financialYears = await Sales.distinct("FinancialYear");
  const startYears = financialYears
    .map((fy) => finYearStartCalendarYear(fy))
    .filter((y) => Number.isFinite(y) && y > 0);

  const years = buildYearOptions({
    currentFyStart,
    financialYearsFromSales: startYears,
  });

  return {
    years,
    currentFY: { value: currentFyStart, label: finYearLabel(currentFyStart) },
  };
}

module.exports = { buildPlanningView, getAvailableStartYears, finYearLabel };
