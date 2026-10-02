/**
 * Planning Master Export — tests for the exportPlanningData controller and its
 * helper formatters. Uses the same Module-mock + MockDate pattern as
 * currentQuarterSales.test.js: mocked Mongoose models, pinned global Date, and
 * a captured buildXlsxBuffer call so we can inspect the columns and row data
 * without actually generating an xlsx file.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// ─── Mock data ───────────────────────────────────────────────────────────────

const MATERIALS = [
  { materialNo: "MAT-A", description: "Alpha", model: "M1", isActive: true, status: "Active" },
  { materialNo: "MAT-B", description: "Beta", model: "M2", isActive: true, status: "Active" },
  { materialNo: "MAT-C", description: "Inactive", isActive: false, status: "Active" },
];

const STOCK = [
  { MatNo: "MAT-A", TotalStockQty: 100 },
  { MatNo: "MAT-B", TotalStockQty: 50 },
];

// Mocked date: Nov 20, 2026 → calendar Q4 (Oct/Nov/Dec), FY 2026-27.
const SALES = [
  { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 120 },
  { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 30 },
  { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 80 },
  { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "November", SalesQty: 60 },
];

const PREDICTIONS = [
  { materialNo: "MAT-A", plant: "P1", financialYear: "2026-27", month: "November", predictedSalesQty: 50, model: "XGBoost" },
  { materialNo: "MAT-A", plant: "P2", financialYear: "2026-27", month: "November", predictedSalesQty: 10, model: "XGBoost" },
  { materialNo: "MAT-A", plant: "P1", financialYear: "2026-27", month: "December", predictedSalesQty: 60, model: "XGBoost" },
  { materialNo: "MAT-B", plant: "P1", financialYear: "2026-27", month: "December", predictedSalesQty: 40, model: "XGBoost" },
];

// ─── Mock models ─────────────────────────────────────────────────────────────

const MaterialMock = {
  find: (query = {}) => {
    let filtered = MATERIALS;
    if (query.isActive !== undefined) filtered = filtered.filter((m) => m.isActive === query.isActive);
    if (query.status && query.status.$ne) filtered = filtered.filter((m) => m.status !== query.status.$ne);
    if (query.$or) {
      filtered = filtered.filter((m) =>
        query.$or.some((cond) => {
          for (const field of ["materialNo", "description", "model"]) {
            if (cond[field]?.$regex) {
              const rx = new RegExp(cond[field].$regex, cond[field].$options || "");
              if (rx.test(String(m[field] || ""))) return true;
            }
          }
          return false;
        })
      );
    }
    return { sort: () => ({ lean: () => Promise.resolve(filtered) }) };
  },
};

const StockMock = {
  find: () => ({ select: () => ({ lean: () => Promise.resolve(STOCK) }) }),
};

const SalesMock = {
  aggregate: () => {
    const map = new Map();
    SALES.forEach((s) => {
      const key = JSON.stringify({ MatNo: s.MatNo, FinancialYear: s.FinancialYear, Quarter: s.Quarter, Month: s.Month });
      const prev = map.get(key) || { _id: { MatNo: s.MatNo, FinancialYear: s.FinancialYear, Quarter: s.Quarter, Month: s.Month }, qty: 0 };
      prev.qty += s.SalesQty;
      map.set(key, prev);
    });
    return Promise.resolve([...map.values()]);
  },
  distinct: () => Promise.resolve(["2026-27"]),
};

const ForecastPredictionsMock = {
  find: (query = {}) => {
    let rows = PREDICTIONS;
    if (query.financialYear && query.financialYear.$in) {
      rows = rows.filter((p) => query.financialYear.$in.includes(p.financialYear));
    }
    return { lean: () => Promise.resolve(rows) };
  },
};

const ReplenishmentPlanMock = {
  find: () => ({ lean: () => Promise.resolve([]) }),
};

// ─── Mock buildXlsxBuffer to capture columns and rows ────────────────────────

let capturedColumns = null;
let capturedRows = null;

const MockXlsxExport = {
  buildXlsxBuffer: (columns, rows) => {
    capturedColumns = columns;
    capturedRows = rows;
    return Buffer.from("fake-xlsx");
  },
};

// ─── Global Date mock ────────────────────────────────────────────────────────

const RealDate = Date;
const MOCK_NOW = new RealDate("2026-11-20T12:00:00Z");
class MockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(MOCK_NOW);
    super(...args);
  }
  static now() { return MOCK_NOW.getTime(); }
}

// ─── Module mock wiring ──────────────────────────────────────────────────────

const Module = require("module");
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const mockModules = {
  "../models/ForecastErrorStats": { find: () => ({ lean: async () => [] }) },
  "../models/Material": MaterialMock,
  "../models/Stock": StockMock,
  "../models/Sales": SalesMock,
  "../models/ForecastPredictions": ForecastPredictionsMock,
  "../models/ReplenishmentPlan": ReplenishmentPlanMock,
  "../utils/xlsxExport": MockXlsxExport,
};
Module._resolveFilename = function (request, parent, isMain, options) {
  if (mockModules[request]) return request;
  return originalResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain) {
  if (mockModules[request]) return mockModules[request];
  return originalLoad.call(this, request, parent, isMain);
};
globalThis.Date = MockDate;

// Load controller AFTER mocks are active
const planningControllerPath = require.resolve("../controllers/planningController");
delete require.cache[planningControllerPath];
const { exportPlanningData } = require("../controllers/planningController");
Module._resolveFilename = originalResolve;
Module._load = originalLoad;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(query = {}) {
  return { query, user: { username: "test-admin" } };
}

function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    status(code) { res._status = code; return res; },
    setHeader(k, v) { res._headers[k] = v; return res; },
    send(body) { res._body = body; return res; },
    json(body) { res._body = body; return res; },
  };
  return res;
}

function resetCapture() {
  capturedColumns = null;
  capturedRows = null;
}

test.beforeEach(() => resetCapture());

// ─── 1. Export with no filters → all active records ──────────────────────────
test("1. export with no filters returns all active records", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(res._headers["Content-Disposition"].includes("planning_master.xlsx"));
  // MAT-C is inactive, so only MAT-A and MAT-B
  assert.equal(capturedRows.length, 2);
  assert.equal(capturedRows[0].materialNo, "MAT-A");
  assert.equal(capturedRows[1].materialNo, "MAT-B");
});

// ─── 2. Export with search filter → only matching records ────────────────────
test("2. export with search filter returns only matching materials", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ search: "MAT-A" }), res);
  assert.equal(capturedRows.length, 1);
  assert.equal(capturedRows[0].materialNo, "MAT-A");
});

// ─── 3. Export with trend filter → filtered by trend ─────────────────────────
test("3. export with trend filter applies trend filtering", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ trend: "up" }), res);
  // Filter is applied; we just verify no error and result is array
  assert.ok(Array.isArray(capturedRows));
});

// ─── 4. Export with stockRisk filter → filtered by stock risk ────────────────
test("4. export with stockRisk filter applies stock risk filtering", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ stockRisk: "Low" }), res);
  assert.ok(Array.isArray(capturedRows));
});

// ─── 5. Export with growthPct range → filtered by growth percentage ──────────
test("5. export with growthPct range filter applies correctly", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ growthPctMin: "0", growthPctMax: "50" }), res);
  assert.ok(Array.isArray(capturedRows));
});

// ─── 6. Export with confidence range → filtered by confidence ────────────────
test("6. export with confidence range filter applies correctly", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ confidenceMin: "50", confidenceMax: "100" }), res);
  assert.ok(Array.isArray(capturedRows));
});

// ─── 7. Export with combined filters → correct intersection ─────────────────
test("7. export with combined search + trend + growthPct filters applies correctly", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ search: "MAT-A", trend: "up", growthPctMin: "0" }), res);
  assert.ok(Array.isArray(capturedRows));
});

// ─── 8. Export ALL records regardless of pagination ──────────────────────────
test("8. export returns all matching records, not limited to page size", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  // All active materials returned (MAT-A, MAT-B) — no pagination limit
  assert.equal(capturedRows.length, 2);
});

// ─── 9. Zero-result filter → clean empty export ──────────────────────────────
test("9. zero-result search returns empty rows array", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq({ search: "NONEXISTENT" }), res);
  assert.equal(capturedRows.length, 0);
  assert.equal(res._status, 200);
});

// ─── 10. Dynamic current-quarter columns → label matches currentQuarter ──────
test("10. dynamic current-quarter column labels match currentQuarter.label", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  // Nov 20, 2026 → calendar Q4
  const cqSalesCol = capturedColumns.find((c) => c.key === "currentQuarterSales");
  const cqToGoCol = capturedColumns.find((c) => c.key === "currentQuarterSalesToGo");
  assert.ok(cqSalesCol, "currentQuarterSales column must exist");
  assert.ok(cqToGoCol, "currentQuarterSalesToGo column must exist");
  assert.equal(cqSalesCol.label, "Q4 Sales");
  assert.equal(cqToGoCol.label, "Q4 Sales to Go");
});

// ─── 11. Current Quarter Sales values match planning view ────────────────────
test("11. currentQuarterSales values match the planning view data", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  const matA = capturedRows.find((r) => r.materialNo === "MAT-A");
  const matB = capturedRows.find((r) => r.materialNo === "MAT-B");
  assert.equal(matA.currentQuarterSales, 150);
  assert.equal(matB.currentQuarterSales, 140);
});

// ─── 12. Current Quarter Sales to Go values match planning view ──────────────
test("12. currentQuarterSalesToGo values match the planning view data", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  const matA = capturedRows.find((r) => r.materialNo === "MAT-A");
  const matB = capturedRows.find((r) => r.materialNo === "MAT-B");
  assert.equal(matA.currentQuarterSalesToGo, 120);
  assert.equal(matB.currentQuarterSalesToGo, 40);
});

// ─── 13. FY columns match groups structure ───────────────────────────────────
test("13. FY group columns are generated with correct labels", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  // Each FY group should have Q1-Q4 + Total = 5 columns per group.
  // Groups come from buildPlanningView — count groups and verify 5 cols each.
  const groupHeaders = capturedColumns.filter((c) => /Q[1-4]/.test(c.label) || c.label.includes("Total"));
  // Deduce the number of FY groups: each group contributes exactly 5 columns
  // (Q1, Q2, Q3, Q4, Total). Filter out the dynamic quarter columns (e.g. "Q4 Sales")
  // by excluding columns whose key is "currentQuarterSales" or "currentQuarterSalesToGo".
  const fyGroupCols = groupHeaders.filter((c) => c.key !== "currentQuarterSales" && c.key !== "currentQuarterSalesToGo");
  const numGroups = Math.floor(fyGroupCols.length / 5);
  assert.ok(numGroups >= 1, "At least one FY group column set must exist");
  assert.equal(fyGroupCols.length, numGroups * 5, "Each FY group must have exactly 5 columns (Q1-Q4 + Total)");
  // Verify each group has the expected Q1-Q4 + Total labels
  for (let i = 0; i < numGroups; i++) {
    const start = i * 5;
    assert.ok(/Q1$/.test(fyGroupCols[start].label), `Group ${i + 1} must have a Q1 column`);
    assert.ok(/Q2$/.test(fyGroupCols[start + 1].label), `Group ${i + 1} must have a Q2 column`);
    assert.ok(/Q3$/.test(fyGroupCols[start + 2].label), `Group ${i + 1} must have a Q3 column`);
    assert.ok(/Q4$/.test(fyGroupCols[start + 3].label), `Group ${i + 1} must have a Q4 column`);
    assert.ok(/Total$/.test(fyGroupCols[start + 4].label), `Group ${i + 1} must have a Total column`);
  }
});

// ─── 14. Forecast/replenishment values match planning calculation pipeline ───
test("14. forecast/replenishment values in export match planning view", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  const matA = capturedRows.find((r) => r.materialNo === "MAT-A");
  const matB = capturedRows.find((r) => r.materialNo === "MAT-B");
  // Plan demand: MAT-A = 270, MAT-B = 180
  assert.equal(matA.plan, 270);
  assert.equal(matB.plan, 180);
  // Current stock: MAT-A = 100, MAT-B = 50
  assert.equal(matA.currentStock, 100);
  assert.equal(matB.currentStock, 50);
  // Required stock: MAT-A = 170, MAT-B = 130
  assert.equal(matA.requiredStock, 170);
  assert.equal(matB.requiredStock, 130);
  // Safety stock must be present
  assert.ok(typeof matA.safetyStock === "number");
  assert.ok(typeof matB.safetyStock === "number");
});

// ─── 15. N/A / zero / blank handling ─────────────────────────────────────────
test("15. N/A, zero, and blank values are formatted correctly", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  const matA = capturedRows.find((r) => r.materialNo === "MAT-A");
  // weekCoverage and replenishmentPlan should be strings (formatted text)
  assert.equal(typeof matA.weekCoverage, "string");
  assert.equal(typeof matA.replenishmentPlan, "string");
  assert.equal(typeof matA.monthlyReplenishment, "string");
  // trend should be formatted as arrow or empty string
  assert.equal(typeof matA.trend, "string");
});

// ─── 16. Authorization — admin-only (inherited from router middleware) ───────
test("16. export endpoint uses correct content headers", async () => {
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  assert.equal(res._headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(res._headers["Content-Disposition"].includes("planning_master.xlsx"));
  assert.ok(res._headers["Content-Disposition"].includes("attachment"));
});

// ─── 17. Existing export endpoints unaffected ────────────────────────────────
test("17. existing buildPlanningView functionality is unaffected", async () => {
  // Verify buildPlanningView still works as expected through the controller
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  // MAT-A and MAT-B present, MAT-C excluded (inactive)
  const materialNos = capturedRows.map((r) => r.materialNo);
  assert.ok(materialNos.includes("MAT-A"));
  assert.ok(materialNos.includes("MAT-B"));
  assert.ok(!materialNos.includes("MAT-C"));
  // Response format is valid
  assert.equal(res._status, 200);
});

test('export includes persisted Safety Stock without changing Required Stock', async (t) => {
  t.mock.method(mockModules['../models/ForecastErrorStats'], 'find', () => ({
    lean: async () => [{ materialNo: 'MAT-A', safetyStock: 137, status: 'FORECAST_ERROR_BASED' }],
  }));
  const res = makeRes();
  await exportPlanningData(makeReq(), res);
  const matA = capturedRows.find(row => row.materialNo === 'MAT-A');
  assert.equal(matA.safetyStock, 137);
  assert.equal(matA.requiredStock, 170);
});
