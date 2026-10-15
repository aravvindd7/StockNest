/**
 * MANUAL replenishment plans vs a changing forecast. A new forecast never
 * overwrites a planner's allocation: the plan keeps its values and is flagged
 * "forecast updated — may need review"; AUTO always follows the current forecast.
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
    const set = update.$set || update;
    const doc = { ...(update.$set ? savedPlan : {}), ...filter, ...set, _id: `mock-${writes.length}`, updatedAt: new Date() };
    writes.push(doc);
    if (filter.materialNo === "MAT-A") savedPlan = doc;
    return mockResult(doc);
  },
  deleteOne: () => { savedPlan = null; return Promise.resolve({ deletedCount: 1 }); },
};

let forecastState = { version: 1, lastSuccessAt: new Date("2026-10-15T08:00:00Z") };
const mockModules = {
  "../utils/derivedState": { readForecastState: async () => forecastState },
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
const save = (distribution) =>
  planning.saveReplenishmentPlan({ materialNo: "MAT-A", financialYear: "2026-27", quarter: "Q3", requiredStock: 50, distribution, updatedBy: "planner" });
const view = async () => planning.buildPlanningView({});
const row = async () => (await view()).data.find((r) => r.materialNo === "MAT-A");

test.beforeEach(() => {
  savedPlan = null;
  writes = [];
  forecastState = { version: 1, lastSuccessAt: new Date("2026-10-15T08:00:00Z") };
});

test("AUTO plan follows the current forecast and says which forecast it used", async () => {
  const r = await row();
  assert.equal(r.replenishmentPlan.mode, "AUTO_FORECAST");
  assert.equal(r.replenishmentPlan.basedOnForecastVersion, 1);
  assert.deepEqual((await view()).forecast, { version: 1, updatedAt: forecastState.lastSuccessAt });
  forecastState = { version: 2, lastSuccessAt: new Date() };
  assert.equal((await row()).replenishmentPlan.basedOnForecastVersion, 2, "recalculated against the newest forecast");
});

test("saving a MANUAL plan records the forecast it was made against", async () => {
  await save(dist(45, 35, 20));
  assert.equal(writes[0].basedOnForecastVersion, 1);
  const p = (await row()).replenishmentPlan;
  assert.deepEqual([p.mode, p.basedOnForecastVersion, p.forecastChangedSinceSaved], ["MANUAL", 1, false]);
});

test("a new forecast never overwrites a MANUAL plan — it is kept and flagged for review", async () => {
  await save(dist(45, 35, 20));
  const before = JSON.parse(JSON.stringify(savedPlan));
  forecastState = { version: 2, lastSuccessAt: new Date() };
  const p = (await row()).replenishmentPlan;
  assert.equal(p.mode, "MANUAL");
  assert.deepEqual(p.distribution.map((d) => d.percentage), [45, 35, 20], "planner's allocation survives");
  assert.deepEqual(p.distribution.map((d) => d.quantity), [23, 17, 10], "quantities still sum to Required Stock");
  assert.equal(p.forecastChangedSinceSaved, true);
  assert.deepEqual(JSON.parse(JSON.stringify(savedPlan)), before, "nothing written by reading the view");
  assert.notDeepEqual((await row()).autoReplenishmentPlan.distribution.map((d) => d.percentage), [45, 35, 20], "AUTO is the system's own plan");
});

test("confirming an unchanged plan after a forecast update only refreshes its forecast reference", async () => {
  await save(dist(45, 35, 20));
  forecastState = { version: 2, lastSuccessAt: new Date() };
  writes = [];
  const r = await save(dist(45, 35, 20));
  assert.equal(r.confirmed, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].distribution.map((d) => d.percentage), [45, 35, 20], "allocation untouched");
  assert.equal(writes[0].basedOnForecastVersion, 2);
  assert.equal((await row()).replenishmentPlan.forecastChangedSinceSaved, false);
  writes = [];
  assert.equal((await save(dist(45, 35, 20))).unchanged, true, "nothing to confirm any more → no write");
  assert.equal(writes.length, 0);
});

test("editing a flagged plan saves the new values against the current forecast", async () => {
  await save(dist(45, 35, 20));
  forecastState = { version: 3, lastSuccessAt: new Date() };
  await save(dist(30, 30, 40));
  assert.deepEqual([savedPlan.distributionMode, savedPlan.basedOnForecastVersion], ["MANUAL", 3]);
  assert.deepEqual(savedPlan.distribution.map((d) => d.percentage), [30, 30, 40]);
  assert.equal((await row()).replenishmentPlan.forecastChangedSinceSaved, false);
});

test("plans saved before versions existed: flagged when the forecast was generated after the save", async () => {
  savedPlan = { materialNo: "MAT-A", depotId: "", financialYear: "2026-27", quarter: "Q3", requiredStock: 50, distributionMode: "MANUAL",
    distribution: dist(45, 35, 20).map((d) => ({ ...d, quantity: 0 })), updatedAt: new Date("2026-10-01T00:00:00Z") };
  assert.equal((await row()).replenishmentPlan.forecastChangedSinceSaved, true);
  savedPlan.updatedAt = new Date("2026-10-15T09:00:00Z");
  assert.equal((await row()).replenishmentPlan.forecastChangedSinceSaved, false);
});

test("no forecast bookkeeping yet → nothing is flagged and saves still work", async () => {
  forecastState = null;
  await save(dist(45, 35, 20));
  assert.equal(writes[0].basedOnForecastVersion, undefined);
  assert.equal((await row()).replenishmentPlan.forecastChangedSinceSaved, false);
});

test("existing allocation validation is unchanged", async () => {
  for (const bad of [dist(30, 30, 39), dist(-10, 10, 100), dist(0, 0, 101)]) {
    await assert.rejects(save(bad), (err) => err.validation === true);
  }
  assert.equal(writes.length, 0);
});

test("Apply to All records the current forecast on every plan it saves", async () => {
  forecastState = { version: 5, lastSuccessAt: new Date() };
  const result = await planning.applyToAllReplenishmentPlan({ financialYear: "2026-27", distribution: dist(30, 30, 40), updatedBy: "planner" });
  assert.equal(result.saved, 1);
  assert.equal(writes[0].basedOnForecastVersion, 5);
});
