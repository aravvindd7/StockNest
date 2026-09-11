/**
 * Actual-vs-forecast classification + rolling-horizon unit tests.
 *
 * These exercise the pure functions (no DB): buildActiveQuarter and
 * buildPlanSeries (backend/services/planningService.js) and
 * planForecastHorizonRange (backend/utils/forecastTargets.js). They pin the
 * data-driven semantics: a month is ACTUAL only when a real Sales Master
 * row exists for it; the CURRENT month with no posted actual reads FORECAST
 * (reusing the stored rolling prediction), never a fabricated "0 ACTUAL";
 * missing data/prediction reads NONE.
 *
 * Run with: `npm test` (or `node --test tests/`).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveQuarter, buildPlanSeries } = require("../services/planningService");
const { planForecastHorizonRange } = require("../utils/forecastTargets");

/** Minimal ForecastPredictions-shaped doc. */
function pred(month, fy, qty, opts = {}) {
  return {
    month,
    financialYear: fy,
    predictedSalesQty: qty,
    model: "XGBoost",
    modelVersion: "1.0",
    confidence: 95,
    confidenceTier: "HIGH",
    segmentWmape: 11.2,
    horizonAdjustedWmape: 12.5,
    historyMonths: 18,
    trend: "up",
    seasonality: "seasonal",
    monthsAheadInHorizon: 1,
    horizonMonths: 7,
    reason: "test",
    ...opts,
  };
}

/** [{fy, month, qty}] -> forecastByMonth keyed by "FY|month". */
function forecastMap(entries) {
  const map = {};
  entries.forEach(([fy, month, qty]) => {
    map[`${fy}|${month}`] = [pred(month, fy, qty)];
  });
  return map;
}

// ─── Scenario 1: current month with NO actual Sales data → FORECAST ─────────
test("current month with no actual data is FORECAST (buildActiveQuarter)", () => {
  const now = new Date(2026, 8, 7); // 7 Sep 2026
  const q2 = buildActiveQuarter({
    quarter: "Q2",
    monthlyActuals: { July: 289, August: 277 }, // no September row
    forecastByMonth: forecastMap([["2026-27", "September", 273]]),
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });

  assert.deepEqual(
    q2.monthly.map((m) => [m.month, m.qty, m.source]),
    [
      ["July", 289, "actual"],
      ["August", 277, "actual"],
      ["September", 273, "forecast"], // ← no longer "0 ACTUAL"
    ]
  );
  assert.equal(q2.mode, "forecast"); // mixed quarter
  assert.equal(q2.confidence, 95);
});

test("current month with no actual data is FORECAST (buildPlanSeries)", () => {
  const now = new Date(2026, 8, 7);
  const series = buildPlanSeries({
    workingQuarter: "Q2",
    activeFyStart: 2026,
    now,
    monthlyActualsByQuarter: { 2026: { Q2: { July: 289, August: 277 } } },
    forecastByMonth: forecastMap([
      ["2026-27", "September", 273],
      ["2026-27", "October", 277],
      ["2026-27", "November", 273],
      ["2026-27", "December", 275],
      ["2026-27", "January", 271],
      ["2026-27", "February", 269],
      ["2026-27", "March", 269],
    ]),
  });

  const sep = series.find((m) => m.month === "September");
  assert.equal(sep.source, "forecast");
  assert.equal(sep.qty, 273);
  assert.equal(series[0].source, "actual"); // July
  assert.equal(series[1].source, "actual"); // August
});

// ─── Scenario 2: current month WITH actual data → ACTUAL ────────────────────
test("current month with actual data is ACTUAL", () => {
  const now = new Date(2026, 8, 7);
  const q2 = buildActiveQuarter({
    quarter: "Q2",
    monthlyActuals: { July: 289, August: 277, September: 140 }, // Sept posted
    forecastByMonth: forecastMap([["2026-27", "September", 273]]),
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });

  const sep = q2.monthly.find((m) => m.month === "September");
  assert.equal(sep.source, "actual");
  assert.equal(sep.qty, 140);
  // No forecast month in Q2 anymore → quarter is not forecast-backed.
  assert.equal(q2.mode, "actual");
});

// ─── Scenario 3: future month with a stored prediction → FORECAST ───────────
test("future month with a stored prediction is FORECAST", () => {
  const now = new Date(2026, 8, 7);
  const q3 = buildActiveQuarter({
    quarter: "Q3",
    monthlyActuals: {}, // no actuals yet
    forecastByMonth: forecastMap([
      ["2026-27", "October", 277],
      ["2026-27", "November", 273],
      ["2026-27", "December", 275],
    ]),
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });

  assert.deepEqual(
    q3.monthly.map((m) => [m.month, m.source]),
    [
      ["October", "forecast"],
      ["November", "forecast"],
      ["December", "forecast"],
    ]
  );
  assert.equal(q3.mode, "forecast");
});

