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
 */
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const Sales = require("../models/Sales");
const ForecastPredictions = require("../models/ForecastPredictions");
const { computeSafetyStock } = require("../utils/safetyStock");
const { MONTHS_BY_QUARTER, finYearLabel, finYearStartCalendarYear } = require("../utils/financialYear");

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
 * Builds the full forecast block for one material: quarterly forecast
 * quantities, confidence, growth%, monthly breakdown, and a plain-English
 * reason — using the material's ENTIRE sales history (not just the
 * currently-displayed 3-year window), so the forecast quality doesn't
 * depend on which years the user happens to be looking at.
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
 * (ForecastPredictions) instead of computing them here. This function is
 * intentionally separate from buildForecast — nothing about the existing
 * WMA algorithm (buildForecast, computeTrendGrowthRate,
 * weightedSeasonalAverage, computeConfidence, buildMonthlyBreakdown) was
 * modified to make this possible; they're both still fully intact and
 * this is simply a second, optional data source feeding the same shape.
 *
 * mlPredictionsForMaterial: ForecastPredictions docs for one materialNo,
 *   already filtered to the target financialYear (may span multiple
 *   plants — this function sums across all of them, same aggregation
 *   principle Sales Master's own Plant->Material rollup already uses).
 * materialSalesHistory / forecastYear: same inputs buildForecast takes —
 *   still used as a graceful-degradation fallback (see below).
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
    // Phase 6: the empirically horizon-adjusted WMAPE, averaged across the
    // quarter's rows (differs slightly by month within the quarter, same
    // reasoning as confidence being averaged above).
    const horizonAdjustedRows = rowsForQuarter.filter((p) => Number.isFinite(p.horizonAdjustedWmape));
    const horizonAdjustedWmape = horizonAdjustedRows.length
      ? Math.round((horizonAdjustedRows.reduce((s, p) => s + p.horizonAdjustedWmape, 0) / horizonAdjustedRows.length) * 100) / 100
      : null;
    const historyMonths = rowsWithConfidence.length ? rowsWithConfidence[0].historyMonths : null;
    const trend = rowsWithConfidence.length ? rowsWithConfidence[0].trend : null;
    const seasonality = rowsWithConfidence.length ? rowsWithConfidence[0].seasonality : null;
    const seasonalityPeakQuarter = rowsWithConfidence.length ? rowsWithConfidence[0].seasonalityPeakQuarter : null;
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
      forecastHorizon: monthsAheadRange ? `Month ${monthsAheadRange[0]}-${monthsAheadRange[1]} / 12` : null,
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

/**
 * Recommended Stock = Safety Stock + next quarter's forecasted demand —
 * a standard "target stock level" figure (how much should be on hand to
 * cover the immediate forecast period plus the safety buffer), not an
 * order quantity. Documented here since the spec left the exact formula
 * open ("using historical sales, forecast, safety stock, current stock").
 */
function computeRecommendedStock(safetyStock, forecast) {
  const nearTermDemand = forecast.quarters.Q1.qty;
  return Math.round(safetyStock + nearTermDemand);
}

function computeOverallTrend(historicalTotal, forecastTotal) {
  if (forecastTotal > historicalTotal) return "up";
  if (forecastTotal < historicalTotal) return "down";
  return "flat";
}

/**
 * A simple, transparent stock-risk label derived purely from numbers the
 * engine already computed — not part of the forecasting algorithm itself,
 * just a comparison applied after it, so this can be added without
 * touching buildForecast/computeTrendGrowthRate/etc.
 */
function computeStockRisk(currentStock, safetyStock, recommendedStock) {
  if (currentStock < safetyStock) return "Low";
  if (recommendedStock > 0 && currentStock > recommendedStock * 1.5) return "Overstock";
  return "Healthy";
}

/**
 * Post-filters the already-computed row data — this runs strictly AFTER
 * the forecasting engine, never touches it. filters: { trend?: string[],
 * stockRisk?: string[], growthPct?: {min,max}, confidence?: {min,max} }
 */
/**
 * Matches a numeric value against the same { op, value, min, max } shape
 * queryFilterBuilder.js's buildMongoFilter understands, so Planning's
 * numeric filters (Growth %, Confidence) behave identically to every
 * other module's Equals/Greater Than/Less Than/Between filters, just
 * applied in JS instead of a Mongo query since Planning's rows are
 * computed, not stored.
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
    if (!matchesNumberFilter(row.forecast.growthPct, filters.growthPct)) return false;
    if (!matchesNumberFilter(row.forecast.avgConfidence, filters.confidence)) return false;
    return true;
  });
}

/**
 * GET /api/planning's full payload. search filters by materialNo/
 * description/model; startYear is the first of the 3 displayed historical
 * years (defaults to the earliest year with sales data). The forecast
 * year is always startYear+3 — the continuation of the displayed
 * timeline, per the spec, not tied to the absolute latest data available.
 *
 * trend/stockRisk/growthPct/confidence are the "intelligent filters"
 * added by the global filtering upgrade — applied via applyPlanningFilters
 * AFTER the forecast is fully computed, so the forecasting logic itself
 * (buildForecast and everything it calls) is untouched by this.
 */
async function buildPlanningView({ search, startYear, trend, stockRisk, growthPct, confidence } = {}) {
  let resolvedStartYear = parseInt(startYear, 10);
  if (!Number.isFinite(resolvedStartYear)) {
    // FinancialYear ("2025-26") sorts correctly as a plain string for any
    // realistic 4-digit year range, so this needs no special handling.
    const earliestSales = await Sales.find({}).sort({ FinancialYear: 1 }).limit(1).select("FinancialYear").lean();
    resolvedStartYear = finYearStartCalendarYear(earliestSales[0]?.FinancialYear) || new Date().getFullYear();
  }
  const historicalYears = [resolvedStartYear, resolvedStartYear + 1, resolvedStartYear + 2];
  const forecastYear = resolvedStartYear + 3;

  const materialQuery = { isActive: true };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    materialQuery.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
  }
  const materials = await Material.find(materialQuery).sort("materialNo").lean();

  // PHASE 4: look for persisted ML predictions covering this exact
  // forecastYear, once, up front — not per material, and not by calling
  // the ML service synchronously (Section 18: never retrain/re-call on
  // every Planning Master view). If this query returns nothing (no
  // predictions generated yet, ML service has never run, or predictions
  // exist for a different forecast year), every material simply falls
  // back to the existing buildForecast() path below — this is the whole
  // fallback mechanism, no other flag or config needed.
  const forecastYearLabel = finYearLabel(forecastYear);
  const mlPredictionRows = await ForecastPredictions.find({ financialYear: forecastYearLabel }).lean();
  const mlPredictionsByMaterial = {};
  mlPredictionRows.forEach((p) => {
    if (!mlPredictionsByMaterial[p.materialNo]) mlPredictionsByMaterial[p.materialNo] = [];
    mlPredictionsByMaterial[p.materialNo].push(p);
  });

  // Stock: current totals per material. Sales: this material's ENTIRE
  // history (not filtered to historicalYears) — the forecast engine needs
  // the full picture regardless of which 3 years are currently displayed.
  // PHASE 1: Sales is now monthly-grain; MongoDB sums SalesQty grouped by
  // the already-derived Quarter field here, so "quarterly total" is always
  // a live sum of the underlying months — never a separately stored value
  // that could drift out of sync (see models/Sales.js's top comment).
  const [stockRows, salesRows] = await Promise.all([
    Stock.find({}).select("MatNo TotalStockQty").lean(),
    Sales.aggregate([
      { $group: { _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter" }, qty: { $sum: "$SalesQty" } } },
    ]),
  ]);

  const stockByMat = {};
  stockRows.forEach((s) => {
    const key = String(s.MatNo || "").trim().toUpperCase();
    if (!key) return;
    stockByMat[key] = (stockByMat[key] || 0) + (Number(s.TotalStockQty) || 0);
  });

  const salesByMat = {}; // materialNo -> { year -> { Q1, Q2, Q3, Q4 } }
  salesRows.forEach((s) => {
    const key = String(s._id.MatNo || "").trim().toUpperCase();
    const year = finYearStartCalendarYear(s._id.FinancialYear);
    if (!key || year === null || !QUARTERS.includes(s._id.Quarter)) return;
    if (!salesByMat[key]) salesByMat[key] = {};
    if (!salesByMat[key][year]) salesByMat[key][year] = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    salesByMat[key][year][s._id.Quarter] += Number(s.qty) || 0;
  });

  const data = materials.map((m) => {
    const key = m.materialNo;
    const currentStock = stockByMat[key] || 0;
    const materialSalesHistory = salesByMat[key] || {};

    const years = {};
    const displayedQuarterValues = [];
    historicalYears.forEach((y) => {
      const q = materialSalesHistory[y] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
      const total = q.Q1 + q.Q2 + q.Q3 + q.Q4;
      years[finYearLabel(y)] = { ...q, total };
      displayedQuarterValues.push(q.Q1, q.Q2, q.Q3, q.Q4);
    });

    const safetyStock = computeSafetyStock(displayedQuarterValues);
    const mlPredictionsForMaterial = mlPredictionsByMaterial[m.materialNo];
    const forecast = mlPredictionsForMaterial
      ? buildForecastFromML(mlPredictionsForMaterial, materialSalesHistory, forecastYear)
      : buildForecast(materialSalesHistory, forecastYear);
    const latestHistoricalTotal = years[finYearLabel(historicalYears[2])].total;
    const recommendedStock = computeRecommendedStock(safetyStock, forecast);

    return {
      materialNo: m.materialNo,
      materialName: m.description,
      model: m.model,
      safetyStock,
      currentStock,
      years,
      forecast,
      trend: computeOverallTrend(latestHistoricalTotal, forecast.total),
      recommendedStock,
      stockRisk: computeStockRisk(currentStock, safetyStock, recommendedStock),
    };
  });

  const filteredData = applyPlanningFilters(data, {
    trend: trend ? String(trend).split(",").filter(Boolean) : undefined,
    stockRisk: stockRisk ? String(stockRisk).split(",").filter(Boolean) : undefined,
    growthPct,
    confidence,
  });

  return {
    years: historicalYears.map(finYearLabel),
    forecastYear: finYearLabel(forecastYear),
    startYear: resolvedStartYear,
    data: filteredData,
  };
}

/**
 * Distinct calendar years with sales data — dropdown options, built
 * dynamically, never hardcoded.
 *
 * BUG FIX (Phase 5): this previously queried `Sales.distinct("Year")`, a
 * field that no longer exists on Sales Master — the schema has only ever
 * had `FinancialYear` (e.g. "2024-25") since the monthly-schema migration,
 * so this silently returned an empty array and the Financial Year
 * dropdown had no options. `FinancialYear` is the authoritative field
 * (Sales.js's own schema comment) — this does not introduce a second
 * financial-year representation, it reuses `finYearStartCalendarYear()`,
 * the exact same helper `buildPlanningView` already uses to parse a
 * FinancialYear label back into the numeric calendar start year its
 * `startYear` param and the `{value, label}` dropdown contract both
 * expect. The dedupe guards against two distinct FinancialYear labels
 * ever parsing to the same start year (defensive; MongoDB's own
 * `.distinct()` already guarantees unique raw label values).
 */
async function getAvailableStartYears() {
  const financialYears = await Sales.distinct("FinancialYear");
  const startYears = financialYears
    .map((fy) => finYearStartCalendarYear(fy))
    .filter((y) => Number.isFinite(y) && y > 0);
  const uniqueSorted = [...new Set(startYears)].sort((a, b) => a - b);
  return uniqueSorted.map((y) => ({ value: y, label: finYearLabel(y) }));
}

module.exports = { buildPlanningView, getAvailableStartYears, finYearLabel };
