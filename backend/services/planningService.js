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
 *
 * ROLLING HORIZON: the forecast covers the current quarter + the next 2
 * quarters (a fixed system rule — no user-facing horizon selector). Each
 * row carries a `planSeries`: the forward rolling time series from the
 * working quarter through that horizon, with per-month `source: "actual" |
 * "forecast" | "none"`. When the working quarter is Q3/Q4 the horizon
 * crosses into the NEXT FY; those crossed months come from the next FY's
 * ForecastPredictions and are rendered inside the planSeries — a forecast
 * that crosses the FY boundary is part of the active rolling window, never
 * a standalone forecast-year column.
 */
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const Sales = require("../models/Sales");
const ForecastPredictions = require("../models/ForecastPredictions");
const ReplenishmentPlan = require("../models/ReplenishmentPlan");
const { computeSafetyStock } = require("../utils/safetyStock");
const { buildInventoryDecision } = require("../utils/inventoryDecision");
const { computeWeekCoverage } = require("../utils/weekCoverage");
const { computeAllocation, validateDistribution, WORKING_QUARTER_MONTHS } = require("../utils/replenishmentAllocation");
const { predictReplenishment, resolveActivePlan } = require("../utils/replenishmentPrediction");
const { MONTHS_BY_QUARTER, QUARTER_BY_MONTH, ALL_MONTHS, finYearLabel, finYearStartCalendarYear, deriveQuarter } = require("../utils/financialYear");
const { currentFinancialYearStart, planForecastEndMonth } = require("../utils/forecastTargets");
const { calendarQuarterOfDate, calendarQuarterMonths, fyStartForCalendarQuarter, computeCurrentQuarterMetrics } = require("../utils/currentQuarterSales");

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

/** Global month index of a FY-start-year + calendar-month pair (year*12 + Indian-FY month index). */
function fyGlobalMonthIndex(fyStart, monthName) {
  const ci = ALL_MONTHS.indexOf(monthName); // Indian-FY order: Apr=0 … Mar=11
  return fyStart * 12 + ci;
}

/** The last month of each quarter within the Indian FY (Jun=2, Sep=5, Dec=8, Mar=11 in ALL_MONTHS 0-based). */
const LAST_MONTH_OF_QUARTER_INDEX = { Q1: 2, Q2: 5, Q3: 8, Q4: 11 };

/**
 * The forward "current quarter + next 2 quarters" rolling time series for a
 * material — every month from the start of the working quarter through the
 * end of (workingQuarter + 2), each with its FY, quarter, quantity and
 * `source`.
 *
 * Actual-vs-forecast classification is DATA-DRIVEN, not calendar-driven:
 *   - a month with a real Sales Master actual → ACTUAL (whatever its state);
 *   - the CURRENT month with no posted actual → FORECAST (reuses the stored
 *     rolling ForecastPredictions for that month — e.g. today, September has
 *     no Sales row but the rolling forecast emits a September prediction, so
 *     it reads FORECAST, never a fabricated "0 ACTUAL");
 *   - a future month with a stored prediction → FORECAST;
 *   - missing data/prediction → "none"/0, never fabricated.
 * Crosses an FY boundary when the working quarter is Q3 or Q4 — e.g. Q4
 * 2026-27 rolls into Q1/Q2 2027-28.
 */
