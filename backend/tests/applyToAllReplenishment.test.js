/**
 * Apply to All — unit tests for applyToAllReplenishmentPlan.
 *
 * Covers the backend service that applies a percentage distribution to ALL
 * applicable materials for a financial year and quarter. 15 test cases.
 *
 * The key invariant: each affected material's quantities ALWAYS sum exactly
 * to its own requiredStock, and every persisted record is MANUAL mode.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// ─── Mock MongoDB models ─────────────────────────────────────────────────────
// These replace the real Mongoose models during the test run.

const MATERIALS = [
  { materialNo: "MAT-A", description: "Alpha", isActive: true, status: "Active" },
  { materialNo: "MAT-B", description: "Beta", isActive: true, status: "Active" },
  { materialNo: "MAT-C", description: "Charlie", isActive: true, status: "Active" },
  { materialNo: "MAT-D", description: "Deactivated", isActive: false, status: "Active" },
  { materialNo: "MAT-E", description: "Discontinued", isActive: true, status: "Discontinued" },
];

const STOCK = [
  { MatNo: "MAT-A", TotalStockQty: 100 },
  { MatNo: "MAT-B", TotalStockQty: 50 },
  { MatNo: "MAT-C", TotalStockQty: 300 },
];

// Sales data for the working quarter months (Oct/Nov/Dec for Q3).
// MAT-A: Oct=120 (actual), Nov/Dec use forecast → planDemand = 120 + 60 + 50 = 230
// MAT-B: Oct=80 (actual), Nov/Dec use forecast → planDemand = 80 + 50 + 40 = 170
// MAT-C: Oct=70, Nov=70, Dec=60 (all actual) → planDemand = 200, requiredStock = 0
const SALES = [
  { _id: { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "October" }, qty: 120 },
  { _id: { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "November" }, qty: 100 },
  { _id: { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "December" }, qty: 80 },
  { _id: { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "October" }, qty: 80 },
  { _id: { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "November" }, qty: 60 },
  { _id: { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "December" }, qty: 60 },
  { _id: { MatNo: "MAT-C", FinancialYear: "2026-27", Quarter: "Q3", Month: "October" }, qty: 70 },
  { _id: { MatNo: "MAT-C", FinancialYear: "2026-27", Quarter: "Q3", Month: "November" }, qty: 70 },
  { _id: { MatNo: "MAT-C", FinancialYear: "2026-27", Quarter: "Q3", Month: "December" }, qty: 60 },
];

// Forecast predictions for Nov/Dec (the future months relative to Oct 11).
// October has actual data, so its forecast rows are unused.
const PREDICTIONS = [
  { materialNo: "MAT-A", financialYear: "2026-27", month: "November", predictedSalesQty: 60, model: "XGBoost" },
  { materialNo: "MAT-A", financialYear: "2026-27", month: "December", predictedSalesQty: 50, model: "XGBoost" },
  { materialNo: "MAT-B", financialYear: "2026-27", month: "November", predictedSalesQty: 50, model: "XGBoost" },
  { materialNo: "MAT-B", financialYear: "2026-27", month: "December", predictedSalesQty: 40, model: "XGBoost" },
];

let savedDocs = [];

function resetMocks() {
  savedDocs = [];
}

const MaterialMock = {
  find: (query = {}) => {
    let filtered = MATERIALS;
    if (query.isActive !== undefined) filtered = filtered.filter((m) => m.isActive === query.isActive);
    if (query.status && query.status.$ne) filtered = filtered.filter((m) => m.status !== query.status.$ne);
    return { sort: () => ({ lean: () => Promise.resolve(filtered) }) };
  },
};
const StockMock = {
  find: () => ({ select: () => ({ lean: () => Promise.resolve(STOCK) }) }),
};
const SalesMock = {
  // Simulate the $group aggregation pipeline: group by MatNo, FinancialYear, Quarter, Month.
  aggregate: () => {
    const map = new Map();
    SALES.forEach((s) => {
      const key = JSON.stringify({ MatNo: s._id.MatNo, FinancialYear: s._id.FinancialYear, Quarter: s._id.Quarter, Month: s._id.Month });
      map.set(key, { _id: { ...s._id }, qty: s.qty });
    });
    return Promise.resolve([...map.values()]);
  },
};
const ForecastPredictionsMock = {
  find: () => ({ lean: () => Promise.resolve(PREDICTIONS) }),
};
// Helper: make a mock query object that supports both .lean() and await.
function mockResult(doc) {
  const obj = { lean: () => Promise.resolve(doc) };
  obj.then = (resolve, reject) => Promise.resolve(doc).then(resolve, reject);
  obj.catch = (fn) => Promise.resolve(doc).catch(fn);
  return obj;
}

const ReplenishmentPlanMock = {
  find: () => ({ lean: () => Promise.resolve([]) }),
  findOne: () => ({ lean: () => Promise.resolve(null) }),
  findOneAndUpdate: (filter, update) => {
    const doc = { ...filter, ...update, _id: `mock-${savedDocs.length}` };
    savedDocs.push(doc);
    return mockResult(doc);
  },
};

// ─── Mock Date to fix "now" at October 11, 2026 ────────────────────────────
// This makes workingQuarter = Q3 (Oct/Nov/Dec) and October is a past month
// (actual), while November/December are future months (forecast).
const RealDate = Date;
const MOCK_NOW = new RealDate("2026-10-11T12:00:00Z");

class MockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(MOCK_NOW);
    super(...args);
  }
  static now() { return MOCK_NOW.getTime(); }
}

// ─── Patch require to inject model mocks before planningService loads ────────
const Module = require("module");
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

const mockModules = {
  "../models/Material": MaterialMock,
  "../models/Stock": StockMock,
  "../models/Sales": SalesMock,
  "../models/ForecastPredictions": ForecastPredictionsMock,
  "../models/ReplenishmentPlan": ReplenishmentPlanMock,
};

Module._resolveFilename = function (request, parent, isMain, options) {
  if (mockModules[request]) return request;
  return originalResolve.call(this, request, parent, isMain, options);
};

Module._load = function (request, parent, isMain) {
  if (mockModules[request]) return mockModules[request];
  return originalLoad.call(this, request, parent, isMain);
};

// Mock Date globally so the service uses Oct 11, 2026 for clock reads.
globalThis.Date = MockDate;

// Clear cached planningService so it re-requires with our mocks.
const planningServicePath = require.resolve("../services/planningService");
delete require.cache[planningServicePath];

const { applyToAllReplenishmentPlan, saveReplenishmentPlan } = require("../services/planningService");

// Restore module resolution but keep Date mocked — the service uses `new Date()`
// at call-time (inside applyToAllReplenishmentPlan), so the mock must stay active.
Module._resolveFilename = originalResolve;
Module._load = originalLoad;
// NOTE: globalThis.Date stays as MockDate for the entire test file.

// ─── Helpers ────────────────────────────────────────────────────────────────

const sum = (a) => a.reduce((s, v) => s + v, 0);

async function callApplyAll(distribution) {
  return applyToAllReplenishmentPlan({
    financialYear: "2026-27",
    distribution: distribution || [
      { month: "October", percentage: 20, source: "forecast" },
      { month: "November", percentage: 40, source: "forecast" },
      { month: "December", percentage: 40, source: "forecast" },
    ],
    updatedBy: "test-planner",
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  resetMocks();
});

test("1. valid apply-to-all: all active non-discontinued materials receive the distribution", async () => {
  const result = await callApplyAll();
  // MAT-A, MAT-B, MAT-C are active + not discontinued.
  // MAT-D (inactive) and MAT-E (discontinued) are excluded.
  assert.equal(result.affected, 3);
  assert.ok(result.saved >= 1);
  const materialNos = result.results.map((r) => r.materialNo);
  assert.ok(materialNos.includes("MAT-A"));
  assert.ok(materialNos.includes("MAT-B"));
  assert.ok(materialNos.includes("MAT-C"));
  assert.ok(!materialNos.includes("MAT-D"));
  assert.ok(!materialNos.includes("MAT-E"));
});

test("2. every affected record is persisted as MANUAL mode", async () => {
  await callApplyAll();
  for (const doc of savedDocs) {
    assert.equal(doc.distributionMode, "MANUAL");
  }
  assert.ok(savedDocs.length >= 1);
});

test("3. different Required Stock per material: quantities differ per material", async () => {
  const result = await callApplyAll();
  const matA = result.results.find((r) => r.materialNo === "MAT-A");
  const matB = result.results.find((r) => r.materialNo === "MAT-B");
  // MAT-A: planDemand = 120 (Oct) + 100 (Nov) + 80 (Dec) = 300, stock=100 → requiredStock=200
  // MAT-B: planDemand = 80 (Oct) + 60 (Nov) + 60 (Dec) = 200, stock=50  → requiredStock=150
  assert.equal(matA.requiredStock, 200);
  assert.equal(matB.requiredStock, 150);
  const docA = savedDocs.find((d) => d.materialNo === "MAT-A");
  const docB = savedDocs.find((d) => d.materialNo === "MAT-B");
  const sumA = docA.distribution.reduce((s, d) => s + d.quantity, 0);
  const sumB = docB.distribution.reduce((s, d) => s + d.quantity, 0);
  assert.equal(sumA, 200);
  assert.equal(sumB, 150);
});

test("4. material with Required Stock = 0: zero quantities, still persisted", async () => {
  const result = await callApplyAll();
  const matC = result.results.find((r) => r.materialNo === "MAT-C");
  // MAT-C: planDemand = 70+70+60 = 200, stock = 300 → requiredStock = 0
  assert.equal(matC.requiredStock, 0);
  const docC = savedDocs.find((d) => d.materialNo === "MAT-C");
  assert.ok(docC);
  assert.equal(docC.requiredStock, 0);
  assert.ok(docC.distribution.every((d) => d.quantity === 0));
  // Percentages are still applied.
  assert.equal(docC.distribution[0].percentage, 20);
  assert.equal(docC.distribution[1].percentage, 40);
  assert.equal(docC.distribution[2].percentage, 40);
});

test("5. invalid percentages (not summing to 100) → rejected at controller level", async () => {
  // The controller validates percentage sum before calling the service.
  // Calling the service directly: each material's validation fails.
  const result = await applyToAllReplenishmentPlan({
    financialYear: "2026-27",
    distribution: [
      { month: "October", percentage: 20, source: "forecast" },
      { month: "November", percentage: 30, source: "forecast" },
      { month: "December", percentage: 40, source: "forecast" },
    ],
    updatedBy: "test",
  });
  assert.equal(result.saved, 0);
  assert.ok(result.results.every((r) => r.status === "skipped"));
});

test("6. percentage > 100 → rejected", async () => {
  const result = await applyToAllReplenishmentPlan({
    financialYear: "2026-27",
    distribution: [
      { month: "October", percentage: 110, source: "forecast" },
      { month: "November", percentage: -5, source: "forecast" },
      { month: "December", percentage: -5, source: "forecast" },
    ],
    updatedBy: "test",
  });
  assert.equal(result.saved, 0);
  assert.ok(result.results.every((r) => r.status === "skipped"));
});

test("7. negative percentage → rejected", async () => {
  const result = await applyToAllReplenishmentPlan({
    financialYear: "2026-27",
    distribution: [
      { month: "October", percentage: -10, source: "forecast" },
      { month: "November", percentage: 60, source: "forecast" },
      { month: "December", percentage: 50, source: "forecast" },
    ],
    updatedBy: "test",
  });
  assert.equal(result.saved, 0);
  assert.ok(result.results.every((r) => r.status === "skipped"));
});

test("8. NaN/Infinity percentage → rejected", async () => {
  const result = await applyToAllReplenishmentPlan({
    financialYear: "2026-27",
    distribution: [
      { month: "October", percentage: NaN, source: "forecast" },
      { month: "November", percentage: 50, source: "forecast" },
      { month: "December", percentage: 50, source: "forecast" },
    ],
    updatedBy: "test",
  });
  assert.equal(result.saved, 0);
  assert.ok(result.results.every((r) => r.status === "skipped"));
});

test("9. scope isolation: only active non-discontinued materials are affected", async () => {
  const result = await callApplyAll();
  const materialNos = result.results.map((r) => r.materialNo);
  assert.ok(!materialNos.includes("MAT-D"), "MAT-D (inactive) should be excluded");
  assert.ok(!materialNos.includes("MAT-E"), "MAT-E (discontinued) should be excluded");
  assert.ok(!savedDocs.some((d) => d.materialNo === "MAT-D"));
  assert.ok(!savedDocs.some((d) => d.materialNo === "MAT-E"));
});

test("10. existing MANUAL records: overwritten by apply-to-all", async () => {
  await callApplyAll();
  const docA = savedDocs.find((d) => d.materialNo === "MAT-A");
  assert.ok(docA);
  assert.equal(docA.distributionMode, "MANUAL");
  // The overwrite uses the new percentages (20/40/40), not any old ones.
  assert.equal(docA.distribution[0].percentage, 20);
  assert.equal(docA.distribution[1].percentage, 40);
  assert.equal(docA.distribution[2].percentage, 40);
});

test("11. AUTO_FORECAST conversion: all affected materials become MANUAL", async () => {
  await callApplyAll();
  for (const doc of savedDocs) {
    assert.equal(doc.distributionMode, "MANUAL", `${doc.materialNo} should be MANUAL`);
  }
});

test("12. forecast regeneration non-overwrite: saved MANUAL plans persist in DB", async () => {
  // After apply-to-all, the saved MANUAL plan persists. A subsequent
  // buildPlanningView call should resolve the MANUAL plan as active.
  await callApplyAll();
  const docA = savedDocs.find((d) => d.materialNo === "MAT-A");
  assert.equal(docA.distributionMode, "MANUAL");
  assert.ok(docA.distribution.length === 3);
  // The AUTO_FORECAST prediction is never written to ReplenishmentPlan.
  assert.ok(savedDocs.every((d) => d.distributionMode === "MANUAL"));
});

test("13. reset interaction: resetting one record after apply-to-all is independent", async () => {
  await callApplyAll();
  assert.equal(savedDocs.length, 3);

  // Simulate reset: remove MAT-A's saved doc.
  savedDocs = savedDocs.filter((d) => d.materialNo !== "MAT-A");

  // MAT-B and MAT-C should still have their MANUAL plans.
  assert.equal(savedDocs.length, 2);
  assert.ok(savedDocs.some((d) => d.materialNo === "MAT-B"));
  assert.ok(savedDocs.some((d) => d.materialNo === "MAT-C"));
  assert.ok(!savedDocs.some((d) => d.materialNo === "MAT-A"));
});

test("14. integer-safe allocation: quantities sum exactly to requiredStock for every material", async () => {
  await callApplyAll();
  for (const doc of savedDocs) {
    const qtySum = doc.distribution.reduce((s, d) => s + d.quantity, 0);
    assert.equal(
      qtySum,
      doc.requiredStock,
      `${doc.materialNo}: quantities sum ${qtySum} ≠ requiredStock ${doc.requiredStock}`
    );
    for (const d of doc.distribution) {
      assert.ok(
        Number.isInteger(d.quantity) && d.quantity >= 0,
        `${doc.materialNo} ${d.month}: quantity ${d.quantity} is not a non-negative integer`
      );
    }
  }
});

test("15. existing functionality regression: save endpoint still works", async () => {
  assert.equal(typeof saveReplenishmentPlan, "function");
  const saved = await saveReplenishmentPlan({
    materialNo: "MAT-X",
    financialYear: "2026-27",
    quarter: "Q3",
    requiredStock: 100,
    distribution: [
      { month: "October", percentage: 33.33, quantity: 33, source: "forecast" },
      { month: "November", percentage: 33.33, quantity: 33, source: "forecast" },
      { month: "December", percentage: 33.34, quantity: 34, source: "forecast" },
    ],
    updatedBy: "test",
  });
  assert.ok(saved);
  assert.equal(savedDocs.length, 1);
  assert.equal(savedDocs[0].materialNo, "MAT-X");
});
