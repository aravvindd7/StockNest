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
 * Active-FY operational timeline: the view is a FIXED, date-derived window
 * of three financial years — Previous FY | Previous FY | Active FY
 * (e.g. 2024-25 | 2025-26 | 2026-27 ACTIVE). There is no permanent
 * "Forecast Year" anymore. The Active FY is a MIXED year: months that have
 * started show real Sales Master actuals, future months show the existing
 * rolling XGBoost/WMA_FALLBACK predictions from ForecastPredictions where
 * they exist — never fabricated. A PLAN column (current working quarter's
 * demand) and a REQUIRED STOCK column (max(0, plan demand − current stock))
 * sit next to it as the operational decision layer.
 */
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const Sales = require("../models/Sales");
const ForecastPredictions = require("../models/ForecastPredictions");
const { computeSafetyStock } = require("../utils/safetyStock");
const { buildInventoryDecision } = require("../utils/inventoryDecision");
const { MONTHS_BY_QUARTER, QUARTER_BY_MONTH, finYearLabel, finYearStartCalendarYear } = require("../utils/financialYear");
const { currentFinancialYearStart } = require("../utils/forecastTargets");

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

/** Calendar-order month names (Jan=0..Dec=11) — Document index 0 of getMonth(). */
const CALENDAR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calendar year a month belongs to within a financial year: April–December
 * fall in the FY start year, January–March in the following calendar year.
 * e.g. March of FY 2026-27 → 2027; September of FY 2026-27 → 2026.
 */
function monthCalendarYear(monthName, fyStart) {
  const ci = CALENDAR_MONTHS.indexOf(monthName);
  return ci >= 3 /* April */ ? fyStart : fyStart + 1;
}

/** The 1st of a month within the active FY, as a Date — for "has this month started?" checks. */
function monthStartDate(monthName, fyStart) {
  const ci = CALENDAR_MONTHS.indexOf(monthName);
  return new Date(monthCalendarYear(monthName, fyStart), ci, 1);
}

/**
 * Confidence is higher when a quarter's historical values are consistent
 * (low variance) year to year. Kept as the graceful fallback when a stored
 * ForecastPredictions row predates the `confidence` field.
 */
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
 * One quarter of the ACTIVE financial year — a hybrid of Sales Master
 * actuals (months that have started) and ForecastPredictions (future
 * months). Each month carries a `source`: "actual" | "forecast" | "none"
 * (a future month with no stored prediction is deliberately "none"/0 —
 * never fabricated). Forecast-intelligence fields are attached to the
 * quarter only when forecast months exist, sourced from the stored
 * evidence-based values (real backtest WMAPE, trend/seasonality), never
 * invented here.
 */