test("future month with NO prediction is NONE (never 0 ACTUAL)", () => {
  const now = new Date(2026, 8, 7);
  const q3 = buildActiveQuarter({
    quarter: "Q3",
    monthlyActuals: {},
    forecastByMonth: {}, // no predictions at all
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });
  assert.deepEqual(q3.monthly.map((m) => m.source), ["none", "none", "none"]);
});

// ─── Scenario 4: historical/completed month with actual → ACTUAL ────────────
test("historical (fully elapsed) month with actual data is ACTUAL", () => {
  const now = new Date(2026, 8, 7);
  const q1 = buildActiveQuarter({
    quarter: "Q1", // Apr–Jun 2026, all elapsed
    monthlyActuals: { April: 100, May: 110, June: 90 },
    forecastByMonth: {},
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });
  assert.deepEqual(q1.monthly.map((m) => m.source), ["actual", "actual", "actual"]);
  assert.equal(q1.mode, "actual");
});

test("completed month with NO actual is NONE, not 0 ACTUAL", () => {
  const now = new Date(2026, 8, 7);
  const q1 = buildActiveQuarter({
    quarter: "Q1",
    monthlyActuals: {}, // material simply has no Apr–Jun Sales rows
    forecastByMonth: {},
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });
  assert.deepEqual(q1.monthly.map((m) => m.source), ["none", "none", "none"]);
});

// ─── Scenario 5: Q2 2026-27 working quarter → Q3/Q4 horizon ─────────────────
test("Q2 2026-27 working quarter rolls into Q3/Q4 (same FY)", () => {
  const now = new Date(2026, 8, 7);
  const series = buildPlanSeries({
    workingQuarter: "Q2",
    activeFyStart: 2026,
    now,
    monthlyActualsByQuarter: { 2026: { Q2: { July: 289, August: 277 } } },
    forecastByMonth: forecastMap(
      ["September", "October", "November", "December", "January", "February", "March"].map((m) => ["2026-27", m, 270])
    ),
  });

  // Full current-quarter + next-2-quarters window = 9 months, Jul → Mar.
  assert.equal(series.length, 9);
  assert.equal(series[0].month, "July");
  assert.equal(series[8].month, "March");
  assert.equal(series[8].financialYear, "2026-27");
  assert.equal(series[8].quarter, "Q4");

  // ML horizon (from the latest actual month onward) = Sep 2026 → Mar 2027.
  const range = planForecastHorizonRange(now, "2026-27", "August");
  assert.equal(range.startMonth, "September");
  assert.equal(range.startFy, "2026-27");
  assert.equal(range.endMonth, "March");
  assert.equal(range.endFy, "2026-27");
  assert.equal(range.horizonMonths, 7);
});

// ─── Scenario 6: cross-FY — Q4 working quarter → Q1/Q2 of next FY ───────────
test("Q4 2026-27 working quarter crosses into Q1/Q2 2027-28", () => {
  const now = new Date(2027, 0, 15); // 15 Jan 2027 (Q4 of FY 2026-27)
  const series = buildPlanSeries({
    workingQuarter: "Q4",
    activeFyStart: 2026,
    now,
    monthlyActualsByQuarter: {},
    forecastByMonth: forecastMap([
      ["2026-27", "January", 271],
      ["2026-27", "February", 269],
      ["2026-27", "March", 269],
      ["2027-28", "April", 280],
      ["2027-28", "May", 282],
      ["2027-28", "June", 285],
      ["2027-28", "July", 288],
      ["2027-28", "August", 290],
      ["2027-28", "September", 292],
    ]),
  });

  // Q4 2026-27 (Jan–Mar) + Q1 2027-28 + Q2 2027-28 = 9 months.
  assert.equal(series.length, 9);
  assert.equal(series[0].month, "January");
  assert.equal(series[0].financialYear, "2026-27");
  assert.equal(series[8].month, "September");
  assert.equal(series[8].financialYear, "2027-28");
  assert.equal(series[8].quarter, "Q2");

  // ML horizon from the latest actual (Dec 2026) → end of Q2 2027-28 = Sep 2027.
  const range = planForecastHorizonRange(now, "2026-27", "December");
  assert.equal(range.startMonth, "January");
  assert.equal(range.startFy, "2026-27");
  assert.equal(range.endMonth, "September");
  assert.equal(range.endFy, "2027-28");
  assert.equal(range.horizonMonths, 9); // Jan–Sep 2027
});
