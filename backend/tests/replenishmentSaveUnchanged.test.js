/**
 * Save Allocation — only a real change is persisted.
 *
 * An untouched AUTO plan must stay AUTO (no MANUAL ReplenishmentPlan is
 * created) and an untouched MANUAL plan must not be rewritten. Changes are
 * detected semantically (month → percentage to 0.01%), independent of array
 * or property order. Apply to All keeps its explicit-override semantics.
 *
 * Uses mocked models (no database). Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ─── Fixture ────────────────────────────────────────────────────────────────
// "Now" = 15 Oct 2026 → FY 2026-27, working quarter Q3 (Oct/Nov/Dec). No Q3
// actuals, so all three months come from the forecast.
// MAT-A: stock 100, forecast 50 / 40 / 60 → planDemand 150, requiredStock 50.
// Depletion: 100→50→10→−50, so the live AUTO plan is 0% / 0% / 100%.
const MATERIALS = [{ materialNo: "MAT-A", description: "Alpha", isActive: true, status: "Active" }];
const STOCK = [{ MatNo: "MAT-A", TotalStockQty: 100 }];
const PREDICTIONS = [
  { materialNo: "MAT-A", financialYear: "2026-27", month: "October", predictedSalesQty: 50, model: "XGBoost" },
  { materialNo: "MAT-A", financialYear: "2026-27", month: "November", predictedSalesQty: 40, model: "XGBoost" },
  { materialNo: "MAT-A", financialYear: "2026-27", month: "December", predictedSalesQty: 60, model: "XGBoost" },
];

let savedPlan = null; // the one persisted ReplenishmentPlan (MAT-A / 2026-27 / Q3), or null
let writes = [];

function mockResult(doc) {
  const obj = { lean: () => Promise.resolve(doc) };
  obj.then = (resolve, reject) => Promise.resolve(doc).then(resolve, reject);
  return obj;
}

const ReplenishmentPlanMock = {
  find: () => ({ lean: () => Promise.resolve(savedPlan ? [savedPlan] : []) }),
  findOne: () => ({ lean: () => Promise.resolve(savedPlan) }),
  findOneAndUpdate: (filter, update) => {
    const doc = { ...filter, ...update, _id: `mock-${writes.length}` };
    writes.push(doc);
    if (filter.materialNo === "MAT-A") savedPlan = doc;
    return mockResult(doc);
  },
  deleteOne: () => { savedPlan = null; return Promise.resolve({ deletedCount: 1 }); },
};

const mockModules = {
  "../models/ForecastErrorStats": { find: () => ({ lean: async () => [] }) },
  "../models/Material": { find: () => ({ sort: () => ({ lean: () => Promise.resolve(MATERIALS) }) }) },
  "../models/Stock": { find: () => ({ select: () => ({ lean: () => Promise.resolve(STOCK) }) }) },
  "../models/Sales": { aggregate: () => Promise.resolve([]) },
  "../models/ForecastPredictions": { find: () => ({ lean: () => Promise.resolve(PREDICTIONS) }) },
  "../models/ReplenishmentPlan": ReplenishmentPlanMock,
};

// ─── Inject mocks + fixed clock (same pattern as applyToAllReplenishment.test.js) ──
const RealDate = Date;
const MOCK_NOW = new RealDate("2026-10-15T12:00:00Z");
class MockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(MOCK_NOW);
    super(...args);
  }
  static now() { return MOCK_NOW.getTime(); }
}

const Module = require("module");
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (mockModules[request]) return request;
  return originalResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain) {
  if (mockModules[request]) return mockModules[request];
  return originalLoad.call(this, request, parent, isMain);
};
globalThis.Date = MockDate;
delete require.cache[require.resolve("../services/planningService")];
const planning = require("../services/planningService");
Module._resolveFilename = originalResolve;
Module._load = originalLoad;

const { isSameAllocation } = require("../utils/replenishmentAllocation");

// ─── Helpers ────────────────────────────────────────────────────────────────
const dist = (oct, nov, dec) => [
  { month: "October", percentage: oct, source: "forecast" },
  { month: "November", percentage: nov, source: "forecast" },
  { month: "December", percentage: dec, source: "forecast" },
];
const save = (distribution, requiredStock = 50) =>
  planning.saveReplenishmentPlan({ materialNo: "MAT-A", financialYear: "2026-27", quarter: "Q3", requiredStock, distribution, updatedBy: "test" });
const activePlan = async () => (await planning.buildPlanningView({})).data.find((r) => r.materialNo === "MAT-A").replenishmentPlan;

test.beforeEach(() => {
  savedPlan = null;
  writes = [];
});

test("fixture: the live AUTO plan is 0 / 0 / 100 (stock-depletion engine unchanged)", async () => {
  const plan = await activePlan();
  assert.equal(plan.mode, "AUTO_FORECAST");
  assert.deepEqual(plan.distribution.map((d) => d.percentage), [0, 0, 100]);
  assert.deepEqual(plan.distribution.map((d) => d.quantity), [0, 0, 50]);
});

test("1. AUTO + Save without changes → no MANUAL plan created, row stays AUTO", async () => {
  const result = await save(dist(0, 0, 100));
  assert.equal(result.unchanged, true);
  assert.equal(result.distributionMode, "AUTO_FORECAST");
  assert.equal(writes.length, 0);
  assert.equal((await activePlan()).mode, "AUTO_FORECAST");
});

test("2. AUTO + real change (30/30/40) → MANUAL plan persisted and active", async () => {
  const result = await save(dist(30, 30, 40));
  assert.notEqual(result.unchanged, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].distributionMode, "MANUAL");
  assert.deepEqual(writes[0].distribution.map((d) => d.quantity), [15, 15, 20]);
  const plan = await activePlan();
  assert.equal(plan.mode, "MANUAL");
  assert.deepEqual(plan.distribution.map((d) => d.percentage), [30, 30, 40]);
});

test("3. MANUAL + Save without changes → existing plan not rewritten", async () => {
  await save(dist(20, 40, 40));
  const before = savedPlan;
  writes = [];
  const result = await save(dist(20, 40, 40));
  assert.equal(result.unchanged, true);
  assert.equal(result.distributionMode, "MANUAL");
  assert.equal(writes.length, 0);
  assert.equal(savedPlan, before);
});

test("4. MANUAL + real change → saved exactly as before (still MANUAL)", async () => {
  await save(dist(20, 40, 40));
  writes = [];
  const result = await save(dist(10, 40, 50));
  assert.notEqual(result.unchanged, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].distributionMode, "MANUAL");
  assert.deepEqual(writes[0].distribution.map((d) => [d.month, d.percentage, d.quantity]), [["October", 10, 5], ["November", 40, 20], ["December", 50, 25]]);
});

test("5. same allocation in a different month/property order (and float noise) → unchanged", async () => {
  const reordered = [
    { source: "forecast", percentage: 99.999999999, month: "December" },
    { percentage: 0.000000001, month: "October", source: "forecast" },
    { month: "November", source: "forecast", percentage: 0 },
  ];
  assert.equal(isSameAllocation(reordered, dist(0, 0, 100)), true);
  const result = await save(reordered);
  assert.equal(result.unchanged, true);
  assert.equal(writes.length, 0);
});

test("6. allocation changed by one unit → treated as a change and saved", async () => {
  // 2% of 50 = 1 unit moved from December to October.
  assert.equal(isSameAllocation(dist(2, 0, 98), dist(0, 0, 100)), false);
  const result = await save(dist(2, 0, 98));
  assert.notEqual(result.unchanged, true);
  assert.deepEqual(writes[0].distribution.map((d) => d.quantity), [1, 0, 49]);
  // The editor's smallest step (0.01%) is also a change.
  assert.equal(isSameAllocation(dist(0.01, 0, 99.99), dist(0, 0, 100)), false);
});

test("7. Reset to AUTO, then Save without changes → no MANUAL plan", async () => {
  await save(dist(30, 30, 40));
  assert.equal((await activePlan()).mode, "MANUAL");
  await planning.resetReplenishmentPlan({ materialNo: "MAT-A", financialYear: "2026-27", quarter: "Q3" });
  const auto = await activePlan();
  assert.equal(auto.mode, "AUTO_FORECAST");
  writes = [];
  const result = await save(auto.distribution);
  assert.equal(result.unchanged, true);
  assert.equal(writes.length, 0);
  assert.equal((await activePlan()).mode, "AUTO_FORECAST");
});

test("8. existing validation still rejects invalid allocations (before any change check)", async () => {
  for (const bad of [dist(30, 30, 39), dist(-10, 10, 100), dist(0, 0, 101)]) {
    await assert.rejects(save(bad), (err) => err.validation === true);
  }
  assert.equal(writes.length, 0);
});

test("9. Apply to All is unchanged: explicit override persists MANUAL even when equal to AUTO", async () => {
  const result = await planning.applyToAllReplenishmentPlan({ financialYear: "2026-27", distribution: dist(0, 0, 100), updatedBy: "test" });
  assert.equal(result.saved, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].distributionMode, "MANUAL");
});

test("10. a save for a non-live quarter is never compared against AUTO (persists as before)", async () => {
  const result = await planning.saveReplenishmentPlan({ materialNo: "MAT-A", financialYear: "2026-27", quarter: "Q2", requiredStock: 50, distribution: [
    { month: "July", percentage: 0, source: "actual" }, { month: "August", percentage: 0, source: "actual" }, { month: "September", percentage: 100, source: "actual" },
  ] });
  assert.notEqual(result.unchanged, true);
  assert.equal(writes.length, 1);
});

test("isSameAllocation: malformed input is never 'the same'", () => {
  const ok = dist(0, 0, 100);
  assert.equal(isSameAllocation(ok, ok), true);
  assert.equal(isSameAllocation(null, ok), false);
  assert.equal(isSameAllocation([], []), false);
  assert.equal(isSameAllocation(dist(NaN, 0, 100), ok), false);
  assert.equal(isSameAllocation(ok.slice(0, 2), ok), false);
  assert.equal(isSameAllocation([...ok.slice(0, 2), { month: "October", percentage: 100 }], ok), false, "duplicate month");
  assert.equal(isSameAllocation(dist(33.33, 33.33, 33.34), dist(33.33, 33.33, 33.34)), true);
});

test("frontend drawer comparison mirrors the backend exactly", async () => {
  const url = pathToFileURL(path.join(__dirname, "../../frontend/src/components/replenishmentAllocation.js")).href;
  const { isSameAllocation: frontend } = await import(url);
  const cases = [
    [dist(0, 0, 100), dist(0, 0, 100)],
    [dist(0, 0, 100), [...dist(0, 0, 100)].reverse()],
    [dist(0, 0, 100), dist(2, 0, 98)],
    [dist(0, 0, 100), dist(0.01, 0, 99.99)],
    [dist(33.33, 33.33, 33.34), dist(33.333, 33.333, 33.334)],
    [dist(NaN, 0, 100), dist(0, 0, 100)],
    [dist(0, 0, 100), dist(0, 0, 100).slice(1)],
    [null, dist(0, 0, 100)],
  ];
  for (const [a, b] of cases) assert.equal(frontend(a, b), isSameAllocation(a, b), JSON.stringify([a, b]));
});
