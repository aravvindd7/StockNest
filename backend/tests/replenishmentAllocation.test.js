/**
 * Monthly Replenishment Allocation — unit tests.
 *
 * Covers the allocation utility (utils/replenishmentAllocation.js):
 * largest-remainder integer allocation, default equal split, validation
 * rules, and quantity/percentage invariants. 22 test cases.
 *
 * The key invariant every case checks: allocated quantities ALWAYS sum
 * exactly to the Required Stock, and percentages ALWAYS sum to 100%.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAllocation,
  computeDefaultAllocation,
  validateDistribution,
  REQUIRED_STOCK_MONTHS,
  WORKING_QUARTER_MONTHS,
} = require("../utils/replenishmentAllocation");

const sum = (a) => a.reduce((s, v) => s + v, 0);

// ─── Compute allocation: largest-remainder integer distribution ─────────────

test("1. business example: 191 units at 20/40/40 → ~38/76/77 (sums exactly to 191)", () => {
  // 20% → 38.2 floors to 38 (its 0.2 remainder never wins a leftover unit
  // against the two 0.4 remainders); the two 40% months floor to 76 each and
  // the single leftover unit lands deterministically on one of them (tie →
  // first in array → August), yielding 38/77/76 — the spec's ~38/76/77.
  const q = computeAllocation(191, [20, 40, 40]);
  assert.equal(sum(q), 191);
  assert.equal(q[0], 38);
  assert.deepEqual(q.slice(1).sort((a, b) => a - b), [76, 77]);
});

test("2. even split of an odd total keeps the exact sum (largest-remainder)", () => {
  // 191 × 33.33/33.34 → floors 63+63+63 = 189, remainder 2 goes to the
  // largest fractional parts → one 63 and two 64s, summing to 191.
  const q = computeAllocation(191, [33.33, 33.33, 33.34]);
  assert.equal(sum(q), 191);
  assert.deepEqual(q.slice().sort((a, b) => a - b), [63, 64, 64]);
});

test("3. even total divides exactly with no remainder", () => {
  const q = computeAllocation(300, [50, 50, 0]);
  assert.deepEqual(q, [150, 150, 0]);
  assert.equal(sum(q), 300);
});

test("4. 100/0/0 puts everything in the first month", () => {
  const q = computeAllocation(839, [100, 0, 0]);
  assert.deepEqual(q, [839, 0, 0]);
  assert.equal(sum(q), 839);
});

test("5. two-zero split: 0/0/100 puts everything in the last month", () => {
  const q = computeAllocation(50, [0, 0, 100]);
  assert.deepEqual(q, [0, 0, 50]);
  assert.equal(sum(q), 50);
});

test("6. zero required stock → all zeros regardless of percentages", () => {
  const q = computeAllocation(0, [20, 40, 40]);
  assert.deepEqual(q, [0, 0, 0]);
  assert.equal(sum(q), 0);
});

test("7. small required stock with skewed split degrades gracefully", () => {
  // 5 × 20/40/40 → 1 + 2 + 2 = 5 (all integer, no remainder).
  assert.deepEqual(computeAllocation(5, [20, 40, 40]), [1, 2, 2]);
  // 1 × 20/40/40 → 0.2/0.4/0.4 floors to 0+0+0, and the single leftover unit
  // goes to the largest remainder (ties → first in array → the first 40%).
  const tiny = computeAllocation(1, [20, 40, 40]);
  assert.equal(sum(tiny), 1);
  assert.equal(tiny.filter((v) => v > 0).length, 1); // exactly one month gets it
  assert.ok(tiny.every((v) => Number.isInteger(v) && v >= 0));
});

test("8. fractional percentages (33.33/33.33/33.34) still sum exactly", () => {
  const pct = [33.33, 33.33, 33.34];
  assert.ok(Math.abs(pct.reduce((a, b) => a + b, 0) - 100) < 0.01);
  const q = computeAllocation(1000, pct);
  assert.equal(sum(q), 1000);
});

test("9. invalid requiredStock (negative/NaN/Infinity) → all zeros, never NaN", () => {
  for (const bad of [-5, NaN, Infinity, "abc", null, undefined]) {
    const q = computeAllocation(bad, [20, 40, 40]);
    assert.equal(sum(q), 0); // all zeros
    assert.ok(q.every((v) => Number.isFinite(v)));
  }
});

test("10. invariant: quantities always sum to requiredStock for many splits", () => {
  const requiredByCase = [1, 7, 12, 191, 300, 839, 1234];
  const splits = [
    [20, 40, 40],
    [33.33, 33.33, 33.34],
    [100, 0, 0],
    [50, 30, 20],
    [70, 20, 10],
    [1, 98, 1],
  ];
  for (const req of requiredByCase) {
    for (const split of splits) {
      const q = computeAllocation(req, split);
      assert.equal(sum(q), req, `requiredStock ${req} with ${split.join("/")}`);
      assert.ok(q.every((v) => Number.isInteger(v) && v >= 0 && Number.isFinite(v)));
    }
  }
});

// ─── Default allocation: 33.33 / 33.33 / 33.34 ──────────────────────────────

test("11. default allocation for Q2 months is July/Aug/September at 33.33/33.33/33.34", () => {
  const def = computeDefaultAllocation("Q2", 191);
  assert.deepEqual(def.map((m) => m.month), ["July", "August", "September"]);
  assert.ok(Math.abs(sum(def.map((m) => m.percentage)) - 100) < 0.01);
  assert.equal(sum(def.map((m) => m.quantity)), 191);
  // 191 ÷ 3 ≈ 63.67 → all months land in the 63–64 band.
  def.forEach((m) => assert.ok(m.quantity === 63 || m.quantity === 64));
  assert.deepEqual(def.map((m) => m.quantity).sort((a, b) => a - b), [63, 64, 64]);
});

test("12. all four working quarters produce their own three months", () => {
  assert.deepEqual(computeDefaultAllocation("Q1", 90).map((m) => m.month), ["April", "May", "June"]);
  assert.deepEqual(computeDefaultAllocation("Q3", 90).map((m) => m.month), ["October", "November", "December"]);
  assert.deepEqual(computeDefaultAllocation("Q4", 90).map((m) => m.month), ["January", "February", "March"]);
});

test("13. default allocation with zero required stock → all zero quantities, 100% split", () => {
  const def = computeDefaultAllocation("Q2", 0);
  assert.ok(Math.abs(sum(def.map((m) => m.percentage)) - 100) < 0.01);
  assert.equal(sum(def.map((m) => m.quantity)), 0);
});

test("14. unknown quarter → empty default allocation (no fabrication)", () => {
  assert.deepEqual(computeDefaultAllocation("Q5", 100), []);
});

// ─── Validation ─────────────────────────────────────────────────────────────

test("15. valid distribution (percentages sum 100, quantities sum requiredStock) passes", () => {
  const dist = [
    { month: "July", percentage: 20, quantity: 38 },
    { month: "August", percentage: 40, quantity: 76 },
    { month: "September", percentage: 40, quantity: 77 },
  ];
  assert.deepEqual(validateDistribution(dist, 191), { valid: true });
});

test("16. percentages not summing to 100 → rejected with message", () => {
  const dist = [
    { month: "July", percentage: 20, quantity: 38 },
    { month: "August", percentage: 30, quantity: 57 },
    { month: "September", percentage: 40, quantity: 77 },
  ];
  const r = validateDistribution(dist, 191);
  assert.equal(r.valid, false);
  assert.match(r.error, /sum to/);
});

test("17. a percentage below 0 or above 100 → rejected", () => {
  const badNegative = [
    { month: "July", percentage: -5, quantity: 0 },
    { month: "August", percentage: 105, quantity: 100 },
    { month: "September", percentage: 0, quantity: 0 },
  ];
  assert.equal(validateDistribution(badNegative, 100).valid, false);
});

test("18. NaN/Infinity percentage or quantity → rejected (no silent NaN)", () => {
  const nanPct = [
    { month: "July", percentage: NaN, quantity: 0 },
    { month: "August", percentage: 50, quantity: 50 },
    { month: "September", percentage: 50, quantity: 50 },
  ];
  assert.equal(validateDistribution(nanPct, 100).valid, false);

  const infQty = [
    { month: "July", percentage: 33.34, quantity: Infinity },
    { month: "August", percentage: 33.33, quantity: 33 },
    { month: "September", percentage: 33.33, quantity: 33 },
  ];
  assert.equal(validateDistribution(infQty, 100).valid, false);
});

test("19. quantities not summing to requiredStock → rejected", () => {
  const dist = [
    { month: "July", percentage: 20, quantity: 38 },
    { month: "August", percentage: 40, quantity: 76 },
    { month: "September", percentage: 40, quantity: 78 }, // 76.4 should floor to 76
  ];
  const r = validateDistribution(dist, 191);
  assert.equal(r.valid, false);
  assert.match(r.error, /sum to/);
});

test("20. empty distribution → rejected", () => {
  const r = validateDistribution([], 191);
  assert.equal(r.valid, false);
  assert.match(r.error, /non-empty/);
});

test("21. invalid month name → rejected", () => {
  const dist = [
    { month: "July", percentage: 20, quantity: 38 },
    { month: "NotAMonth", percentage: 40, quantity: 76 },
    { month: "September", percentage: 40, quantity: 77 },
  ];
  const r = validateDistribution(dist, 191);
  assert.equal(r.valid, false);
  assert.match(r.error, /Invalid month/);
});

// ─── Round-trip with the largest-remainder recompute (save path) ────────────

test("22. save path recompute produces a distributable document that validates", () => {
  const requiredStock = 191;
  const percentages = [20, 40, 40];
  const quantities = computeAllocation(requiredStock, percentages);
  const distribution = ["July", "August", "September"].map((month, i) => ({
    month,
    percentage: percentages[i],
    quantity: quantities[i],
    source: "forecast",
  }));
  assert.equal(sum(distribution.map((d) => d.quantity)), requiredStock);
  assert.equal(distribution[0].quantity, 38); // 20% share floors to 38
  assert.ok(distribution.every((d) => Number.isInteger(d.quantity) && Number.isFinite(d.percentage)));
  assert.ok(Math.abs(sum(distribution.map((d) => d.percentage)) - 100) < 0.01);
  assert.deepEqual(validateDistribution(distribution, requiredStock), { valid: true });
});

// Sanity for the constants used across the module.
test("constants: REQUIRED_STOCK_MONTHS and WORKING_QUARTER_MONTHS align", () => {
  assert.equal(REQUIRED_STOCK_MONTHS.length, 12);
  for (const q of ["Q1", "Q2", "Q3", "Q4"]) {
    assert.equal(WORKING_QUARTER_MONTHS[q].length, 3);
    WORKING_QUARTER_MONTHS[q].forEach((m) => assert.ok(REQUIRED_STOCK_MONTHS.includes(m)));
  }
});