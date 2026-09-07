/**
 * Week Coverage unit tests.
 *
 * Covers the calculator (utils/weekCoverage.js) and — at the pipeline seam —
 * the eligibility rules that feed it: only the FORECAST months of the
 * existing active rolling forecast (buildPlanSeries items with
 * `source === "forecast"`) contribute forecast demand; actual months never
 * leak in; a month that carries both representations is never double-counted.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { computeWeekCoverage, weekCoverageStatus, daysInMonth } = require("../utils/weekCoverage");
const { buildPlanSeries, buildActiveQuarter } = require("../services/planningService");

function pred(month, fy, qty) {
  return { month, financialYear: fy, predictedSalesQty: qty, model: "XGBoost", confidence: 95, monthsAheadInHorizon: 1, horizonMonths: 7 };
}
function forecastMap(entries) {
  const map = {};
  entries.forEach(([fy, month, qty]) => { map[`${fy}|${month}`] = [pred(month, fy, qty)]; });
  return map;
}

// A deterministic 31-day month (October 2026) with avg weekly demand 70:
// qty 310 ÷ 31 days × 7 = 70/week.
const OCT = [{ month: "October", financialYear: "2026-27", qty: 310 }];

// ─── Thresholds / states (cases 1–11) ────────────────────────────────────────
test("1. current stock 0 → 0 weeks · Critical", () => {
  const r = computeWeekCoverage({ currentStock: 0, forecastMonths: OCT });
  assert.equal(r.state, "computed");
  assert.equal(r.weeks, 0);
  assert.equal(r.status, "CRITICAL");
  assert.equal(`${formatLikeFrontend(r)}`, "0 weeks · Critical");
});

test("2. coverage < 8 weeks → Critical", () => {
  const r = computeWeekCoverage({ currentStock: 420, forecastMonths: OCT }); // 420/70 = 6.0
  assert.equal(r.weeks, 6.0);
  assert.equal(r.status, "CRITICAL");
});

test("3. coverage exactly 8 weeks → Healthy", () => {
  const r = computeWeekCoverage({ currentStock: 560, forecastMonths: OCT }); // 560/70 = 8.0
  assert.equal(r.weeks, 8.0);
  assert.equal(r.status, "HEALTHY");
});

test("4. coverage between 8 and 16 weeks → Healthy", () => {
  const r = computeWeekCoverage({ currentStock: 784, forecastMonths: OCT }); // 784/70 = 11.2
  assert.equal(r.weeks, 11.2);
  assert.equal(r.status, "HEALTHY");
});

test("5. coverage exactly 16 weeks → Healthy", () => {
  const r = computeWeekCoverage({ currentStock: 1120, forecastMonths: OCT }); // 1120/70 = 16.0
  assert.equal(r.weeks, 16.0);
  assert.equal(r.status, "HEALTHY");
});

test("6. coverage > 16 weeks → High Stock", () => {
  const r = computeWeekCoverage({ currentStock: 1309, forecastMonths: OCT }); // 1309/70 = 18.7
  assert.equal(r.weeks, 18.7);
  assert.equal(r.status, "HIGH");
  assert.equal(`${formatLikeFrontend(r)}`, "18.7 weeks · High Stock");
});

test("7. forecast demand 0 → No forecast demand", () => {
  const r = computeWeekCoverage({ currentStock: 100, forecastMonths: [{ ...OCT[0], qty: 0 }] });
  assert.equal(r.state, "no_forecast_demand");
  // Even when currentStock is also 0, the zero-denominator condition wins.
  const bothZero = computeWeekCoverage({ currentStock: 0, forecastMonths: [{ ...OCT[0], qty: 0 }] });
  assert.equal(bothZero.state, "no_forecast_demand");
});

test("8. missing forecast → N/A · Insufficient Forecast", () => {
  const r = computeWeekCoverage({ currentStock: 100, forecastMonths: [] });
  assert.equal(r.state, "insufficient_forecast");
});

test("9. insufficient forecast (partial/invalid) → N/A · Insufficient Forecast", () => {
  const r = computeWeekCoverage({ currentStock: 100, forecastMonths: OCT.slice(0, 1) });
  // "Insufficient" is defined as no *usable* forecast set — here it is usable
  // but minimal; the explicit insufficient trigger is an invalid value. See next.
  assert.equal(r.state, "computed");
  const broken = computeWeekCoverage({ currentStock: 100, forecastMonths: [{ month: "October", financialYear: "2026-27", qty: NaN }] });
  assert.equal(broken.state, "insufficient_forecast");
});

test("10. invalid/null current stock → safe N/A state", () => {
  for (const bad of [null, undefined, NaN, "abc", -5, Infinity]) {
    const r = computeWeekCoverage({ currentStock: bad, forecastMonths: OCT });
    assert.equal(r.state, "invalid_stock");
    assert.equal(r.weeks, null);
    assert.equal(r.avgWeeklyForecastDemand, null);
  }
});

test("11. invalid/null forecast values → safe insufficient state", () => {
  for (const bad of [null, undefined, NaN, "abc", -1, Infinity]) {
    const r = computeWeekCoverage({ currentStock: 700, forecastMonths: [{ month: "October", financialYear: "2026-27", qty: bad }] });
    assert.equal(r.state, "insufficient_forecast");
  }
});

// ─── Day math (case 15) ──────────────────────────────────────────────────────
test("15. monthly forecast demand converted via real calendar days (spec example)", () => {
  // Month A = 300 over 31 days, B = 280 over 30, C = 320 over 31 → 900 / 92 × 7
  const months = [
    { month: "January", financialYear: "2026-27", qty: 300 },  // Jan 2027 = 31 days
    { month: "June", financialYear: "2026-27", qty: 280 },     // Jun 2026 = 30 days
    { month: "March", financialYear: "2026-27", qty: 320 },    // Mar 2027 = 31 days
  ];
  const expectedAvg = (900 / 92) * 7;
  const r = computeWeekCoverage({ currentStock: 692, forecastMonths: months });
  assert.equal(r.avgWeeklyForecastDemand, Math.round(expectedAvg * 100) / 100);
  assert.equal(r.state, "computed");
  // 692 ÷ 68.4783 = 10.1057 → 10.1 weeks, Healthy
  assert.equal(r.weeks, 10.1);
  assert.equal(r.status, "HEALTHY");
});

test("15b. leap year February has 29 days", () => {
  assert.equal(daysInMonth(2028, 1), 29); // Feb 2028 (leap)
  assert.equal(daysInMonth(2027, 1), 28); // Feb 2027 (common)
  assert.equal(daysInMonth(2026, 8), 30); // Sep 2026
});

// ─── Pipeline seam: eligibility from the active rolling forecast (12–14) ─────
test("12+13. actual months excluded, forecast months included", () => {
  const now = new Date(2026, 8, 7); // 7 Sep 2026
  const series = buildPlanSeries({
    workingQuarter: "Q2",
    activeFyStart: 2026,
    now,
    monthlyActualsByQuarter: { 2026: { Q2: { July: 289, August: 277 } } }, // actuals only Jul/Aug
    forecastByMonth: forecastMap([
      ["2026-27", "September", 273], ["2026-27", "October", 277], ["2026-27", "November", 273],
      ["2026-27", "December", 275], ["2026-27", "January", 271], ["2026-27", "February", 269],
      ["2026-27", "March", 269],
    ]),
  });
  // The caller filters to the forecast portion — exactly what planningService does.
  const forecastMonths = series.filter((m) => m.source === "forecast");

  assert.deepEqual(
    forecastMonths.map((m) => m.month),
    ["September", "October", "November", "December", "January", "February", "March"]
  );
  // The actual months (July/August) are NOT in the forecast-demand set.
  assert.ok(!forecastMonths.some((m) => m.month === "July" || m.month === "August"));

  // Recomputed by hand: 1907 units over 30+31+30+31+31+28+31 = 212 days.
  const totalQty = forecastMonths.reduce((s, m) => s + m.qty, 0);
  const days = [30, 31, 30, 31, 31, 28, 31].reduce((a, b) => a + b, 0);
  assert.equal(totalQty, 1907);
  assert.equal(days, 212);
  const r = computeWeekCoverage({ currentStock: 648, forecastMonths });
  assert.equal(r.avgWeeklyForecastDemand, Math.round((1907 / 212) * 7 * 100) / 100); // 62.97
  assert.ok(Math.abs(r.avgWeeklyForecastDemand - 62.97) < 0.01);
});

test("14. a month with both actual and forecast is not double-counted", () => {
  const now = new Date(2026, 8, 7);
  // September has BOTH a posted actual (140) and a stored forecast doc (273):
  // the classification resolves it to ACTUAL (real data wins), so the
  // forecast demand set excludes September entirely — it is never counted
  // twice and never as forecast.
  const series = buildPlanSeries({
    workingQuarter: "Q2",
    activeFyStart: 2026,
    now,
    monthlyActualsByQuarter: { 2026: { Q2: { July: 289, August: 277, September: 140 } } },
    forecastByMonth: forecastMap([
      ["2026-27", "September", 273], ["2026-27", "October", 277], ["2026-27", "November", 273],
      ["2026-27", "December", 275], ["2026-27", "January", 271], ["2026-27", "February", 269],
      ["2026-27", "March", 269],
    ]),
  });
  const q2 = buildActiveQuarter({
    quarter: "Q2",
    monthlyActuals: { July: 289, August: 277, September: 140 },
    forecastByMonth: forecastMap([["2026-27", "September", 273]]),
    activeFyStart: 2026,
    activeFyLabel: "2026-27",
    now,
    historicalForThisQuarter: [],
  });
  assert.equal(q2.monthly.find((m) => m.month === "September").source, "actual");

  const forecastMonths = series.filter((m) => m.source === "forecast");
  assert.ok(!forecastMonths.some((m) => m.month === "September")); // Sep dropped, not doubled
  const qty = forecastMonths.reduce((s, m) => s + m.qty, 0);
  assert.equal(qty, 277 + 273 + 275 + 271 + 269 + 269); // no 273 duplicate from Sep
});

// ─── MAT0001 (case 16) ───────────────────────────────────────────────────────
test("16. MAT0001 active rolling forecast → sensible Week Coverage", () => {
  const now = new Date(2026, 8, 7);
  const r = computeWeekCoverage({
    currentStock: 648,
    forecastMonths: [
      { month: "September", financialYear: "2026-27", qty: 273 },
      { month: "October", financialYear: "2026-27", qty: 277 },
      { month: "November", financialYear: "2026-27", qty: 273 },
      { month: "December", financialYear: "2026-27", qty: 275 },
      { month: "January", financialYear: "2026-27", qty: 271 },
      { month: "February", financialYear: "2026-27", qty: 269 },
      { month: "March", financialYear: "2026-27", qty: 269 },
    ],
  });
  assert.equal(r.state, "computed");
  assert.equal(r.weeks, 10.3); // 648 / ((1907/212)*7) = 10.29…
  assert.equal(r.status, "HEALTHY");
  assert.equal(`${formatLikeFrontend(r)}`, "10.3 weeks · Healthy");
});

// Mirrors the frontend badge formatter so these tests pin the exact display.
function formatLikeFrontend(r) {
  if (r.state !== "computed") return r.state;
  const label = { CRITICAL: "Critical", HEALTHY: "Healthy", HIGH: "High Stock" };
  return `${r.weeks === 0 ? "0" : r.weeks.toFixed(1)} weeks · ${label[r.status]}`;
}

// ─── Status classifier edges (case 17+ unchanged checks live in integration) ─
test("weekCoverageStatus edges", () => {
  assert.equal(weekCoverageStatus(7.99), "CRITICAL");
  assert.equal(weekCoverageStatus(8), "HEALTHY");
  assert.equal(weekCoverageStatus(16), "HEALTHY");
  assert.equal(weekCoverageStatus(16.01), "HIGH");
});