function buildPlanSeries({ workingQuarter, activeFyStart, now, monthlyActualsByQuarter, forecastByMonth }) {
  const wq = QUARTERS.indexOf(workingQuarter); // 0..3
  const endQuarterIdx = (wq + 2) % 4;
  const endQuarter = QUARTERS[endQuarterIdx];
  const endMonth = ALL_MONTHS[LAST_MONTH_OF_QUARTER_INDEX[endQuarter]];
  const endFyStart = activeFyStart + Math.floor((wq + 2) / 4);
  const lastIdx = fyGlobalMonthIndex(endFyStart, endMonth);
  const currentMonthName = CALENDAR_MONTHS[now.getMonth()];

  const items = [];
  let fy = activeFyStart;
  for (let qi = wq; qi < wq + 3; qi = qi + 1) {
    const quarterName = QUARTERS[qi % 4];
    if (qi !== 0 && qi % 4 === 0) fy += 1; // crossed an FY boundary
    MONTHS_BY_QUARTER[quarterName].forEach((month) => {
      if (fyGlobalMonthIndex(fy, month) > lastIdx) return; // outside horizon
      const quarterMap = monthlyActualsByQuarter[fy]?.[quarterName] || {};
      const hasActualData = Object.prototype.hasOwnProperty.call(quarterMap, month);
      if (hasActualData) {
        items.push({ month, quarter: quarterName, financialYear: finYearLabel(fy), qty: quarterMap[month], source: "actual" });
        return;
      }
      // No actual Sales row. A completed month is genuinely empty (NONE —
      // never forecast a month that's already passed); a current/future month
      // falls through to the stored rolling prediction (FORECAST) if one
      // exists, else NONE.
      if (monthStartDate(month, fy) <= now && month !== currentMonthName) {
        items.push({ month, quarter: quarterName, financialYear: finYearLabel(fy), qty: 0, source: "none" });
        return;
      }
      const docs = forecastByMonth[`${finYearLabel(fy)}|${month}`] || [];
      items.push({
        month, quarter: quarterName, financialYear: finYearLabel(fy),
        qty: docs.length ? Math.round(docs.reduce((s, p) => s + (p.predictedSalesQty || 0), 0)) : 0,
        source: docs.length ? "forecast" : "none",
      });
    });
  }
  return items;
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
 * actuals and ForecastPredictions. Each month carries a `source`: "actual" |
 * "forecast" | "none".
 *
 * The actual-vs-forecast classification is DATA-DRIVEN, never calendar-only:
 *   - a month with a real Sales Master actual → ACTUAL (completed, or the
 *     current month where a value has already been posted);
 *   - the CURRENT month with no posted actual → FORECAST — it reuses the
 *     stored rolling ForecastPredictions for that month, so a September
 *     prediction shows as FORECAST rather than a fabricated "0 ACTUAL";
 *   - a future month with a stored prediction → FORECAST;
 *   - missing data/prediction → "none"/0, never fabricated.
 * Forecast-intelligence fields are attached to the quarter only when
 * forecast months exist, sourced from the stored evidence-based values
 * (real backtest WMAPE, trend/seasonality), never invented here.
 */
function buildActiveQuarter({ quarter, monthlyActuals, forecastByMonth, activeFyStart, activeFyLabel, now, historicalForThisQuarter }) {
  const months = MONTHS_BY_QUARTER[quarter];
  const quarterForecastDocs = [];
  const currentMonthName = CALENDAR_MONTHS[now.getMonth()];

  const monthly = months.map((month) => {
    const hasActualData = Object.prototype.hasOwnProperty.call(monthlyActuals, month);
    if (hasActualData) {
      // Real Sales Master row — a completed month, or the current month with
      // a posted (possibly partial) value.
      return { month, qty: monthlyActuals[month], source: "actual" };
    }
    // No actual Sales row. A completed month is genuinely empty (NONE); the
    // current month (no data posted yet) and future months fall through to
    // the stored rolling prediction — FORECAST when one exists, else NONE.
    if (monthStartDate(month, activeFyStart) <= now && month !== currentMonthName) {
      return { month, qty: 0, source: "none" };
    }
    const docs = forecastByMonth[`${activeFyLabel}|${month}`] || [];
    docs.forEach((d) => quarterForecastDocs.push(d));
    if (docs.length === 0) {
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
 *   - `weekCoverage` = read-only inventory-health indicator — current stock
 *     ÷ average weekly forecast demand, computed ONLY from the forecast
 *     months of the row's own planSeries (utils/weekCoverage.js). It is
 *     informational; it never derives Plan / Required Stock and never
 *     modifies the inventory decision.
 *   - `replenishmentPlan` = planner-controlled Monthly Replenishment
 *     Allocation — WHEN the Required Stock is replenished across the working
 *     quarter's months. The planner's saved percentages are authoritative;
 *     quantities are always recomputed (largest-remainder) from the CURRENT
 *     requiredStock so they sum exactly to it. No saved allocation → the
 *     temporary 33.33/33.33/33.34 default (saved: false).
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

  // Current real-world CALENDAR quarter (Q1=Jan-Mar … Q4=Oct-Dec) — entirely
  // separate from the working FY quarter above. The two "Q2 Sales" columns
  // always track this calendar quarter regardless of which FY/quarter the
  // user is viewing. A calendar quarter's months always fall inside one FY:
  //   Q1 (Jan-Mar)  → previous FY (Jan 2026 → FY 2025-26)
  //   Q2-Q4 (Apr-Dec) → the FY starting this calendar year (May 2026 → FY 2026-27)
  const cqLabel = calendarQuarterOfDate(now);
  const cqMonths = calendarQuarterMonths(cqLabel);
  const cqFyStart = fyStartForCalendarQuarter(now);
  const cqFyLabel = finYearLabel(cqFyStart);

  const groupMeta = fyStarts.map((y, i) => ({
    index: i,
    viewYear: { value: y, label: finYearLabel(y), active: y === activeFyStart },
  }));

  // Exclude BOTH soft-deactivated (isActive: false) AND discontinued
  // (status: "Discontinued") materials — a discontinued material stays in
  // Material Master for history/audit but must not appear in the operational
  // planning timeline.
  const materialQuery = { isActive: true, status: { $ne: "Discontinued" } };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    materialQuery.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
  }
  const materials = await Material.find(materialQuery).sort("materialNo").lean();

  // Stock: current totals per material. Sales: aggregated to Month level so
  // each actual quarter can carry both its total and a real monthly
  // breakdown for the drill-down drawer. ML predictions: loaded for the
  // Active FY AND the next FY — future months within the Active FY come from
  // ForecastPredictions, and when the "current quarter + next 2 quarters"
  // horizon crosses into the next FY (working quarter Q3/Q4), those crossed
  // months belong to the NEXT FY and are rendered in the forward planSeries
  // (a forecast that crosses the FY boundary is presented — it is part of
  // the active rolling window — not a standalone forecast year column).
  const nextFyLabel = finYearLabel(activeFyStart + 1);
  const [stockRows, salesRows, mlPredictionRows, replenishmentRows] = await Promise.all([
    Stock.find({}).select("MatNo TotalStockQty").lean(),
    Sales.aggregate([
      { $group: { _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter", Month: "$Month" }, qty: { $sum: "$SalesQty" } } },
    ]),
    ForecastPredictions.find({ financialYear: { $in: [activeFyLabel, nextFyLabel] } }).lean(),
    ReplenishmentPlan.find({ financialYear: activeFyLabel, quarter: workingQuarter }).lean(),
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

  // ForecastPredictions grouped by materialNo -> (financialYear|month) ->
  // rows (summed across plants later, the same Plant->Material rollup Sales
  // uses). Keyed by FY+month so Active-FY and crossed next-FY months both
  // resolve — a forecast that crosses into the next FY is still part of the
  // rolling horizon and must populate the forward planSeries.
  const forecastByMatMonth = {};
  mlPredictionRows.forEach((p) => {
    const key = String(p.materialNo || "").trim().toUpperCase();
    if (!key) return;
    if (!forecastByMatMonth[key]) forecastByMatMonth[key] = {};
    const monthKey = `${p.financialYear}|${p.month}`;
    if (!forecastByMatMonth[key][monthKey]) forecastByMatMonth[key][monthKey] = [];
    forecastByMatMonth[key][monthKey].push(p);
  });

  // Saved planner allocations for the working quarter — keyed by material.
  const savedReplenishmentByMat = {};
  replenishmentRows.forEach((r) => {
    const key = String(r.materialNo || "").trim().toUpperCase();
    if (!key) return;
    savedReplenishmentByMat[key] = r;
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
          // A historical month with a real Sales row is ACTUAL; one with no
          // record is NONE (never a fabricated "0 ACTUAL").
          monthly: MONTHS_BY_QUARTER[q].map((month) => ({
            month,
            qty: Object.prototype.hasOwnProperty.call(m, month) ? m[month] : 0,
            source: Object.prototype.hasOwnProperty.call(m, month) ? "actual" : "none",
          })),
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
        activeFyLabel,
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

    // Current real-world calendar quarter Sales / Sales to Go — observability
    // only. Purely in-memory over the maps already loaded above (no extra
    // query): the current calendar quarter's months, resolved against
    // month-granular Sales Master actuals and ForecastPredictions via
    // utils/currentQuarterSales.js. Never feeds Plan / Required Stock /
    // replenishment — see that util's header for the ACTUAL/FORECAST rule.
    const cqMetrics = computeCurrentQuarterMetrics({
      now,
      actualForMonth: (month) => {
        const monthActuals = materialMonthly[cqFyStart]?.[deriveQuarter(month)] || {};
        return Object.prototype.hasOwnProperty.call(monthActuals, month) ? monthActuals[month] : null;
      },
      forecastForMonth: (month) => {
        const rows = forecastByMatMonth[key]?.[`${cqFyLabel}|${month}`] || [];
        return rows.length ? Math.round(rows.reduce((s, p) => s + (p.predictedSalesQty || 0), 0)) : null;
      },
    });
    const currentQuarterSales = cqMetrics.sales;
    const currentQuarterSalesToGo = cqMetrics.salesToGo;

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

    // The forward "current quarter + next 2 quarters" rolling time series —
    // actual months (Sales Master) followed by forecast months (the same
    // rolling forecast), crossing into the next FY when the horizon requires.
    // This is what a Plan/working-quarter cell's drill-down renders.
    const planSeries = buildPlanSeries({
      workingQuarter,
      activeFyStart,
      now,
      monthlyActualsByQuarter: materialMonthly,
      forecastByMonth: materialForecast,
    });

    // Week Coverage — read-only inventory-health indicator. Consumes ONLY
    // the FORECAST months of the existing active rolling forecast (planSeries
    // excludes/de-duplicates actuals, so actual demand can never leak in and
    // no month is double-counted). It never triggers an order and does not
    // touch the Plan / Required Stock / Inventory Decision calculations.
    const weekCoverage = computeWeekCoverage({
      currentStock,
      forecastMonths: planSeries.filter((m) => m.source === "forecast"),
    });

    // Monthly Replenishment Allocation — controls WHEN Required Stock is
    // replenished across the working quarter's months. NOT demand
    // distribution. Backend is the source of truth for the automatic
    // prediction:
    //
    //   autoPlan — the current AUTO_FORECAST allocation, always recomputed
    //   live from the XGBoost demand forecast + current inventory via a
    //   stock-depletion simulation (utils/replenishmentPrediction.js). It
    //   never goes stale when the rolling forecast regenerates. This is the
    //   Reset target and the default when no manual plan is saved.
    //
    //   replenishmentPlan — the ACTIVE allocation. A saved MANUAL plan wins
    //   (never auto-overwritten); otherwise the AUTO plan is active. A saved
    //   plan's stored quantities are a historical snapshot, so the live view
    //   ALWAYS recomputes quantities from the CURRENT requiredStock
    //   (largest-remainder) — the sum is therefore always exactly current
    //   requiredStock.
    const autoPlan = predictReplenishment({
      currentStock,
      requiredStock,
      quarter: workingQuarter,
      monthly: activeQuarters[workingQuarter].monthly,
      now,
      activeFyStart,
      financialYear: activeFyLabel,
    });
    const replenishmentPlan = resolveActivePlan({
      savedPlan: savedReplenishmentByMat[key],
      autoPlan,
      requiredStock,
      workingQuarter,
    });

    return {
      materialNo: m.materialNo,
      planSeries,
      materialName: m.description,
      model: m.model,
      currentQuarterSales,
      currentQuarterSalesToGo,
      safetyStock,
      currentStock,
      trend,
      stockRisk,
      growthPct,
      confidence,
      planDemand,
      requiredStock,
      weekCoverage,
      replenishmentPlan,
      autoReplenishmentPlan: autoPlan,
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
    currentQuarter: { label: cqLabel },
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

/**
 * Save a planner-controlled replenishment allocation for a single material.
 * Recalculates quantities from the supplied percentages using the largest-
 * remainder algorithm, then upserts the ReplenishmentPlan document.
 *
 * @param {{materialNo, financialYear, quarter, requiredStock, distribution, depotId?, updatedBy?}} params
 * @returns {object} The saved document.
 */
async function saveReplenishmentPlan({ materialNo, financialYear, quarter, requiredStock, distribution, depotId, updatedBy }) {
  const calc = computeAllocation(requiredStock, distribution.map((d) => d.percentage));
  const entries = distribution.map((d, i) => ({
    month: d.month,
    percentage: d.percentage,
    quantity: calc[i],
    source: d.source || "none",
  }));
  const v = validateDistribution(entries, requiredStock);
  if (!v.valid) {
    // Brand the error so the controller can return 400 (client input error)
    // without string-matching on the message text.
    const err = new Error(v.error);
    err.validation = true;
    throw err;
  }

  const filter = { materialNo, financialYear, quarter, depotId: depotId || "" };
  const update = {
    requiredStock,
    distributionMode: "MANUAL",
    distribution: entries,
    updatedBy: updatedBy || "",
  };
  const doc = await ReplenishmentPlan.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return doc;
}

/**
 * Load the saved replenishment allocation for a material. Returns null
 * when no allocation exists (caller applies the default temporary state).
 *
 * @param {{materialNo, financialYear, quarter, depotId?}} params
 * @returns {object|null}
 */
async function loadReplenishmentPlan({ materialNo, financialYear, quarter, depotId }) {
  const doc = await ReplenishmentPlan.findOne({ materialNo, financialYear, quarter, depotId: depotId || "" }).lean();
  return doc || null;
}

/**
 * Reset a saved manual replenishment allocation — deletes the persisted
 * ReplenishmentPlan document so the active plan resolves back to the live
 * AUTO_FORECAST prediction (the backend's single source of truth). Idempotent:
 * resetting a material with no saved override is a no-op success.
 *
 * @param {{materialNo, financialYear, quarter, depotId?}} params
 * @returns {object} { reset: true, materialNo, financialYear, quarter }
 */
async function resetReplenishmentPlan({ materialNo, financialYear, quarter, depotId }) {
  await ReplenishmentPlan.deleteOne({ materialNo, financialYear, quarter, depotId: depotId || "" });
  return { reset: true, materialNo, financialYear, quarter };
}

/**
 * Apply the given percentage distribution to ALL applicable materials for the
 * current financial year and quarter. Backend is the source of truth: it
 * resolves the scope (all active, non-discontinued materials), computes each
 * material's requiredStock from live planDemand − currentStock, applies the
 * percentages, validates, and persists each as a MANUAL plan.
 *
 * @param {{financialYear: string, distribution: Array<{month: string, percentage: number, source?: string}>, updatedBy?: string}} params
 * @returns {{saved: number, affected: number, results: [{materialNo: string, status: string, error?: string, requiredStock?: number}]}}
 */
async function applyToAllReplenishmentPlan({ financialYear, distribution, updatedBy }) {
  const results = [];
  let savedCount = 0;

  if (!Array.isArray(distribution) || distribution.length === 0) {
    return { saved: 0, affected: 0, results: [{ materialNo: "N/A", status: "skipped", error: "distribution must be a non-empty array." }] };
  }

  // Backend resolves working quarter from the clock — never trusts the client.
  const now = new Date();
  const activeFyStart = currentFinancialYearStart(now);
  const activeFyLabel = finYearLabel(activeFyStart);
  const activeMonth = CALENDAR_MONTHS[now.getMonth()] || "January";
  const workingQuarter = QUARTER_BY_MONTH[activeMonth] || "Q1";

  // Load all active, non-discontinued materials (same scope as Planning Master).
  const materials = await Material.find({ isActive: true, status: { $ne: "Discontinued" } }).sort("materialNo").lean();
  if (materials.length === 0) {
    return { saved: 0, affected: 0, results: [] };
  }

  // Load stock, sales, and forecast data in parallel.
  const [stockRows, salesRows, mlPredictionRows] = await Promise.all([
    Stock.find({}).select("MatNo TotalStockQty").lean(),
    Sales.aggregate([
      { $group: { _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter", Month: "$Month" }, qty: { $sum: "$SalesQty" } } },
    ]),
    ForecastPredictions.find({ financialYear: activeFyLabel }).lean(),
  ]);

  // Build lookup maps (same pattern as buildPlanningView).
  const stockByMat = {};
  stockRows.forEach((s) => {
    const key = String(s.MatNo || "").trim().toUpperCase();
    if (!key) return;
    stockByMat[key] = (stockByMat[key] || 0) + (Number(s.TotalStockQty) || 0);
  });

  const monthlyByMat = {};
  salesRows.forEach((s) => {
    const key = String(s._id.MatNo || "").trim().toUpperCase();
    const year = finYearStartCalendarYear(s._id.FinancialYear);
    const quarter = s._id.Quarter;
    const month = s._id.Month;
    if (!key || year === null || !QUARTERS.includes(quarter) || !month) return;
    if (!monthlyByMat[key]) monthlyByMat[key] = {};
    if (!monthlyByMat[key][year]) monthlyByMat[key][year] = {};
    if (!monthlyByMat[key][year][quarter]) monthlyByMat[key][year][quarter] = {};
    monthlyByMat[key][year][quarter][month] = (monthlyByMat[key][year][quarter][month] || 0) + (Number(s.qty) || 0);
  });

  const forecastByMatMonth = {};
  mlPredictionRows.forEach((p) => {
    const key = String(p.materialNo || "").trim().toUpperCase();
    if (!key) return;
    if (!forecastByMatMonth[key]) forecastByMatMonth[key] = {};
    const monthKey = `${p.financialYear}|${p.month}`;
    if (!forecastByMatMonth[key][monthKey]) forecastByMatMonth[key][monthKey] = [];
    forecastByMatMonth[key][monthKey].push(p);
  });

  // Source percentages from the drawer distribution.
  const percentages = distribution.map((d) => d.percentage);
  const monthNames = distribution.map((d) => d.month);

  // Iterate through all applicable materials.
  for (const m of materials) {
    const key = m.materialNo;
    const currentStock = stockByMat[key] || 0;

    // Build the working quarter's monthly actuals + forecast for planDemand.
    const activeMonthData = (monthlyByMat[key] || {})[activeFyStart] || {};
    const materialForecast = forecastByMatMonth[key] || {};
    const activeQuarterResult = buildActiveQuarter({
      quarter: workingQuarter,
      monthlyActuals: activeMonthData[workingQuarter] || {},
      forecastByMonth: materialForecast,
      activeFyStart,
      activeFyLabel,
      now,
      historicalForThisQuarter: [],
    });
    const planDemand = activeQuarterResult.qty;
    const requiredStock = Math.max(0, planDemand - currentStock);

    // Apply distribution percentages to compute per-month quantities.
    const quantities = computeAllocation(requiredStock, percentages);
    const entries = monthNames.map((month, i) => ({
      month,
      percentage: percentages[i],
      quantity: Number.isFinite(quantities[i]) ? quantities[i] : 0,
      source: distribution[i]?.source || "none",
    }));

    // Validate the resulting distribution.
    const v = validateDistribution(entries, requiredStock);
    if (!v.valid) {
      results.push({ materialNo: key, status: "skipped", error: v.error, requiredStock });
      continue;
    }

    // Persist as a MANUAL plan.
    try {
      const filter = { materialNo: key, financialYear, quarter: workingQuarter, depotId: "" };
      const update = {
        requiredStock,
        distributionMode: "MANUAL",
        distribution: entries,
        updatedBy: updatedBy || "",
      };
      await ReplenishmentPlan.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true });
      savedCount++;
      results.push({ materialNo: key, status: "saved", requiredStock });
    } catch (err) {
      results.push({ materialNo: key, status: "error", error: err.message, requiredStock });
    }
  }

  return { saved: savedCount, affected: results.length, results };
}

module.exports = { buildPlanningView, buildPlanSeries, buildActiveQuarter, getAvailableStartYears, finYearLabel, saveReplenishmentPlan, loadReplenishmentPlan, resetReplenishmentPlan, applyToAllReplenishmentPlan };