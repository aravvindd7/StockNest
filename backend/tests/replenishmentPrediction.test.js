/**
 * Forecast-Driven Replenishment Prediction — unit tests.
 *
 * Covers the automatic allocation engine (utils/replenishmentPrediction.js):
 * stock-depletion simulation, safe states, completed-month exclusion, integer-
 * safe quantities, and the active-plan resolver (AUTO_FORECAST vs MANUAL
 * override). The engine is a pure function of its inputs, so "recalculates
 * when the forecast changes" and "saved plan is never overwritten" are tested
 * at the deterministic boundary; the DB-persistence path is exercised in the
 * live verification.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { predictReplenishment, resolveActivePlan } = require("../utils/replenishmentPrediction");

const FY = 2026;
const FY_LABEL = "2026-27";

// Mid-quarter clock: September 9, 2026 → in Q2, only September is actionable
// (July/August are completed). Used for the MAT0001-style live regression.
const NOW_SEP = new Date(2026, 8, 9);
// Fresh-quarter clock: June 30, 2026 → all of Q2 (Jul/Aug/Sep) is actionable.
const NOW_JUN = new Date(2026, 5, 30);

const Q2 = [
  { month: "July", qty: 250, source: "actual" },
  { month: "August", qty: 250, source: "actual" },
  { month: "September", qty: 339, source: "forecast" },
];

const sum = (d) => d.reduce((s, x) => s + x.quantity, 0);
const pct = (d) => d.map((x) => x.percentage);
const MONTHS = { July: 0, August: 1, September: 2 };

function predict(overrides = {}) {
  return predictReplenishment({
    currentStock: 648,
    requiredStock: 191,
    quarter: "Q2",
    monthly: Q2,
    now: NOW_SEP,
    activeFyStart: FY,
    financialYear: FY_LABEL,
    ...overrides,
  });
}

// ─── Core business examples ──────────────────────────────────────────────────

test("1. Required Stock 0 → all-zero computed plan, mode AUTO_FORECAST", () => {
  const r = predict({ requiredStock: 0 });
  assert.equal(r.mode, "AUTO_FORECAST");
  assert.equal(r.state, "computed");
  assert.equal(sum(r.distribution), 0);
  assert.ok(pct(r.distribution).every((p) => p === 0));
  assert.deepEqual(r.shortageMonths, []);
});

test("2. Current Stock 0 → allocation driven by the first actionable shortage", () => {
  // No stock at all → the (mid-quarter) September forecast demand is the
  // first actionable shortage; July/August completed months get nothing.
  const r = predict({ currentStock: 0, requiredStock: 839 });
  assert.equal(r.state, "computed");
  assert.equal(r.distribution[2].percentage, 100);
  assert.equal(r.distribution[0].quantity, 0);
  assert.equal(r.distribution[1].quantity, 0);
  assert.equal(sum(r.distribution), 839);
});

test("3. one actionable month → 100% to it", () => {
  // Mid-quarter: only September is actionable, and it carries the only
  // shortage → 100% September.
  const r = predict();
  assert.equal(r.state, "computed");
  assert.deepEqual(r.shortageMonths, ["September"]);
  assert.deepEqual(pct(r.distribution), [0, 0, 100]);
  assert.equal(r.distribution[2].quantity, 191);
  assert.equal(sum(r.distribution), 191);
});

test("4. shortage only in the final month → 100% (spec §6: 648/250/250/339 → 0/0/100)", () => {
  // Fresh quarter (all months actionable): 648 → 398 → 148 → −191, the
  // shortage surfaces only in September.
  const r = predict({ now: NOW_JUN });
  assert.equal(r.state, "computed");
  assert.deepEqual(pct(r.distribution), [0, 0, 100]);
  assert.deepEqual(sum(r.distribution), 191);
  assert.deepEqual(r.distribution[2].quantity, 191);
});

test("5. shortage in two months → split by projected shortage (spec §7: 0/33.33/66.67)", () => {
  // stock 200, demand 100/200/200 → shortages 0/100/200 → 0/33.33/66.67,
  // qty 0/100/200 (sum exactly 300). Requires a fresh clock so Aug is a target.
  const r = predictReplenishment({
    currentStock: 200,
    requiredStock: 300,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 100, source: "forecast" },
      { month: "August", qty: 200, source: "forecast" },
      { month: "September", qty: 200, source: "forecast" },
    ],
    now: NOW_JUN,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "computed");
  assert.deepEqual(r.shortageMonths, ["August", "September"]);
  assert.ok(Math.abs(r.distribution[1].percentage - 33.33) < 0.01);
  assert.ok(Math.abs(r.distribution[2].percentage - 66.67) < 0.01);
  assert.deepEqual([r.distribution[1].quantity, r.distribution[2].quantity], [100, 200]);
  assert.equal(sum(r.distribution), 300);
});

test("6. multiple shortage months → proportional allocation sums exactly", () => {
  // stock 140, demand 100/200/200 → shortages 0/160/200 (Aug:Sep = 4:5).
  // Percentages follow the shortage ratio (44.44% / 55.56%); quantities are
  // largest-remainder over requiredStock and always sum exactly to it.
  const r = predictReplenishment({
    currentStock: 140,
    requiredStock: 180,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 100, source: "forecast" },
      { month: "August", qty: 200, source: "forecast" },
      { month: "September", qty: 200, source: "forecast" },
    ],
    now: NOW_JUN,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "computed");
  assert.equal(sum(r.distribution), 180);
  assert.equal(r.distribution[0].percentage, 0);
  // August:September = 160:200 = 4:5.
  const ratio = r.distribution[1].percentage / r.distribution[2].percentage;
  assert.ok(Math.abs(ratio - 0.8) < 0.001);
  assert.ok(Math.abs(r.distribution[1].percentage - 44.44) < 0.01);
  assert.ok(Math.abs(r.distribution[2].percentage - 55.56) < 0.01);
});

test("7. completed historical months are never replenishment targets", () => {
  // Mid-quarter: July/August completed. Even though current stock only
  // covers part of July, no stock is ever allocated to July/August — only
  // the actionable September.
  const r = predict();
  assert.equal(r.distribution[MONTHS.July].percentage, 0);
  assert.equal(r.distribution[MONTHS.August].percentage, 0);
  assert.equal(r.distribution[MONTHS.July].quantity, 0);
  assert.equal(r.distribution[MONTHS.August].quantity, 0);
});

test("8. actual demand is used once (never also as forecast — no double-count)", () => {
  // A month can only be actual OR forecast; the simulation consumes the
  // single classification. Providing a completed actual month with a large
  // value consumes stock exactly once (it cannot leak back in as a future
  // target because it is completed and excluded).
  const r = predictReplenishment({
    currentStock: 100,
    requiredStock: 400,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 300, source: "actual" }, // completed, large
      { month: "August", qty: 0, source: "actual" },
      { month: "September", qty: 200, source: "forecast" },
    ],
    now: NOW_SEP,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  // July consumes 100 of 100 stock (shortage 200 but July is completed →
  // excluded). September is actionable with a 200 shortage → 100% September.
  assert.equal(r.state, "computed");
  assert.equal(r.distribution[MONTHS.July].percentage, 0);
  assert.equal(r.distribution[MONTHS.September].percentage, 100);
  assert.equal(sum(r.distribution), 400);
});

test("9. forecast months drive the depletion (forecast qty consumed from monthly)", () => {
  // Fresh quarter, all forecast: the forecast quantities are what deplete
  // stock and determine the shortage months.
  const r = predictReplenishment({
    currentStock: 100,
    requiredStock: 200,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 0, source: "forecast" },
      { month: "August", qty: 0, source: "forecast" },
      { month: "September", qty: 300, source: "forecast" },
    ],
    now: NOW_JUN,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "computed");
  assert.deepEqual(r.shortageMonths, ["September"]);
  assert.equal(r.distribution[2].percentage, 100);
});

// ─── Safe states ─────────────────────────────────────────────────────────────

test("10. missing forecast → insufficient_forecast, no fabricated percentages", () => {
  const r = predictReplenishment({
    currentStock: 100,
    requiredStock: 50,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 0, source: "none" },
      { month: "August", qty: 0, source: "none" },
      { month: "September", qty: 0, source: "none" },
    ],
    now: NOW_SEP,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "insufficient_forecast");
  assert.deepEqual(r.distribution, []);
});

test("11. invalid demand (NaN/negative/Infinity) → safe insufficient_forecast", () => {
  for (const bad of [NaN, -5, Infinity]) {
    const r = predictReplenishment({
      currentStock: 100,
      requiredStock: 50,
      quarter: "Q2",
      monthly: [
        { month: "July", qty: 0, source: "none" },
        { month: "August", qty: 0, source: "none" },
        { month: "September", qty: bad, source: "forecast" },
      ],
      now: NOW_SEP,
      activeFyStart: FY,
      financialYear: FY_LABEL,
    });
    assert.equal(r.state, "insufficient_forecast");
    assert.deepEqual(r.distribution, []);
  }
});

test("12. invalid stock → safe invalid_stock, never a fabricated plan", () => {
  for (const bad of [-10, NaN, Infinity]) {
    const r = predict({ currentStock: bad });
    assert.equal(r.state, "invalid_stock");
    assert.deepEqual(r.distribution, []);
  }
});

test("13. no forecast demand (forecast present but sums to 0) → no_forecast_demand", () => {
  const r = predictReplenishment({
    currentStock: 100,
    requiredStock: 50,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 0, source: "none" },
      { month: "August", qty: 0, source: "none" },
      { month: "September", qty: 0, source: "forecast" },
    ],
    now: NOW_SEP,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "no_forecast_demand");
  assert.deepEqual(r.distribution, []);
});

// ─── Invariants ──────────────────────────────────────────────────────────────

test("14. quantities always sum exactly to requiredStock (largest-remainder reuse)", () => {
  for (const req of [1, 7, 100, 191, 300, 839, 1234]) {
    const r = predict({ requiredStock: req });
    assert.equal(sum(r.distribution), req, `requiredStock ${req}`);
    assert.ok(r.distribution.every((d) => Number.isInteger(d.quantity) && d.quantity >= 0));
  }
});

test("15. percentages sum to exactly ~100 in computed plans", () => {
  const cases = [predict({ now: NOW_JUN }), predict()];
  for (const r of cases) {
    const p = pct(r.distribution).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(p - 100) < 0.01);
  }
});

test("16. never emits NaN / Infinity / undefined anywhere", () => {
  const inputs = [
    { currentStock: 500, requiredStock: 191 },
    { currentStock: 0, requiredStock: 191 },
    { currentStock: 500, requiredStock: 0 },
    { currentStock: -1, requiredStock: 191 },
    { currentStock: 500, requiredStock: 191, monthly: [] },
    { currentStock: 500, requiredStock: 191, quarter: "Q9" },
    { currentStock: 648, requiredStock: 191, quarter: "Q2", monthly: Q2 },
  ];
  for (const o of inputs) {
    const r = predictReplenishment({ ...o, now: NOW_SEP, activeFyStart: FY, financialYear: FY_LABEL });
    assert.ok(Number.isFinite(r.requiredStock) || r.requiredStock === 0, `requiredStock ${r.requiredStock}`);
    r.distribution.forEach((d) => {
      assert.ok(Number.isFinite(d.percentage));
      assert.ok(Number.isFinite(d.quantity));
      assert.ok(Number.isInteger(d.quantity));
    });
  }
});

// ─── Recalculation / active-plan resolution ─────────────────────────────────

test("17. allocation recalculates when the forecast changes (pure function of inputs)", () => {
  const base = {
    currentStock: 200,
    requiredStock: 300,
    quarter: "Q2",
    now: NOW_JUN,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  };
  // Demand 100/200/200 → shortages 0/100/200 → 0% / 33.33% / 66.67%.
  const a = predictReplenishment({
    ...base,
    monthly: [
      { month: "July", qty: 100, source: "forecast" },
      { month: "August", qty: 200, source: "forecast" },
      { month: "September", qty: 200, source: "forecast" },
    ],
  });
  // Forecast regenerated lower (Sep 100) → shortages 0/100/100 → 0/50/50.
  const b = predictReplenishment({
    ...base,
    monthly: [
      { month: "July", qty: 100, source: "forecast" },
      { month: "August", qty: 200, source: "forecast" },
      { month: "September", qty: 100, source: "forecast" },
    ],
  });
  assert.ok(Math.abs(a.distribution[1].percentage - 33.33) < 0.01);
  assert.ok(Math.abs(a.distribution[2].percentage - 66.67) < 0.01);
  assert.ok(Math.abs(b.distribution[1].percentage - 50) < 0.01);
  assert.ok(Math.abs(b.distribution[2].percentage - 50) < 0.01);
  assert.notEqual(a.distribution[2].percentage, b.distribution[2].percentage);
});

test("18. AUTO plan carries mode AUTO_FORECAST and the explanation", () => {
  const r = predict();
  assert.equal(r.mode, "AUTO_FORECAST");
  assert.match(r.explanation, /XGBoost demand forecast/);
  assert.match(r.explanation, /projected stock depletion/);
});

test("19. saved MANUAL plan is NOT overwritten by a changed auto prediction", () => {
  const autoA = predict({ now: NOW_JUN }); // 0/0/100
  const autoB = predictReplenishment({
    currentStock: 648, requiredStock: 191, quarter: "Q2",
    monthly: [
      { month: "July", qty: 250, source: "actual" },
      { month: "August", qty: 250, source: "actual" },
      { month: "September", qty: 200, source: "forecast" },
    ],
    now: NOW_JUN, activeFyStart: FY, financialYear: FY_LABEL,
  }); // regenerated → different auto (52)
  const savedPlan = {
    financialYear: FY_LABEL,
    quarter: "Q2",
    distribution: [
      { month: "July", percentage: 20, quantity: 38, source: "actual" },
      { month: "August", percentage: 40, quantity: 76, source: "actual" },
      { month: "September", percentage: 40, quantity: 77, source: "forecast" },
    ],
  };
  // Even though the auto prediction changed, the saved MANUAL plan still wins.
  const active = resolveActivePlan({ savedPlan, autoPlan: autoB, requiredStock: 191, workingQuarter: "Q2" });
  assert.equal(active.mode, "MANUAL");
  assert.deepEqual(active.distribution.map((d) => d.percentage), [20, 40, 40]);
  assert.equal(sum(active.distribution), 191);
});

test("20. no saved plan → the latest AUTO allocation is the active plan (Reset target)", () => {
  const autoPlan = predict({ now: NOW_JUN });
  const active = resolveActivePlan({ savedPlan: null, autoPlan, requiredStock: 191, workingQuarter: "Q2" });
  assert.equal(active.mode, "AUTO_FORECAST");
  assert.deepEqual(active.distribution.map((d) => d.percentage), [0, 0, 100]);
});

test("21. saved MANUAL plan quantities recompute against CURRENT requiredStock", () => {
  const savedPlan = {
    financialYear: FY_LABEL,
    quarter: "Q2",
    distribution: [
      { month: "July", percentage: 20, quantity: 999, source: "actual" }, // stale snapshot
      { month: "August", percentage: 40, quantity: 999, source: "actual" },
      { month: "September", percentage: 40, quantity: 999, source: "forecast" },
    ],
  };
  const autoPlan = predict();
  const active = resolveActivePlan({ savedPlan, autoPlan, requiredStock: 191, workingQuarter: "Q2" });
  assert.equal(active.mode, "MANUAL");
  // 191 @ 20/40/40 → 38/77/76 (largest-remainder), sum exactly 191.
  assert.equal(sum(active.distribution), 191);
  assert.deepEqual(active.distribution.map((d) => d.quantity).sort((a, b) => a - b), [38, 76, 77]);
});

test("22. MAT0001 live-shape regression: 289/277/273 vs 648 → 0/0/100 qty 0/0/191", () => {
  const r = predictReplenishment({
    currentStock: 648,
    requiredStock: 191,
    quarter: "Q2",
    monthly: [
      { month: "July", qty: 289, source: "actual" },
      { month: "August", qty: 277, source: "actual" },
      { month: "September", qty: 273, source: "forecast" },
    ],
    now: NOW_SEP,
    activeFyStart: FY,
    financialYear: FY_LABEL,
  });
  assert.equal(r.state, "computed");
  assert.deepEqual(pct(r.distribution), [0, 0, 100]);
  assert.deepEqual(r.distribution.map((d) => d.quantity), [0, 0, 191]);
  assert.equal(sum(r.distribution), 191);
  assert.deepEqual(r.shortageMonths, ["September"]);
});