function buildActiveQuarter({ quarter, monthlyActuals, forecastByMonth, activeFyStart, now, historicalForThisQuarter }) {
  const months = MONTHS_BY_QUARTER[quarter];
  const quarterForecastDocs = [];

  const monthly = months.map((month) => {
    // A month that has already started (including the current month, best
    // available partial data) is an ACTUAL in Sales Master terms.
    if (monthStartDate(month, activeFyStart) <= now) {
      return { month, qty: monthlyActuals[month] || 0, source: "actual" };
    }
    const docs = forecastByMonth[month] || [];
    docs.forEach((d) => quarterForecastDocs.push(d));
    if (docs.length === 0) {
      // Future month with no stored prediction — genuinely no data.
      return { month, qty: 0, source: "none" };
    }
    return { month, qty: Math.round(docs.reduce((s, p) => s + (p.predictedSalesQty || 0), 0)), source: "forecast" };
  });

  const qty = monthly.reduce((s, m) => s + m.qty, 0);
  const hasForecast = monthly.some((m) => m.source === "forecast");
  const hasElapsed = monthly.some((m) => m.source === "actual");
  const mode = hasForecast ? "forecast" : hasElapsed ? "actual" : "none";

  const base = { qty, mode, monthly };
  if (quarterForecastDocs.length === 0) return base;

  const anyXgboost = quarterForecastDocs.some((p) => p.model === "XGBoost");
  const rowsWithConfidence = quarterForecastDocs.filter((p) => Number.isFinite(p.confidence));
  const confidence = rowsWithConfidence.length
    ? Math.round(rowsWithConfidence.reduce((s, p) => s + p.confidence, 0) / rowsWithConfidence.length)
    : computeConfidence(historicalForThisQuarter);
  const confidenceTier = rowsWithConfidence.length ? rowsWithConfidence[rowsWithConfidence.length - 1].confidenceTier : null;
  const segmentWmape = rowsWithConfidence.length ? rowsWithConfidence[0].segmentWmape : null;
  const horizonAdjustedRows = quarterForecastDocs.filter((p) => Number.isFinite(p.horizonAdjustedWmape));
  const horizonAdjustedWmape = horizonAdjustedRows.length
    ? Math.round((horizonAdjustedRows.reduce((s, p) => s + p.horizonAdjustedWmape, 0) / horizonAdjustedRows.length) * 100) / 100
    : null;
  const historyMonths = rowsWithConfidence.length ? rowsWithConfidence[0].historyMonths : null;
  const trend = rowsWithConfidence.length ? rowsWithConfidence[0].trend : null;
  const seasonality = rowsWithConfidence.length ? rowsWithConfidence[0].seasonality : null;
  const seasonalityPeakQuarter = rowsWithConfidence.length ? rowsWithConfidence[0].seasonalityPeakQuarter : null;

  const horizonDenominator = quarterForecastDocs.length
    ? (quarterForecastDocs[0].horizonMonths
      || Math.max(...quarterForecastDocs.map((p) => p.monthsAheadInHorizon || 0))
      || 12)
    : 12;
  const monthsAheadRange = quarterForecastDocs.length
    ? [Math.min(...quarterForecastDocs.map((p) => p.monthsAheadInHorizon || 0)), Math.max(...quarterForecastDocs.map((p) => p.monthsAheadInHorizon || 0))]
    : null;

  const reason = rowsWithConfidence[0]?.reason || "Forecast generated by the ML forecasting pipeline.";

  return {
    ...base,
    confidence,
    confidenceTier,
    segmentWmape,
    horizonAdjustedWmape,
    historyMonths,
    trend,
    seasonality,
    seasonalityPeakQuarter,
    forecastHorizon: monthsAheadRange ? `Month ${monthsAheadRange[0]}-${monthsAheadRange[1]} / ${horizonDenominator}` : null,
    reason,
    source: anyXgboost ? "XGBoost" : "WMA_FALLBACK",
  };
}

/**
 * GET /api/planning's full payload — the fixed Active-FY operational
 * timeline.
 *
 * Three FY column groups, derived entirely from the server clock:
 * Previous FY | Previous FY | Active FY (2024-25 | 2025-26 | 2026-27
 * ACTIVE today). The window rolls forward automatically when the calendar
 * enters the next FY. Previous FYs are full Sales Master actuals; the
 * Active FY is a per-month hybrid of actual + forecast (see
 * buildActiveQuarter).
 *
 * Each row carries:
 *   - row-level attributes (safetyStock, currentStock, trend, stockRisk,
 *     growthPct, confidence) that drive the sticky columns + filters;
 *   - `years[fyStart]` per-FY blocks — previous FYs: actual quarters;
 *     the Active FY: hybrid quarters ({qty, mode, monthly[source], ...});
 *   - `planDemand` = the current working quarter's demand (actuals where
 *     months have started, forecast for future months);
 *   - `requiredStock` = max(0, planDemand − currentStock) — a simple,
 *     immediate demand-gap metric that deliberately excludes Safety Stock
 *     (that belongs to the separate Phase 7 replenishment/decision logic);
 *   - `inventoryDecision[quarter]` = the Phase 7 decision per Active-FY
 *     quarter (projected stock, replenishment qty, stock status) — kept
 *     separate from Required Stock.
 *
 * Filters (trend/stockRisk/growthPct/confidence) are applied once across
 * the row set AFTER all FY blocks are built, so the same materials appear
 * in every FY group (a consistent row set, not three independently
 * filtered lists).
 */
