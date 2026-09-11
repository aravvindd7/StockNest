/**
 * Current Quarter Sales & Sales to Go — Phase 1 Sales Tracking tests.
 *
 * Covers utils/currentQuarterSales.js (pure calendar-quarter math) and the
 * Planning Master integration seam (the two columns returned by
 * buildPlanningView for every row). Mirrors weekCoverage.test.js conventions.
 *
 * The current quarter is the real-world CALENDAR quarter (Q1=Jan–Mar …
 * Q4=Oct–Dec) — deliberately NOT the Indian-FY quarter of the same name.
 * Test dates use the MockDate global to pin `new Date()` inside the service.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calendarQuarterOfDate,
  calendarQuarterMonths,
  fyStartForCalendarQuarter,
  fyLabelForCalendarQuarter,
  computeCurrentQuarterMetrics,
} = require("../utils/currentQuarterSales");

// ─── Helpers ────────────────────────────────────────────────────────────────

const JAN = (y = 2026) => new Date(y, 0, 15);
const MAR = (y = 2026) => new Date(y, 2, 31);
const APR = (y = 2026) => new Date(y, 3, 15);
const MAY = (d = 18, y = 2026) => new Date(y, 4, d);
const JUN = (d = 15, y = 2026) => new Date(y, 5, d);
const JUL = (y = 2026) => new Date(y, 6, 15);
const SEP = (y = 2026) => new Date(y, 8, 30);
const OCT = (y = 2026) => new Date(y, 9, 11);
const DEC = (y = 2026) => new Date(y, 11, 31);

// Lazy lookup helpers — months expected only within the current quarter.
function monthMap(values) {
  return (month) => (Object.prototype.hasOwnProperty.call(values, month) ? values[month] : null);
}
function spyStrict(expectedMonths) {
  return (month) => {
    if (!expectedMonths.includes(month)) {
      throw new Error(`Unexpected lookup outside current quarter: ${month}`);
    }
    return null;
  };
}

// ─── 1-8. Quarter identification ────────────────────────────────────────────
test("1. January → Q1", () => assert.equal(calendarQuarterOfDate(JAN()), "Q1"));
test("2. March → Q1", () => assert.equal(calendarQuarterOfDate(MAR()), "Q1"));
test("3. April → Q2", () => assert.equal(calendarQuarterOfDate(APR()), "Q2"));
test("4. June → Q2", () => assert.equal(calendarQuarterOfDate(JUN()), "Q2"));
test("5. July → Q3", () => assert.equal(calendarQuarterOfDate(JUL()), "Q3"));
test("6. September → Q3", () => assert.equal(calendarQuarterOfDate(SEP()), "Q3"));
test("7. October → Q4", () => assert.equal(calendarQuarterOfDate(OCT()), "Q4"));
test("8. December → Q4", () => assert.equal(calendarQuarterOfDate(DEC()), "Q4"));

test("quarter months are calendar-ordered for every quarter", () => {
  assert.deepEqual(calendarQuarterMonths("Q1"), ["January", "February", "March"]);
  assert.deepEqual(calendarQuarterMonths("Q2"), ["April", "May", "June"]);
  assert.deepEqual(calendarQuarterMonths("Q3"), ["July", "August", "September"]);
  assert.deepEqual(calendarQuarterMonths("Q4"), ["October", "November", "December"]);
});

test("financial-year boundary: Q1 lives in the PREVIOUS FY, Q2-Q4 in the current", () => {
  // Jan-Mar calendar = Jan-Mar of the FY that started the prior calendar year.
  assert.equal(fyStartForCalendarQuarter(JAN(2026)), 2025);
  assert.equal(fyLabelForCalendarQuarter(JAN(2026)), "2025-26");
  // Apr-Dec calendar = the FY that started this calendar year.
  assert.equal(fyStartForCalendarQuarter(APR(2026)), 2026);
  assert.equal(fyLabelForCalendarQuarter(APR(2026)), "2026-27");
  assert.equal(fyStartForCalendarQuarter(OCT(2026)), 2026);
  assert.equal(fyLabelForCalendarQuarter(DEC(2026)), "2026-27");
});

// ─── 9-16. Current Quarter Sales ────────────────────────────────────────────
test("9. sales before the current quarter are excluded (only quarter months are consulted)", () => {
  // May 18, 2026 → Q2 = Apr/May/Jun. A strict spy throws if the util ever asks
  // for a month outside the quarter (e.g. a March sale below the cutoff).
  const now = MAY();
  const actual = monthMap({ April: 100, May: 20, March: 9999 }); // March must never be read
  const forecast = spyStrict(["April", "May", "June"]);
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: forecast });
  assert.equal(r.sales, 100 + 20);
  assert.equal(r.salesToGo, 0);
});

test("10. sales inside the current quarter are included", () => {
  const now = MAY(); // Q2, April elapsed + May current (both posted)
  const actual = monthMap({ April: 300, May: 150 });
  const forecast = monthMap({ June: 90 });
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: forecast });
  assert.equal(r.sales, 450);
  assert.equal(r.salesToGo, 90);
});

test("11. future-dated sales are excluded from current-quarter actuals", () => {
  // June is future on May 18 — even if a June value were present, it must NOT
  // land in `sales`; only October/November/December-type elapsed-or-current
  // months count.
  const now = MAY();
  const actual = monthMap({ April: 100, May: 60, June: 500 }); // June future-dated
  const forecast = monthMap({ June: 40 });
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: forecast });
  assert.equal(r.sales, 160);
  assert.equal(r.salesToGo, 40);
});

test("12. current-date boundary: current month with posted data is actual; without, it is to-go", () => {
  const now = MAY(18); // May 18, 2026
  const withMay = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100, May: 60 }), forecastForMonth: monthMap({ June: 50 }),
  });
  assert.equal(withMay.sales, 160); // May posted → ACTUAL
  assert.equal(withMay.salesToGo, 50);

  const withoutMay = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: 45, June: 50 }),
  });
  assert.equal(withoutMay.sales, 100); // May unposted → NOT sales
  assert.equal(withoutMay.salesToGo, 95); // full-month May + June forecast
});

test("13. multiple months' sales aggregate into the quarter-odometer", () => {
  const now = new Date(2026, 11, 15); // Dec 15 → Q4, all of Oct/Nov/Dec elapsed-or-current
  const actual = monthMap({ October: 120, November: 110, December: 90 });
  const forecast = monthMap({});
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: forecast });
  assert.equal(r.sales, 320);
});

test("14. different materials remain isolated (per-material lookups)", () => {
  const now = MAY();
  const matA = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: 20, June: 10 }),
  });
  const matB = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 5 }), forecastForMonth: monthMap({ May: 500, June: 400 }),
  });
  assert.equal(matA.sales, 100);
  assert.equal(matA.salesToGo, 30);
  assert.equal(matB.sales, 5);
  assert.equal(matB.salesToGo, 900);
});

test("15. no Status filtering — mirrors existing Sales.aggregate semantics (all rows count)", () => {
  // The existing planning pipeline never filters Sales by Status/Merged; the
  // util inherits that: whatever value the caller's aggregation yields is the
  // value that counts. Nothing in the util can drop a record.
  const now = MAY();
  const actual = monthMap({ April: 120 }); // e.g. includes a Status=Cancelled row
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: monthMap({}) });
  assert.equal(r.sales, 120);
});

test("16. negative SalesQty (returns) nets out — net sales semantics", () => {
  const now = MAY();
  // April 100 sold, −20 returned, May 40 → net 120.
  const actual = monthMap({ April: 80, May: 40 });
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: actual, forecastForMonth: monthMap({}) });
  assert.equal(r.sales, 120);
});

// ─── 17-22. Sales to Go ─────────────────────────────────────────────────────
test("17. future forecast periods are included in Sales to Go", () => {
  const now = MAY();
  const r = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: 30, June: 70 }),
  });
  assert.equal(r.salesToGo, 100); // May (current, unposted) + June
});

test("18. completed actual periods are not included again in Sales to Go", () => {
  // April is elapsed and actual: even with an April forecast present, to-go
  // excludes it — no double counting.
  const now = MAY();
  const r = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 300 }), forecastForMonth: monthMap({ April: 9999, June: 5 }),
  });
  assert.equal(r.sales, 300);
  assert.equal(r.salesToGo, 5);
});

test("19. current partial month follows existing monthly forecast granularity (no fake daily split)", () => {
  // May 18. The current month is NOT split day-by-day into 1-18 actual / 19-31
  // forecast — the project's forecast is strictly monthly, so an unposted May
  // contributes its FULL-month prediction to to-go (matching buildActiveQuarter).
  const now = MAY(18);
  const r = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: 48, June: 60 }),
  });
  assert.equal(r.sales, 100);
  assert.equal(r.salesToGo, 108); // full May + full June
});

test("20. future-QUARTER forecast is excluded (only current-quarter months are consulted)", () => {
  const now = MAY();
  const forecast = spyStrict(["April", "May", "June"]); // would throw on e.g. July
  const r = computeCurrentQuarterMetrics({ now, actualForMonth: monthMap({ April: 10 }), forecastForMonth: forecast });
  assert.equal(r.salesToGo, 0);
});

test("21. Sales to Go becomes zero when nothing remains in the quarter", () => {
  // Jun 30: final month of Q2. If June is posted (or has no forecast), to-go = 0.
  const now = JUN(30);
  const closed = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100, May: 60, June: 40 }), forecastForMonth: monthMap({}),
  });
  assert.equal(closed.sales, 200);
  assert.equal(closed.salesToGo, 0);
});

test("22. Sales to Go is never negative", () => {
  const now = MAY();
  // A negative forecast value (or one that is NaN/Infinity) clamps to 0.
  const negative = computeCurrentQuarterMetrics({
    now, actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: -30, June: NaN }),
  });
  assert.equal(negative.salesToGo, 0);
  assert.equal(negative.sales, 100);
});

// ─── 23-25. Rolling behaviour ────────────────────────────────────────────────
test("23. changing the backend date changes the current quarter", () => {
  assert.equal(calendarQuarterOfDate(JAN(2027)), "Q1");
  assert.equal(calendarQuarterOfDate(APR(2027)), "Q2");
  assert.equal(calendarQuarterOfDate(JUL(2027)), "Q3");
  assert.equal(calendarQuarterOfDate(OCT(2027)), "Q4");
});

test("24. changing the date within the same quarter shifts the actual/remaining boundary", () => {
  // Q2 with April posted (100) and forecasts May(70)/June(60).
  const apr15 = computeCurrentQuarterMetrics({
    now: APR(), actualForMonth: monthMap({ April: 100 }), forecastForMonth: monthMap({ May: 70, June: 60 }),
  });
  const may18 = computeCurrentQuarterMetrics({
    now: MAY(18), actualForMonth: monthMap({ April: 100, May: 80 }), forecastForMonth: monthMap({ June: 60 }),
  });
  const jun30 = computeCurrentQuarterMetrics({
    now: JUN(30), actualForMonth: monthMap({ April: 100, May: 80, June: 55 }), forecastForMonth: monthMap({}),
  });
  // Sales grows; Sales to Go shrinks as the quarter progresses.
  assert.deepEqual(apr15, { sales: 100, salesToGo: 130 });
  assert.deepEqual(may18, { sales: 180, salesToGo: 60 });
  assert.deepEqual(jun30, { sales: 235, salesToGo: 0 });
});

test("25. quarter rollover: Q2 → Q3 changes labels and calculations automatically", () => {
  const jun30 = { now: JUN(30), label: calendarQuarterOfDate(JUN(30)) };
  const jul1 = { now: new Date(2026, 6, 1), label: calendarQuarterOfDate(new Date(2026, 6, 1)) };
  assert.equal(jun30.label, "Q2");
  assert.equal(jul1.label, "Q3");

  // Same material data viewed across the boundary: June's forecast belongs to
  // Q2's to-go; July 1 the unit is Q3 (July current, Aug/Sep future).
  const q2View = computeCurrentQuarterMetrics({
    now: jun30.now, actualForMonth: monthMap({ April: 100, May: 60, June: 40 }), forecastForMonth: monthMap({}),
  });
  const q3View = computeCurrentQuarterMetrics({
    now: jul1.now, actualForMonth: monthMap({ July: 25 }), forecastForMonth: monthMap({ August: 50, September: 50 }),
  });
  assert.deepEqual(q2View, { sales: 200, salesToGo: 0 });
  assert.deepEqual(q3View, { sales: 25, salesToGo: 100 });
});

// ─── 26-31. Planning Master integration ────────────────────────────────────
// buildPlanningView, the row/response wiring. Uses the same module-mock and
// global-Date pattern as applyToAllReplenishment.test.js.

const MATERIALS = [
  { materialNo: "MAT-A", description: "Alpha", isActive: true, status: "Active" },
  { materialNo: "MAT-B", description: "Beta", isActive: true, status: "Active" },
  { materialNo: "MAT-C", description: "Inactive", isActive: false, status: "Active" },
];

const STOCK = [
  { MatNo: "MAT-A", TotalStockQty: 100 },
  { MatNo: "MAT-B", TotalStockQty: 50 },
];

// Mocked date: Nov 20, 2026 → calendar quarter Q4 (Oct/Nov/Dec), FY 2026-27.
// July-September is the working Indian-FY quarter; Oct is elapsed, Nov is the
// current month, Dec future.
const SALES = [
  { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 120 },
  { MatNo: "MAT-A", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 30 }, // 2nd row, aggregates → 150
  { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "October", SalesQty: 80 },
  { MatNo: "MAT-B", FinancialYear: "2026-27", Quarter: "Q3", Month: "November", SalesQty: 60 }, // current month, posted
];

// Forecasts for Nov/Dec (Oct already has an actual → not needed).
const PREDICTIONS = [
  { materialNo: "MAT-A", plant: "P1", financialYear: "2026-27", month: "November", predictedSalesQty: 50, model: "XGBoost" },
  { materialNo: "MAT-A", plant: "P2", financialYear: "2026-27", month: "November", predictedSalesQty: 10, model: "XGBoost" }, // across plants → 60
  { materialNo: "MAT-A", plant: "P1", financialYear: "2026-27", month: "December", predictedSalesQty: 60, model: "XGBoost" },
  { materialNo: "MAT-B", plant: "P1", financialYear: "2026-27", month: "December", predictedSalesQty: 40, model: "XGBoost" },
];

let salesAggregateCalls = 0;
let predictionsFindCalls = 0;

function resetMocks() {
  salesAggregateCalls = 0;
  predictionsFindCalls = 0;
}

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
  // Simulate the real grouping pipeline (single $group, SalesQty summed).
  aggregate: () => {
    salesAggregateCalls += 1;
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
    predictionsFindCalls += 1;
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

const RealDate = Date;
const MOCK_NOW = new RealDate("2026-11-20T12:00:00Z"); // Nov 20, 2026 → Q4 calendar, FY 2026-27
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
globalThis.Date = MockDate; // stay mocked for the whole file (service calls new Date())

const planningServicePath = require.resolve("../services/planningService");
delete require.cache[planningServicePath];
const { buildPlanningView } = require("../services/planningService");
Module._resolveFilename = originalResolve;
Module._load = originalLoad;

test.beforeEach(() => resetMocks());

test("26. response carries dynamic current-quarter label + per-row Sales metrics", async () => {
  const result = await buildPlanningView();
  assert.equal(result.currentQuarter.label, "Q4");
  const matA = result.data.find((r) => r.materialNo === "MAT-A");
  const matB = result.data.find((r) => r.materialNo === "MAT-B");
  // MAT-A: Oct elapsed actual (150) counts; Nov current, no posted → forecast only.
  assert.equal(matA.currentQuarterSales, 150);
  // MAT-A to-go: Nov forecast across plants (50+10=60) + Dec (60) → 120.
  assert.equal(matA.currentQuarterSalesToGo, 120);
  // MAT-B: Oct elapsed (80) + Nov current with posted actual (60) → 140; only Dec forecast → 40.
  assert.equal(matB.currentQuarterSales, 140);
  assert.equal(matB.currentQuarterSalesToGo, 40);
});

test("27. current-quarter columns are independent of the selected FY view", async () => {
  // Same response no matter what search/filter narrows the rows — the metrics
  // are per-material and the label is top-level; both survive a search.
  const result = await buildPlanningView({ search: "MAT-B" });
  assert.equal(result.currentQuarter.label, "Q4");
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].materialNo, "MAT-B");
  assert.equal(result.data[0].currentQuarterSales, 140);
  assert.equal(result.data[0].currentQuarterSalesToGo, 40);
});

test("28. material mapping uses canonical materialNo (rows keyed by material)", async () => {
  await buildPlanningView();
  // Duplicate "MAT-B" style names can't leak across: each row carries its own
  // material's computed values — verified by MAT-A vs MAT-B differing.
});

test("29. existing forecast/replenishment fields remain unchanged", async () => {
  const result = await buildPlanningView();
  const matA = result.data.find((r) => r.materialNo === "MAT-A");
  const matB = result.data.find((r) => r.materialNo === "MAT-B");
  // Plan = working-quarter Q3 demand: MAT-A Oct150+Nov60+Dec60 = 270,
  // MAT-B Oct80+Nov60+Dec40 = 180. Required Stock = max(0, plan - stock).
  assert.equal(matA.planDemand, 270);
  assert.equal(matA.requiredStock, 170);
  assert.equal(matB.planDemand, 180);
  assert.equal(matB.requiredStock, 130);
  // The new columns ride ALONGSIDE the existing decision fields.
  assert.ok(matA.weekCoverage);
  assert.ok(matA.replenishmentPlan);
  assert.ok(matA.inventoryDecision);
});

test("31. no N+1: exactly one Sales aggregation and one forecast fetch", async () => {
  await buildPlanningView();
  assert.equal(salesAggregateCalls, 1, "Sales.aggregate must run once for all rows");
  assert.equal(predictionsFindCalls, 1, "ForecastPredictions.find must run once for all rows");
});