async function buildPlanningView({ search, trend, stockRisk, growthPct, confidence } = {}) {
  const now = new Date();
  const activeFyStart = currentFinancialYearStart(now);
  const activeFyLabel = finYearLabel(activeFyStart);
  const prevFy1 = activeFyStart - 1;
  const prevFy2 = activeFyStart - 2;
  const fyStarts = [prevFy2, prevFy1, activeFyStart];

  // Current operational period, derived from the clock — never hardcoded.
  const activeMonth = CALENDAR_MONTHS[now.getMonth()] || "January";
  const workingQuarter = QUARTER_BY_MONTH[activeMonth] || "Q1";
  const coveredQuarters = QUARTERS.slice(0, QUARTERS.indexOf(workingQuarter) + 1);

  const groupMeta = fyStarts.map((y, i) => ({
    index: i,
    viewYear: { value: y, label: finYearLabel(y), active: y === activeFyStart },
  }));

  const materialQuery = { isActive: true };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    materialQuery.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
  }
  const materials = await Material.find(materialQuery).sort("materialNo").lean();

  // Stock: current totals per material. Sales: aggregated to Month level so
  // each actual quarter can carry both its total and a real monthly
  // breakdown for the drill-down drawer. ML predictions: loaded ONLY for
  // the Active FY — future months within it come from ForecastPredictions;
  // months that fall in the NEXT FY (a forecast crossing the FY boundary)
  // are simply not presented, per the no-forecast-year rule.
  const [stockRows, salesRows, mlPredictionRows] = await Promise.all([
    Stock.find({}).select("MatNo TotalStockQty").lean(),
    Sales.aggregate([
      { $group: { _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter", Month: "$Month" }, qty: { $sum: "$SalesQty" } } },
    ]),
    ForecastPredictions.find({ financialYear: activeFyLabel }).lean(),
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

  // ForecastPredictions grouped by materialNo -> month -> rows (summed
  // across plants later, the same Plant->Material rollup Sales uses).
  const forecastByMatMonth = {};
  mlPredictionRows.forEach((p) => {
    const key = String(p.materialNo || "").trim().toUpperCase();
    if (!key) return;
    if (!forecastByMatMonth[key]) forecastByMatMonth[key] = {};
    if (!forecastByMatMonth[key][p.month]) forecastByMatMonth[key][p.month] = [];
    forecastByMatMonth[key][p.month].push(p);
  });

  const data = materials.map((m) => {
    const key = m.materialNo;
    const currentStock = stockByMat[key] || 0;
    const materialSalesHistory = salesByMat[key] || {};
    const materialMonthly = monthlyByMat[key] || {};
    const materialForecast = forecastByMatMonth[key] || {};
    const historyYears = Object.keys(materialSalesHistory).map(Number).sort((a, b) => a - b);

    // Safety stock: computed from ALL quarterly history — FY-independent.
    const allQuarterValues = [];
    Object.values(materialSalesHistory).forEach((yearData) => {
      QUARTERS.forEach((q) => allQuarterValues.push(yearData[q] || 0));
    });
    const safetyStock = computeSafetyStock(allQuarterValues);

    // Per-FY blocks keyed by FY start year.
    const years = {};

    // Previous FYs: pure Sales Master actuals.
    [prevFy2, prevFy1].forEach((fyStart) => {
      const yearData = materialSalesHistory[fyStart] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
      const monthData = materialMonthly[fyStart] || {};
      const quarters = {};
      QUARTERS.forEach((q) => {
        const m = monthData[q] || {};
        quarters[q] = {
          qty: yearData[q],
          mode: "actual",
          monthly: MONTHS_BY_QUARTER[q].map((month) => ({ month, qty: m[month] || 0, source: "actual" })),
        };
      });
      years[fyStart] = { isForecastYear: false, quarters, total: yearData.Q1 + yearData.Q2 + yearData.Q3 + yearData.Q4 };
    });

    // Active FY: hybrid actual + forecast at month granularity.
    const activeMonthData = materialMonthly[activeFyStart] || {};
    const activeQuarters = {};
    QUARTERS.forEach((q) => {
      const historicalForThisQuarter = historyYears.map((y) => materialSalesHistory[y]?.[q] || 0);
      activeQuarters[q] = buildActiveQuarter({
        quarter: q,
        monthlyActuals: activeMonthData[q] || {},
        forecastByMonth: materialForecast,
        activeFyStart,
        now,
        historicalForThisQuarter,
      });
      // Like-for-like quarterly growth vs the same quarter of the prior FY.
      const prevQty = materialSalesHistory[prevFy1]?.[q] || 0;
      activeQuarters[q].growthPct = prevQty > 0 ? Math.round(((activeQuarters[q].qty - prevQty) / prevQty) * 100) : null;
    });
    const activeTotal = QUARTERS.reduce((s, q) => s + activeQuarters[q].qty, 0);
    years[activeFyStart] = {
      isForecastYear: false,
      isActive: true,
      workingQuarter,
      quarters: activeQuarters,
      total: activeTotal,
    };

    // Row-level trend/growth: like-for-like covered-period comparison
    // (Q1..workingQuarter) against the same period last FY — comparing a
    // partial Active FY against a full prior year would be misleading.
    const activeCovered = coveredQuarters.reduce((s, q) => s + activeQuarters[q].qty, 0);
    const prevYearData = materialSalesHistory[prevFy1] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    const prevCovered = coveredQuarters.reduce((s, q) => s + (prevYearData[q] || 0), 0);
    const trend = computeOverallTrend(prevCovered, activeCovered);
    const stockRisk = computeStockRisk(currentStock, safetyStock);
    const growthPct = prevCovered > 0 ? Math.round(((activeCovered - prevCovered) / prevCovered) * 100) : null;

    // Forecast confidence is only meaningful where forecast-backed months
    // exist in the Active FY — null when there are none (never shown as if
    // historical actuals had a forecast score).
    const forecastDocConfidences = Object.values(materialForecast)
      .flat()
      .map((p) => p.confidence)
      .filter((v) => Number.isFinite(v));
    const confidence = forecastDocConfidences.length
      ? Math.round(forecastDocConfidences.reduce((s, v) => s + v, 0) / forecastDocConfidences.length)
      : null;

    // PLAN = the current working quarter; REQUIRED STOCK = immediate demand
    // gap (no safety stock, no replenishment formula — see inventoryDecision).
    const planDemand = activeQuarters[workingQuarter].qty;
    const requiredStock = Math.max(0, planDemand - currentStock);

    // Phase 7 inventory decision per Active-FY quarter — kept separate from
    // Required Stock.
    const inventoryDecision = {};
    QUARTERS.forEach((q) => {
      inventoryDecision[q] = buildInventoryDecision({
        currentStock,
        safetyStock,
        quarterForecast: { qty: activeQuarters[q].qty },
      });
    });

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
      planDemand,
      requiredStock,
      planQuarter: workingQuarter,
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

  // Per-group "hasData": at least one row has a non-empty block for that FY.
  const hasDataByFy = {};
  fyStarts.forEach((fyStart) => {
    hasDataByFy[fyStart] = filteredData.some((row) => row.years[fyStart]?.total > 0);
  });

  // The Active FY holds any forecast month at all (unfiltered across
  // materials) — drives whether the Forecast Confidence column renders.
  const hasForecastData = Object.keys(forecastByMatMonth).length > 0;

  return {
    activeFY: { value: activeFyStart, label: activeFyLabel },
    activeMonth,
    activeQuarter: workingQuarter,
    workingQuarter,
    previousFY: [
      { value: prevFy2, label: finYearLabel(prevFy2) },
      { value: prevFy1, label: finYearLabel(prevFy1) },
    ],
    hasForecastData,
    groups: groupMeta.map((g) => ({ ...g, hasData: hasDataByFy[g.viewYear.value] })),
    data: filteredData,
  };
}

/**
 * Financial year options for a dropdown — historical years from Sales
 * Master, the current FY, and the immediate next forecast FY. Retained for
 * backward compatibility; the Active-FY timeline no longer consumes it.
 */
async function getAvailableStartYears() {
  const now = new Date();
  const currentFyStart = currentFinancialYearStart(now);
  const financialYears = await Sales.distinct("FinancialYear");
  const startYears = financialYears
    .map((fy) => finYearStartCalendarYear(fy))
    .filter((y) => Number.isFinite(y) && y > 0);

  const { buildYearOptions } = require("../utils/forecastTargets");
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