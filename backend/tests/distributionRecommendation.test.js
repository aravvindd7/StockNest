/**
 * Distribution Stage 3 — recommendation engine tests.
 *
 * Pure rules (formulas, matching, ordering, priority), the engine's input
 * validation / data-quality handling, generation runs (run IDs, superseding,
 * history preservation, duplicate prevention, rollback, dry run) and the
 * admin API. DB-free: reads are mocked with t.mock.method, and
 * DistributionRecommendation writes go to a small in-memory store that applies
 * the same filter shapes MongoDB would, so state changes are real.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "distribution-test-secret";

const DistributionRecommendation = require("../models/DistributionRecommendation");
const DepotSafetyStock = require("../models/DepotSafetyStock");
const DistributionTransfer = require("../models/DistributionTransfer");
const DepotPlantMapping = require("../models/DepotPlantMapping");
const Depot = require("../models/Depot");
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const User = require("../models/User");
const depotDemandService = require("../services/depotDemandService");
const distributionConfig = require("../config/distribution");
const engine = require("../services/distributionRecommendationService");
const { parseGenerateBody } = require("../controllers/distributionController");
const distributionRoutes = require("../routes/distributionRoutes");

const { calculateSurplus, calculateShortage, buildPositions, matchMaterial, priorityFor } = engine;

// ─── Pure rules ──────────────────────────────────────────────────────────────

// stockInHand defaults to the whole stock (nothing in transit); pass it to model in-transit stock.
const pos = (depotId, currentStock, forecastDemand, safetyStock = 0, materialNo = "MAT1", stockInHand = currentStock) =>
  ({ materialNo, depotId, currentStock, stockInHand, forecastDemand, safetyStock });

test("formula: source surplus = max(0, stock IN HAND − safety stock − forecast demand)", () => {
  assert.equal(calculateSurplus({ stockInHand: 2570, safetyStock: 44, forecastDemand: 1365 }), 1161);
  assert.equal(calculateSurplus({ stockInHand: 100, safetyStock: 30, forecastDemand: 70 }), 0);
  assert.equal(calculateSurplus({ stockInHand: 50, safetyStock: 30, forecastDemand: 70 }), 0, "never negative");
  // Total stock is irrelevant to surplus — only stock in hand can be shipped.
  assert.equal(calculateSurplus({ currentStock: 5000, stockInHand: 100, safetyStock: 0, forecastDemand: 40 }), 60);
});

test("SIH rule: in-transit stock is never counted as transferable surplus", () => {
  // 1,000 total but only 100 in hand (900 in transit): surplus is 100 − 0 − 50 = 50, not 950.
  const [p] = buildPositions([pos("D1", 1000, 50, 0, "MAT1", 100)]);
  assert.deepEqual([p.role, p.surplus, p.shortage], ["SOURCE", 50, 0]);
  // In-transit stock still covers the depot's own need (no shortage), but none of it can be shipped.
  const [q] = buildPositions([pos("D1", 1000, 50, 0, "MAT1", 40)]);
  assert.deepEqual([q.role, q.surplus, q.shortage], ["BALANCED", 0, 0]);
  // A destination is never recommended more stock it already has on the way.
  const { matches } = matchMaterial(buildPositions([pos("S", 1000, 0, 0, "MAT1", 30), pos("D", 0, 500)]));
  assert.deepEqual(matches.map((m) => m.quantity), [30], "capped at the source's stock in hand");
});

test("formula: destination shortage = max(0, forecast demand + safety stock − stock)", () => {
  assert.equal(calculateShortage({ currentStock: 366, safetyStock: 116, forecastDemand: 3083 }), 2833);
  assert.equal(calculateShortage({ currentStock: 100, safetyStock: 30, forecastDemand: 70 }), 0);
  assert.equal(calculateShortage({ currentStock: 900, safetyStock: 30, forecastDemand: 70 }), 0, "never negative");
});

test("positions: a depot is SOURCE, DESTINATION or BALANCED — never both", () => {
  const p = buildPositions([pos("D1", 200, 50, 10), pos("D2", 10, 50, 10), pos("D3", 60, 50, 10)]);
  assert.deepEqual(p.map((x) => [x.depotId, x.role, x.surplus, x.shortage]), [["D1", "SOURCE", 140, 0], ["D2", "DESTINATION", 0, 50], ["D3", "BALANCED", 0, 0]]);
});

test("quantity is capped by BOTH source surplus and destination shortage", () => {
  let { matches } = matchMaterial(buildPositions([pos("S", 1000, 0), pos("D", 0, 40)]));
  assert.deepEqual(matches.map((m) => m.quantity), [40], "capped by shortage");
  ({ matches } = matchMaterial(buildPositions([pos("S", 25, 0), pos("D", 0, 40)])));
  assert.deepEqual(matches.map((m) => m.quantity), [25], "capped by surplus");
});

test("exact match: surplus equals shortage → one recommendation, nothing left over", () => {
  const { matches, unfulfilled } = matchMaterial(buildPositions([pos("S", 70, 30), pos("D", 10, 50)]));
  assert.deepEqual(matches.map((m) => [m.source.depotId, m.destination.depotId, m.quantity, m.uncoveredAfter]), [["S", "D", 40, 0]]);
  assert.deepEqual(unfulfilled, []);
});

test("source never transfers to itself", () => {
  const { matches } = matchMaterial(buildPositions([pos("D1", 500, 10), pos("D2", 0, 100), pos("D3", 0, 100)]));
  assert.ok(matches.every((m) => m.source.depotId !== m.destination.depotId));
});

test("multiple sources: largest remaining surplus first; split only when one source cannot cover", () => {
  const { matches } = matchMaterial(buildPositions([pos("SA", 30, 0), pos("SB", 100, 0), pos("SC", 60, 0), pos("D", 0, 150)]));
  assert.deepEqual(matches.map((m) => [m.source.depotId, m.quantity]), [["SB", 100], ["SC", 50]], "SA untouched — two sources suffice");
  const single = matchMaterial(buildPositions([pos("SA", 30, 0), pos("SB", 100, 0), pos("D", 0, 80)])).matches;
  assert.deepEqual(single.map((m) => [m.source.depotId, m.quantity]), [["SB", 80]], "no split when one source covers it");
});

test("multiple destinations: largest shortage served first; equal shortages ordered by depotId", () => {
  const { matches, unfulfilled } = matchMaterial(buildPositions([pos("S", 100, 0), pos("DZ", 0, 60), pos("DB", 0, 60), pos("DA", 0, 90)]));
  assert.deepEqual(matches.map((m) => [m.destination.depotId, m.quantity]), [["DA", 90], ["DB", 10]]);
  assert.deepEqual(unfulfilled.map((u) => [u.depotId, u.uncovered]), [["DB", 50], ["DZ", 60]]);
});

test("deterministic: same inputs in any order → identical recommendations", () => {
  const raw = [pos("S1", 300, 50), pos("S2", 300, 50), pos("S3", 120, 20), pos("D1", 0, 200), pos("D2", 10, 200), pos("D3", 0, 190), pos("D4", 0, 210)];
  const key = (r) => matchMaterial(buildPositions(r)).matches.map((m) => `${m.source.depotId}>${m.destination.depotId}:${m.quantity}`).join(",");
  const expected = key(raw);
  for (let i = 0; i < 10; i += 1) assert.equal(key([...raw].sort(() => (Math.sin(i * 97 + raw.length) > 0 ? 1 : -1))), expected);
  assert.equal(key([...raw].reverse()), expected);
});

test("partial fulfilment: total supply < total shortage → remainder reported as unfulfilled", () => {
  const { matches, unfulfilled } = matchMaterial(buildPositions([pos("S", 60, 0), pos("D", 0, 100)]));
  assert.deepEqual(matches.map((m) => [m.quantity, m.uncoveredAfter]), [[60, 40]]);
  assert.deepEqual(unfulfilled, [{ materialNo: "MAT1", depotId: "D", shortage: 100, covered: 60, uncovered: 40 }]);
});

test("no-surplus case: shortages exist but no depot can spare stock → no recommendations", () => {
  const { matches, unfulfilled } = matchMaterial(buildPositions([pos("D1", 10, 50), pos("D2", 50, 50)]));
  assert.deepEqual(matches, []);
  assert.equal(unfulfilled.length, 1);
});

test("no-shortage case: surplus exists but nobody needs it → no recommendations", () => {
  const { matches, unfulfilled } = matchMaterial(buildPositions([pos("S", 500, 50), pos("D", 60, 50)]));
  assert.deepEqual(matches, []);
  assert.deepEqual(unfulfilled, []);
});

test("priority: share of the destination's requirement left uncovered (below safety stock = CRITICAL)", () => {
  const p = (currentStock, forecastDemand, safetyStock) => priorityFor(buildPositions([pos("D", currentStock, forecastDemand, safetyStock)])[0]);
  assert.equal(p(40, 100, 0), "CRITICAL"); // 60% uncovered
  assert.equal(p(65, 100, 0), "HIGH"); // 35%
  assert.equal(p(85, 100, 0), "MEDIUM"); // 15%
  assert.equal(p(95, 100, 0), "LOW"); // 5%
  assert.equal(p(90, 10, 95), "CRITICAL", "stock already below safety stock");
});

// ─── Engine harness ──────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 14, 12);
const MONTHS = [["2026-27", "October", "Q3"], ["2026-27", "November", "Q3"], ["2026-27", "December", "Q3"]]
  .map(([financialYear, month, quarter]) => ({ financialYear, month, quarter }));

/** Tiny MongoDB-filter evaluator for the shapes the engine uses. */
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    const value = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$in" in cond) return cond.$in.includes(value);
      if ("$ne" in cond) return value !== cond.$ne;
    }
    return value === cond;
  });
}

function memoryStore(t, seed = []) {
  const store = seed.map((d) => ({ _id: new mongoose.Types.ObjectId(), ...d }));
  const calls = [];
  t.mock.method(DistributionRecommendation, "countDocuments", async (f) => store.filter((d) => matches(d, f)).length);
  t.mock.method(DistributionRecommendation, "updateMany", async (f, update) => {
    calls.push(["updateMany", f, update]);
    let modifiedCount = 0;
    store.filter((d) => matches(d, f)).forEach((d) => {
      Object.assign(d, update.$set || {});
      Object.keys(update.$unset || {}).forEach((k) => delete d[k]);
      modifiedCount += 1;
    });
    return { modifiedCount };
  });
  t.mock.method(DistributionRecommendation, "insertMany", async (docs) => {
    calls.push(["insertMany", docs.length]);
    const inserted = docs.map((d) => ({ _id: new mongoose.Types.ObjectId(), ...d }));
    // Same guarantee as the partial unique index: one PENDING per material + route + period.
    inserted.forEach((d) => {
      const clash = store.find((x) => x.status === "PENDING" && x.materialNo === d.materialNo && x.sourceDepotId === d.sourceDepotId
        && x.destinationDepotId === d.destinationDepotId && x.forecastPeriod.financialYear === d.forecastPeriod.financialYear
        && x.forecastPeriod.startMonth === d.forecastPeriod.startMonth);
      if (clash) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
      store.push(d);
    });
    return inserted;
  });
  t.mock.method(DistributionRecommendation, "deleteMany", async (f) => {
    calls.push(["deleteMany", f]);
    const keep = store.filter((d) => !matches(d, f));
    const deletedCount = store.length - keep.length;
    store.splice(0, store.length, ...keep);
    return { deletedCount };
  });
  return { store, calls };
}

/**
 * Mocks every engine read. `world` describes one dataset in depot terms:
 *   positions: { "MAT1|D1": { stock, demand, ss } }  (demand split evenly over 3 months)
 *   options to omit stock/forecast/safety stock or mark forecasts incomplete per key.
 */
function mockWorld(t, {
  positions,
  materials,
  depots = ["D1", "D2", "D3"],
  mappings,
  noStock = [],
  noForecast = [],
  incompleteForecast = [],
  noSafety = [],
  safetyStatus = {},
  extraStock = [],
  months = MONTHS,
  openTransfers = [],
}) {
  const keys = Object.keys(positions);
  const mats = materials || [...new Set(keys.map((k) => k.split("|")[0]))].map((materialNo) => ({ materialNo, status: "STD", isActive: true }));
  const maps = mappings || depots.map((d) => ({ depotId: d, plantName: `${d} Plant`, isActive: true }));

  t.mock.method(Material, "find", () => ({ select: () => ({ lean: async () => mats }) }));
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => depots.map((depotId) => ({ depotId, depotName: `Depot ${depotId}` })) }) }));
  t.mock.method(DepotPlantMapping, "find", () => ({ lean: async () => maps }));
  t.mock.method(Stock, "find", () => ({ select: () => ({ lean: async () => [
    ...keys.filter((k) => !noStock.includes(k)).map((k) => {
      const [MatNo, depotId] = k.split("|");
      const sih = positions[k].sih ?? positions[k].stock;
      return { MatNo, PlantName: `${depotId} Plant`, TotalStockQty: positions[k].stock, SIHQty: sih, SITQTY: positions[k].stock - sih, StockDate: new Date("2026-10-05") };
    }),
    ...extraStock,
  ] }) }));
  t.mock.method(DistributionTransfer, "find", (filter) => ({ select: () => ({ lean: async () => openTransfers.filter((tr) => filter.status.$in.includes(tr.status)) }) }));
  t.mock.method(DepotSafetyStock, "find", () => ({ lean: async () => keys.filter((k) => !noSafety.includes(k)).map((k) => {
    const [materialNo, depotId] = k.split("|");
    return { materialNo, depotId, safetyStock: positions[k].ss || 0, status: safetyStatus[k] || "FORECAST_ERROR_BASED" };
  }) }));
  t.mock.method(depotDemandService, "getDepotDemand", async ({ horizonMonths }) => {
    const window = months.slice(0, horizonMonths);
    const data = [];
    keys.filter((k) => !noForecast.includes(k)).forEach((k) => {
      const [materialNo, depotId] = k.split("|");
      window.forEach((m, i) => data.push({
        materialNo, depotId, ...m, forecastDemand: positions[k].demand / window.length, complete: !(incompleteForecast.includes(k) && i === 0),
      }));
    });
    return {
      window: { months: window },
      data,
      integrity: { unmappedPlants: [], inactiveMappingPlants: [], mappingsToUnknownDepots: [], unknownOrInactiveMaterials: [], excludedForecastMonths: [] },
    };
  });
}

const run = (options = {}) => engine.generateRecommendations(options, { now: NOW, user: "admin" });
const route = (r) => `${r.materialNo} ${r.sourceDepotId}>${r.destinationDepotId}`;

// ─── Engine: matching across materials & data quality ────────────────────────

test("engine: materials are matched independently (one material's surplus never covers another's shortage)", async (t) => {
  mockWorld(t, { positions: {
    "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 50, demand: 30 }, "MAT1|D3": { stock: 40, demand: 30 },
    "MAT2|D1": { stock: 0, demand: 90 }, "MAT2|D2": { stock: 30, demand: 30 }, "MAT2|D3": { stock: 30, demand: 30 },
  } });
  const { store } = memoryStore(t);
  const r = await run();
  assert.equal(r.materialsEvaluated, 2);
  assert.deepEqual(r.recommendations.map(route), []);
  assert.deepEqual(r.unfulfilledShortages.map((u) => `${u.materialNo}@${u.depotId}`), ["MAT2@D1"]);
  assert.equal(store.length, 0);
});

test("engine: snapshot values on each recommendation equal the engine's exact inputs", async (t) => {
  mockWorld(t, { positions: {
    "MAT1|D1": { stock: 2570, demand: 1364.2, ss: 44 },
    "MAT1|D2": { stock: 366, demand: 3083, ss: 116 },
    "MAT1|D3": { stock: 700, demand: 600, ss: 50 },
  } });
  const { store } = memoryStore(t);
  const r = await run();
  assert.deepEqual(r.sourcePositions.map((p) => [p.depotId, p.forecastDemand, p.surplus]), [["D1", 1365, 1161], ["D3", 600, 50]]);
  assert.deepEqual(r.destinationPositions.map((p) => [p.depotId, p.shortage]), [["D2", 2833]]);
  assert.equal(r.recommendationsCreated, 2);
  assert.equal(r.totalRecommendedQuantity, 1211);
  const [first, second] = store;
  assert.deepEqual(
    Object.fromEntries(["sourceCurrentStock", "sourceStockInHand", "sourceSafetyStock", "sourceForecastDemand", "sourceSurplus", "destinationCurrentStock",
      "destinationSafetyStock", "destinationForecastDemand", "destinationShortage", "recommendedQuantity"].map((k) => [k, first[k]])),
    { sourceCurrentStock: 2570, sourceStockInHand: 2570, sourceSafetyStock: 44, sourceForecastDemand: 1365, sourceSurplus: 1161, destinationCurrentStock: 366,
      destinationSafetyStock: 116, destinationForecastDemand: 3083, destinationShortage: 2833, recommendedQuantity: 1161 },
  );
  assert.deepEqual([second.sourceDepotId, second.recommendedQuantity], ["D3", 50], "split to the next source only because D1 could not cover it");
  assert.deepEqual(first.forecastPeriod, { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 });
  assert.equal(first.priority, "CRITICAL");
  assert.match(first.reason, /D2 \(Depot D2\) needs 2,833 more units of MAT1 for October 2026 – December 2026/);
  assert.equal(first.status, "PENDING");
  assert.equal(first.generatedBy, "admin");
  assert.deepEqual(r.unfulfilledShortages, [{ materialNo: "MAT1", depotId: "D2", shortage: 2833, covered: 1211, uncovered: 1622 }]);
});

test("SIH rule (engine): recommendation capped by stock in hand; total and in-hand both snapshotted; reason explains transit", async (t) => {
  mockWorld(t, { positions: {
    "MAT1|D1": { stock: 2000, sih: 300, demand: 90, ss: 10 }, // 1,700 in transit — only 300 − 10 − 90 = 200 can move
    "MAT1|D2": { stock: 0, demand: 900 },
  }, depots: ["D1", "D2"] });
  const { store } = memoryStore(t);
  const r = await run();
  assert.deepEqual(r.sourcePositions.map((p) => [p.depotId, p.currentStock, p.stockInHand, p.stockInTransit, p.surplus]), [["D1", 2000, 300, 1700, 200]]);
  assert.equal(store.length, 1);
  const [rec] = store;
  assert.deepEqual([rec.sourceCurrentStock, rec.sourceStockInHand, rec.sourceSurplus, rec.recommendedQuantity], [2000, 300, 200, 200]);
  assert.match(rec.reason, /stock in hand 300 − safety stock 10 − own forecast demand 90 \(1,700 more in transit, not transferable\)/);
});

test("SIH rule (engine): stock in hand above total stock, or missing, is invalid stock", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 } },
    depots: ["D1", "D2"],
    noStock: ["MAT1|D1"],
    extraStock: [{ MatNo: "MAT1", PlantName: "D1 Plant", TotalStockQty: 100, SIHQty: 150, StockDate: new Date("2026-10-05") }],
  });
  memoryStore(t);
  let r = await run({ dryRun: true });
  assert.deepEqual(r.skipped.map((s) => [s.depotId, s.reasons]), [["D1", ["INVALID_STOCK"]]]);

  t.mock.restoreAll();
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 } },
    depots: ["D1", "D2"],
    noStock: ["MAT1|D1"],
    extraStock: [{ MatNo: "MAT1", PlantName: "D1 Plant", TotalStockQty: 500, StockDate: new Date("2026-10-05") }], // no SIHQty
  });
  memoryStore(t);
  r = await run({ dryRun: true });
  assert.deepEqual(r.skipped.map((s) => [s.depotId, s.reasons]), [["D1", ["INVALID_STOCK"]]]);
  assert.equal(r.recommendations.length, 0, "never falls back to total stock");
});

test("SIH rule (model): surplus above stock in hand is rejected even when total stock would allow it", async () => {
  const base = { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 2000, sourceStockInHand: 300, sourceSafetyStock: 10, sourceForecastDemand: 90, sourceSurplus: 200, destinationCurrentStock: 0,
    destinationSafetyStock: 0, destinationForecastDemand: 900, destinationShortage: 900, recommendedQuantity: 200, priority: "CRITICAL", reason: "r" };
  const errorsOf = (doc) => doc.validate().then(() => ({}), (e) => e.errors);
  assert.deepEqual(await errorsOf(new DistributionRecommendation(base)), {});
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, sourceSurplus: 1900, recommendedQuantity: 900 }))).sourceSurplus);
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, sourceStockInHand: 2500 }))).sourceStockInHand);
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, sourceStockInHand: undefined }))).sourceStockInHand, "required snapshot");
});

test("open commitments: outbound REQUESTED/APPROVED reduce source availability; inbound reduce destination need; dispatched not double-counted", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 300 }, "MAT1|D3": { stock: 0, demand: 100 } },
    openTransfers: [
      { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", status: "APPROVED", requestedQuantity: 200, approvedQuantity: 150 }, // counts 150 (approved), not 200
      { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", status: "REQUESTED", requestedQuantity: 40 },
      { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", status: "DISPATCHED", requestedQuantity: 999, approvedQuantity: 999 }, // already in stock figures
    ],
  });
  const { store } = memoryStore(t);
  const r = await run();
  const src = r.sourcePositions.find((p) => p.depotId === "D1");
  assert.deepEqual([src.stockInHand, src.openCommitments, src.surplus], [500, 190, 280], "500 − 190 committed − 0 safety − 30 demand");
  const d2 = r.destinationPositions.find((p) => p.depotId === "D2");
  const d3 = r.destinationPositions.find((p) => p.depotId === "D3");
  assert.deepEqual([d2.openInbound, d2.shortage, d3.openInbound, d3.shortage], [150, 150, 40, 60]);
  assert.equal(r.totalRecommendedQuantity, 210, "150 + 60, all within the uncommitted 280");
  const rec = store.find((d) => d.destinationDepotId === "D2");
  assert.deepEqual([rec.sourceOpenCommitments, rec.destinationOpenInbound], [190, 150]);
  assert.match(rec.reason, /190 committed to open transfers/);
  assert.match(rec.reason, /150 already on open inbound transfers/);
});

test("engine: every persisted quantity is a finite whole number ≥ 0 and passes the model rules", async (t) => {
  mockWorld(t, { positions: { "MAT1|D1": { stock: 999, demand: 100.4, ss: 7 }, "MAT1|D2": { stock: 3, demand: 250.6, ss: 9 } } });
  const { store } = memoryStore(t);
  await run();
  const numeric = ["sourceCurrentStock", "sourceStockInHand", "sourceSafetyStock", "sourceForecastDemand", "sourceSurplus", "destinationCurrentStock",
    "destinationSafetyStock", "destinationForecastDemand", "destinationShortage", "recommendedQuantity"];
  for (const d of store) {
    numeric.forEach((k) => assert.ok(Number.isInteger(d[k]) && d[k] >= 0, `${k}=${d[k]}`));
    await new DistributionRecommendation(d).validate(); // throws on any rule violation, including cross-field rules
  }
});

test("engine: missing forecast is never treated as zero — the depot is excluded and reported", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT1|D3": { stock: 0, demand: 100 } },
    noForecast: ["MAT1|D3"],
    incompleteForecast: ["MAT1|D2"],
  });
  memoryStore(t);
  const r = await run();
  assert.equal(r.recommendations.length, 0, "D2/D3 excluded, so nobody to receive");
  assert.deepEqual(r.skipped.map((s) => [s.depotId, s.reasons]), [["D2", ["MISSING_FORECAST"]], ["D3", ["MISSING_FORECAST"]]]);
  assert.equal(r.skipped[0].forecastMonthsAvailable, 2);
  assert.equal(r.skipped[0].forecastMonthsRequired, 3);
});

test("engine: missing mapping — unmapped depots skipped, unmapped stock plants reported", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 } },
    mappings: [{ depotId: "D1", plantName: "D1 Plant", isActive: true }],
    extraStock: [{ MatNo: "MAT1", PlantName: "Ghost Plant", TotalStockQty: 5, SIHQty: 5, StockDate: new Date("2026-10-05") }],
  });
  memoryStore(t);
  const r = await run();
  assert.deepEqual(r.skipped.filter((s) => s.reasons.includes("DEPOT_NOT_MAPPED")).map((s) => s.depotId), ["D2", "D3"]);
  assert.deepEqual(r.dataQualityWarnings.unmappedStockPlants.map((p) => p.plantName).sort(), ["D2 Plant", "Ghost Plant"]);
  assert.equal(r.recommendations.length, 0);
});

test("engine: missing safety stock excludes the depot unless the zero fallback is explicitly requested", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT1|D3": { stock: 0, demand: 100, ss: 5 } },
    noSafety: ["MAT1|D2"],
    safetyStatus: { "MAT1|D3": "ERROR" },
  });
  memoryStore(t);
  let r = await run({ dryRun: true });
  assert.deepEqual(r.skipped.map((s) => [s.depotId, s.reasons]), [["D2", ["MISSING_SAFETY_STOCK"]], ["D3", ["MISSING_SAFETY_STOCK"]]]);
  assert.equal(r.recommendations.length, 0);

  r = await run({ dryRun: true, allowMissingSafetyStock: true });
  assert.deepEqual(r.dataQualityWarnings.safetyStockZeroFallback, [{ materialNo: "MAT1", depotId: "D2" }, { materialNo: "MAT1", depotId: "D3" }]);
  assert.deepEqual(r.destinationPositions.map((p) => [p.depotId, p.safetyStock, p.safetyStockSource]), [["D2", 0, "ZERO_FALLBACK"], ["D3", 0, "ZERO_FALLBACK"]]);
  assert.equal(r.recommendations.length, 2);
});

test("engine: inactive/discontinued materials are skipped; unknown requested materials reported", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT2|D1": { stock: 500, demand: 0 }, "MAT2|D2": { stock: 0, demand: 90 } },
    materials: [{ materialNo: "MAT1", status: "STD", isActive: true }, { materialNo: "MAT2", status: "Discontinued", isActive: true }],
    depots: ["D1", "D2"],
  });
  memoryStore(t);
  let r = await run({ dryRun: true });
  assert.equal(r.materialsEvaluated, 1);
  assert.deepEqual(r.skipped, [{ materialNo: "MAT2", depotId: null, reasons: ["MATERIAL_INACTIVE"] }]);
  assert.ok(r.recommendations.every((d) => d.materialNo === "MAT1"));

  r = await run({ dryRun: true, materialNos: ["mat1", "NOPE"] });
  assert.deepEqual(r.skipped, [{ materialNo: "NOPE", depotId: null, reasons: ["MATERIAL_NOT_FOUND"] }]);
});

test("engine: missing or invalid stock excludes the depot; only the latest stock snapshot counts", async (t) => {
  mockWorld(t, {
    positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT1|D3": { stock: 0, demand: 100 } },
    noStock: ["MAT1|D3"],
    extraStock: [
      { MatNo: "MAT1", PlantName: "D1 Plant", TotalStockQty: 9999, SIHQty: 9999, StockDate: new Date("2026-01-01") }, // older snapshot, ignored
      { MatNo: "MAT1", PlantName: "D2 Plant", TotalStockQty: -4, SIHQty: 0, StockDate: new Date("2026-10-05") }, // invalid
    ],
  });
  memoryStore(t);
  const r = await run({ dryRun: true });
  assert.deepEqual(r.skipped.map((s) => [s.depotId, s.reasons]), [["D2", ["INVALID_STOCK"]], ["D3", ["MISSING_STOCK"]]]);
  assert.deepEqual(r.sourcePositions.map((p) => [p.depotId, p.currentStock]), [["D1", 500]]);
});

// ─── Generation runs ─────────────────────────────────────────────────────────

const WORLD = { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT1|D3": { stock: 10, demand: 60 } };

test("generationRunId: unique per run and shared by every recommendation in the run", async (t) => {
  mockWorld(t, { positions: WORLD });
  const { store } = memoryStore(t);
  const a = await run();
  const b = await run();
  assert.match(a.generationRunId, /^DRUN-20261014T\d{6}Z-[0-9A-F]{6}$/);
  assert.notEqual(a.generationRunId, b.generationRunId);
  assert.equal(new Set(store.filter((d) => d.generationRunId === a.generationRunId).map((d) => d.generationRunId)).size, 1);
  assert.equal(store.filter((d) => d.generationRunId === a.generationRunId).length, a.recommendationsCreated);
});

test("re-generation supersedes the previous PENDING set (status + audit fields), nothing is deleted", async (t) => {
  mockWorld(t, { positions: WORLD });
  const { store, calls } = memoryStore(t);
  const first = await run();
  const second = await run();
  assert.equal(second.supersededCount, first.recommendationsCreated);
  assert.equal(store.length, first.recommendationsCreated + second.recommendationsCreated, "history kept");
  store.filter((d) => d.generationRunId === first.generationRunId).forEach((d) => {
    assert.equal(d.status, "SUPERSEDED");
    assert.equal(d.supersededByRunId, second.generationRunId);
    assert.ok(d.supersededAt instanceof Date);
  });
  assert.ok(store.filter((d) => d.generationRunId === second.generationRunId).every((d) => d.status === "PENDING"));
  const order = calls.filter((c) => c[0] !== "deleteMany").map((c) => c[0]);
  assert.deepEqual(order.slice(-2), ["updateMany", "insertMany"], "supersede before insert (PENDING unique index)");
  assert.ok(!calls.some((c) => c[0] === "deleteMany"));
});

test("APPROVED and REJECTED history is never modified by a new run", async (t) => {
  mockWorld(t, { positions: WORLD });
  const period = { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 };
  const approved = { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: period, status: "APPROVED", approvedQuantity: 50, reviewedBy: "admin", generationRunId: "OLD" };
  const rejected = { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", forecastPeriod: period, status: "REJECTED", reviewedBy: "admin", generationRunId: "OLD" };
  const { store } = memoryStore(t, [approved, rejected]);
  const before = JSON.stringify(store);
  const r = await run();
  assert.equal(r.supersededCount, 0);
  assert.equal(JSON.stringify(store.slice(0, 2)), before, "approved/rejected records byte-identical after the run");
  assert.ok(r.recommendationsCreated > 0, "the new run still produced its own PENDING suggestions");
});

test("supersede scope: same period + fully re-evaluated routes only; other periods and un-evaluated routes stay PENDING (reported)", async (t) => {
  mockWorld(t, { positions: WORLD, noForecast: ["MAT1|D3"] }); // D3 cannot be re-evaluated this run
  const oct = { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 };
  const sep = { financialYear: "2026-27", startMonth: "September", horizonMonths: 3 };
  const { store } = memoryStore(t, [
    { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: oct, status: "PENDING", generationRunId: "OLD" }, // re-evaluated → superseded
    { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", forecastPeriod: oct, status: "PENDING", generationRunId: "OLD" }, // D3 skipped → kept
    { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: sep, status: "PENDING", generationRunId: "OLD" }, // other period → kept
  ]);
  const r = await run();
  assert.equal(r.supersededCount, 1);
  assert.deepEqual(store.slice(0, 3).map((d) => d.status), ["SUPERSEDED", "PENDING", "PENDING"]);
  assert.equal(r.dataQualityWarnings.pendingRecommendationsNotReevaluated, 2);
});

test("duplicate prevention: one recommendation per material + route + period per run, and never two PENDING for the same route", async (t) => {
  mockWorld(t, { positions: { ...WORLD, "MAT1|D3": { stock: 0, demand: 400 } } });
  const { store } = memoryStore(t);
  for (let i = 0; i < 3; i += 1) await run();
  const pending = store.filter((d) => d.status === "PENDING");
  const keys = pending.map((d) => `${route(d)}|${d.forecastPeriod.financialYear}|${d.forecastPeriod.startMonth}`);
  assert.equal(new Set(keys).size, keys.length);
  const runKeys = store.map((d) => `${d.generationRunId}|${route(d)}`);
  assert.equal(new Set(runKeys).size, runKeys.length);
  const idx = DistributionRecommendation.schema.indexes().filter(([, o]) => o.unique).map(([f]) => Object.keys(f));
  assert.ok(idx.some((k) => k[0] === "generationRunId" && k.includes("destinationDepotId")), "run-level unique index");
  assert.ok(idx.some((k) => k[0] === "materialNo" && k.includes("forecastPeriod.startMonth")), "PENDING unique index");
});

test("failed insert rolls the run back: its records removed, superseded records restored to PENDING", async (t) => {
  mockWorld(t, { positions: WORLD });
  const { store } = memoryStore(t);
  const first = await run();
  const before = JSON.stringify(store.map((d) => [d.status, d.supersededByRunId]));
  t.mock.method(DistributionRecommendation, "insertMany", async () => { throw new Error("disk full"); });
  await assert.rejects(run(), /disk full/);
  assert.equal(JSON.stringify(store.map((d) => [d.status, d.supersededByRunId])), before);
  assert.ok(store.every((d) => d.generationRunId === first.generationRunId));
});

test("dry run returns the full plan but writes nothing", async (t) => {
  mockWorld(t, { positions: WORLD });
  const { store, calls } = memoryStore(t);
  const r = await run({ dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.recommendationsCreated, 0);
  assert.ok(r.recommendations.length > 0);
  assert.equal(store.length, 0);
  assert.ok(!calls.some((c) => ["updateMany", "insertMany", "deleteMany"].includes(c[0])));
});

test("snapshot integrity: persisted snapshot fields are immutable", () => {
  const doc = DistributionRecommendation.hydrate(new DistributionRecommendation({
    materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 500, sourceStockInHand: 500, sourceSafetyStock: 0, sourceForecastDemand: 30, sourceSurplus: 470, destinationCurrentStock: 0, destinationSafetyStock: 0,
    destinationForecastDemand: 100, destinationShortage: 100, recommendedQuantity: 100, priority: "CRITICAL", reason: "r", generationRunId: "R1", generatedBy: "admin",
  }).toObject());
  for (const [field, value] of [["sourceCurrentStock", 1], ["destinationShortage", 1], ["recommendedQuantity", 1], ["generationRunId", "X"], ["generatedBy", "x"], ["reason", "x"]]) {
    const original = doc[field];
    doc[field] = value;
    assert.equal(doc[field], original, field);
  }
});

test("model: recommended quantity can never exceed the destination shortage; snapshot quantities must be whole numbers", async () => {
  // validate() — the cross-field rules live in pre("validate"), which validateSync() does not run.
  const errorsOf = (doc) => doc.validate().then(() => ({}), (e) => e.errors);
  const base = { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 500, sourceStockInHand: 500, sourceSafetyStock: 0, sourceForecastDemand: 30, sourceSurplus: 470, destinationCurrentStock: 0, destinationSafetyStock: 0,
    destinationForecastDemand: 100, destinationShortage: 100, recommendedQuantity: 100, priority: "LOW", reason: "r" };
  assert.deepEqual(await errorsOf(new DistributionRecommendation(base)), {});
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, recommendedQuantity: 101 }))).recommendedQuantity);
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, destinationForecastDemand: 99.5 }))).destinationForecastDemand);
  assert.ok((await errorsOf(new DistributionRecommendation({ ...base, supersededByRunId: "R2" }))).supersededByRunId, "only on SUPERSEDED");
});

test("empty dataset: no materials → nothing evaluated, flagged; no forecast window → 422", async (t) => {
  mockWorld(t, { positions: {}, materials: [] });
  memoryStore(t);
  const r = await run();
  assert.equal(r.materialsEvaluated, 0);
  assert.equal(r.recommendationsCreated, 0);
  assert.equal(r.dataQualityWarnings.noEvaluableMaterials, true);

  t.mock.restoreAll();
  mockWorld(t, { positions: WORLD, months: [] });
  memoryStore(t);
  await assert.rejects(run(), (e) => e.status === 422 && /No forecast window/.test(e.message));
});

test("horizon longer than the forecast window → 422; concurrent runs → 409", async (t) => {
  mockWorld(t, { positions: WORLD });
  memoryStore(t);
  await assert.rejects(run({ horizonMonths: 6 }), (e) => e.status === 422 && /exceeds the current forecast window \(3 months\)/.test(e.message));
  const [a, b] = await Promise.allSettled([run({ dryRun: true }), run({ dryRun: true })]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.status, 409);
});

// ─── Request validation ──────────────────────────────────────────────────────

test("request validation: defaults, accepted shapes and malformed input", () => {
  assert.deepEqual(parseGenerateBody({}), { options: {} });
  assert.deepEqual(parseGenerateBody(undefined), { options: {} });
  assert.deepEqual(parseGenerateBody({ horizonMonths: 6, materialNo: "MAT1, MAT2", dryRun: true, allowMissingSafetyStock: false }),
    { options: { horizonMonths: 6, materialNos: ["MAT1", "MAT2"], dryRun: true, allowMissingSafetyStock: false } });
  assert.deepEqual(parseGenerateBody({ materialNo: ["MAT1"] }).options.materialNos, ["MAT1"]);
  for (const bad of [[1], "x", { horizonMonths: "3" }, { horizonMonths: 0 }, { horizonMonths: 13 }, { horizonMonths: 1.5 }, { materialNo: [] },
    { materialNo: 5 }, { materialNo: ["MAT1", ""] }, { dryRun: "yes" }, { allowMissingSafetyStock: 1 }, { mode: "FAST" }]) {
    assert.ok(parseGenerateBody(bad).errors?.length, JSON.stringify(bad));
  }
});

// ─── API ─────────────────────────────────────────────────────────────────────

test("API: POST /recommendations/generate — auth, 201/200 responses, 400/409/422 handling, run lookup", async (t) => {
  const admin = { _id: new mongoose.Types.ObjectId(), username: "admin", role: "ADMIN", isActive: true };
  const employee = { _id: new mongoose.Types.ObjectId(), username: "employee", role: "USER", isActive: true };
  t.mock.method(User, "findById", async (id) => [admin, employee].find((u) => String(u._id) === String(id)) || null);
  t.mock.method(console, "error", () => {});
  mockWorld(t, { positions: WORLD });
  const { store } = memoryStore(t);
  const findCalls = [];
  t.mock.method(DistributionRecommendation, "find", (filter) => {
    findCalls.push(filter);
    const q = { sort: () => q, skip: () => q, limit: () => q, lean: async () => store.filter((d) => d.generationRunId === filter.generationRunId?.$in?.[0]) };
    return q;
  });

  const app = express();
  app.use(express.json());
  app.use("/api/distribution", distributionRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/distribution`;
  const call = async (method, path, { user = admin, body } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (user) headers.Authorization = `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET)}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await call("POST", "/recommendations/generate", { user: null, body: {} })).status, 401);
  assert.equal((await call("POST", "/recommendations/generate", { user: employee, body: {} })).status, 403);
  assert.equal(store.length, 0, "rejected callers never generate");

  const bad = await call("POST", "/recommendations/generate", { body: { horizonMonths: "three", extra: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.length, 2);

  const dry = await call("POST", "/recommendations/generate", { body: { dryRun: true } });
  assert.equal(dry.status, 200);
  assert.equal(store.length, 0);

  const created = await call("POST", "/recommendations/generate", { body: {} });
  assert.equal(created.status, 201);
  for (const key of ["generationRunId", "materialsEvaluated", "sourcePositions", "destinationPositions", "recommendationsCreated", "skipped", "dataQualityWarnings", "forecastPeriod", "unfulfilledShortages"]) {
    assert.ok(key in created.body, key);
  }
  assert.equal(created.body.recommendationsCreated, store.length);
  assert.equal(store[0].generatedBy, "admin");

  const byRun = await call("GET", `/recommendations?generationRunId=${created.body.generationRunId}`);
  assert.equal(byRun.status, 200);
  assert.deepEqual(findCalls.at(-1).generationRunId, { $in: [created.body.generationRunId] });
  assert.equal(byRun.body.data.length, created.body.recommendationsCreated);

  // One mock, re-implemented per case (mocking the same method repeatedly would not restore cleanly).
  const gen = t.mock.method(engine, "generateRecommendations", async () => { const e = new Error("busy"); e.status = 409; throw e; });
  assert.equal((await call("POST", "/recommendations/generate", { body: {} })).status, 409);
  gen.mock.mockImplementation(async () => { const e = new Error("no window"); e.status = 422; throw e; });
  assert.equal((await call("POST", "/recommendations/generate", { body: {} })).status, 422);
  gen.mock.mockImplementation(async () => { throw new Error("boom"); });
  const boom = await call("POST", "/recommendations/generate", { body: {} });
  assert.equal(boom.status, 500);
  assert.doesNotMatch(boom.body.message, /boom/);
});

test("generation never creates transfers: transfer writes exist only as guarded Stage 4 lifecycle routes", () => {
  const { requireTransactions } = require("../utils/transactions");
  const writes = distributionRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/transfers") && !l.route.methods.get);
  assert.ok(writes.length > 0);
  writes.forEach((l) => assert.equal(l.route.stack[0].handle, requireTransactions, l.route.path));
});

// ─── Minimum transfer quantity ───────────────────────────────────────────────

const MIN = { minTransferQuantity: 10 };
const routeQty = (m) => `${m.source.depotId}>${m.destination.depotId}:${m.quantity}`;

test("min transfer: default is 10 units, from config/distribution.js", () => {
  assert.equal(distributionConfig.DEFAULT_MIN_TRANSFER_QUANTITY, 10);
  assert.equal(distributionConfig.resolveMinTransferQuantity("ANY"), 10);
});

test("min transfer: quantity below the minimum is not created and never rounded up", () => {
  const positions = buildPositions([pos("S", 1000, 0), pos("D", 0, 9)]);
  const { matches, filtered, unfulfilled } = matchMaterial(positions, MIN);
  assert.deepEqual(matches, [], "no 9-unit recommendation, and no 10-unit round-up");
  assert.deepEqual(filtered, [{ materialNo: "MAT1", sourceDepotId: "S", destinationDepotId: "D", quantity: 9, sourceRemainingSurplus: 1000, minTransferQuantity: 10, reason: "MIN_TRANSFER_QUANTITY" }]);
  assert.deepEqual(unfulfilled, [{ materialNo: "MAT1", depotId: "D", shortage: 9, covered: 0, uncovered: 9 }]);
});

test("min transfer: quantity exactly at the minimum is created; above it too", () => {
  assert.deepEqual(matchMaterial(buildPositions([pos("S", 1000, 0), pos("D", 0, 10)]), MIN).matches.map(routeQty), ["S>D:10"]);
  assert.deepEqual(matchMaterial(buildPositions([pos("S", 1000, 0), pos("D", 0, 11)]), MIN).matches.map(routeQty), ["S>D:11"]);
  // Limited by the source's surplus rather than the shortage — same rule.
  assert.deepEqual(matchMaterial(buildPositions([pos("S", 10, 0), pos("D", 0, 500)]), MIN).matches.map(routeQty), ["S>D:10"]);
  assert.deepEqual(matchMaterial(buildPositions([pos("S", 9, 0), pos("D", 0, 500)]), MIN).filtered.map((f) => f.quantity), [9]);
});

test("min transfer: a split whose final allocation is below the minimum is filtered; that source's surplus stays available", () => {
  // D1 needs 105: S1 gives 100, the 5-unit remainder from S2 is filtered — S2's 50 is NOT consumed and serves D2.
  const positions = buildPositions([pos("S1", 100, 0), pos("S2", 50, 0), pos("D1", 0, 105), pos("D2", 0, 40)]);
  const { matches, filtered, unfulfilled } = matchMaterial(positions, MIN);
  assert.deepEqual(matches.map(routeQty), ["S1>D1:100", "S2>D2:40"]);
  assert.deepEqual(filtered.map((f) => [f.sourceDepotId, f.destinationDepotId, f.quantity, f.sourceRemainingSurplus]), [["S2", "D1", 5, 50]]);
  assert.deepEqual(unfulfilled, [{ materialNo: "MAT1", depotId: "D1", shortage: 105, covered: 100, uncovered: 5 }]);
  // Without the minimum the 5 units would have been taken from S2, leaving D2 short.
  assert.deepEqual(matchMaterial(positions, { minTransferQuantity: 1 }).matches.map(routeQty), ["S1>D1:100", "S2>D1:5", "S2>D2:40"]);
});

test("min transfer: positions (surplus/shortage) are never altered by filtering; totals stay within surplus", () => {
  const raw = [pos("S1", 100, 0), pos("S2", 55, 50), pos("D1", 0, 105), pos("D2", 3, 10)];
  const positions = buildPositions(raw);
  const snapshot = JSON.stringify(positions);
  const { matches } = matchMaterial(positions, MIN);
  assert.equal(JSON.stringify(positions), snapshot, "matching never mutates positions");
  const out = {};
  matches.forEach((m) => { out[m.source.depotId] = (out[m.source.depotId] || 0) + m.quantity; });
  positions.filter((p) => p.surplus > 0).forEach((p) => assert.ok((out[p.depotId] || 0) <= p.surplus));
  assert.ok(matches.every((m) => m.quantity >= 10 && m.quantity <= m.destination.shortage));
});

test("min transfer: deterministic — any input order gives identical matches and filtered opportunities", () => {
  const raw = [pos("S1", 100, 0), pos("S2", 50, 0), pos("S3", 7, 0), pos("D1", 0, 105), pos("D2", 0, 40), pos("D3", 0, 6), pos("D4", 0, 60)];
  const key = (r) => { const out = matchMaterial(buildPositions(r), MIN); return JSON.stringify([out.matches.map(routeQty), out.filtered, out.unfulfilled]); };
  const expected = key(raw);
  assert.equal(key([...raw].reverse()), expected);
  for (let i = 0; i < 8; i += 1) assert.equal(key([...raw].sort(() => (Math.cos(i * 31 + 7) > 0 ? 1 : -1))), expected);
});

test("min transfer (engine): only allocations ≥ minimum are persisted; filtered ones reported; snapshots unaffected", async (t) => {
  mockWorld(t, { positions: {
    "MAT1|D1": { stock: 500, demand: 30 }, // surplus 470
    "MAT1|D2": { stock: 0, demand: 465 }, // shortage 465 → 465
    "MAT1|D3": { stock: 0, demand: 8 }, // shortage 8 → 5 left at D1 would be < 10 anyway; 8 < 10 → filtered
  } });
  const { store } = memoryStore(t);
  const r = await run();
  assert.equal(r.minTransferQuantity, 10);
  assert.deepEqual(store.map((d) => `${d.sourceDepotId}>${d.destinationDepotId}:${d.recommendedQuantity}`), ["D1>D2:465"]);
  assert.equal(r.recommendationsFiltered, 1);
  assert.deepEqual(r.filteredRecommendations, [{ materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", quantity: 5, sourceRemainingSurplus: 5, minTransferQuantity: 10, reason: "MIN_TRANSFER_QUANTITY" }]);
  assert.deepEqual(r.unfulfilledShortages, [{ materialNo: "MAT1", depotId: "D3", shortage: 8, covered: 0, uncovered: 8 }]);
  assert.deepEqual(r.sourcePositions.map((p) => [p.depotId, p.surplus]), [["D1", 470]], "surplus unchanged by filtering");
  assert.deepEqual(r.destinationPositions.map((p) => [p.depotId, p.shortage]), [["D2", 465], ["D3", 8]]);
  assert.equal(store[0].sourceSurplus, 470);
  assert.deepEqual(r.skipped, [], "filtered opportunities are reported separately from skipped positions");
});

test("min transfer (engine): global value configurable via DISTRIBUTION_MIN_TRANSFER_QUANTITY; invalid values fall back to 10", async (t) => {
  const prev = process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY;
  t.after(() => { if (prev === undefined) delete process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY; else process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY = prev; });
  t.mock.method(console, "warn", () => {});
  mockWorld(t, { positions: { "MAT1|D1": { stock: 500, demand: 30 }, "MAT1|D2": { stock: 0, demand: 40 } } , depots: ["D1", "D2"] });
  memoryStore(t);
  process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY = "50";
  let r = await run({ dryRun: true });
  assert.equal(r.minTransferQuantity, 50);
  assert.equal(r.recommendations.length, 0, "40 < 50");
  process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY = "zero";
  r = await run({ dryRun: true });
  assert.equal(r.minTransferQuantity, 10);
  assert.equal(r.recommendations.length, 1);
});

test("min transfer (engine): resolved per material through the single config seam (future material-level override)", async (t) => {
  mockWorld(t, { positions: {
    "MAT1|D1": { stock: 500, demand: 0 }, "MAT1|D2": { stock: 0, demand: 30 },
    "MAT2|D1": { stock: 500, demand: 0 }, "MAT2|D2": { stock: 0, demand: 30 },
  }, depots: ["D1", "D2"] });
  memoryStore(t);
  const seam = t.mock.method(distributionConfig, "resolveMinTransferQuantity", (materialNo) => (materialNo === "MAT2" ? 50 : 10));
  const r = await run({ dryRun: true });
  assert.deepEqual(seam.mock.calls.map((c) => c.arguments[0]).sort(), ["MAT1", "MAT2"]);
  assert.deepEqual(r.recommendations.map((d) => d.materialNo), ["MAT1"]);
  assert.deepEqual(r.filteredRecommendations.map((f) => [f.materialNo, f.quantity, f.sourceRemainingSurplus, f.minTransferQuantity]), [["MAT2", 30, 500, 50]]);
  assert.deepEqual(r.minTransferQuantity, { MAT1: 10, MAT2: 50 });
});

test("min transfer: one leftover source surplus filtered against several destinations reports the SAME sourceRemainingSurplus (not additive)", async (t) => {
  // MAT0014-style: S has 106 surplus; D1 takes 100, leaving 6 — below the minimum for every other destination.
  const positions = buildPositions([pos("S", 106, 0), pos("D1", 0, 100), pos("D2", 0, 30), pos("D3", 0, 20), pos("D4", 0, 15)]);
  const { matches, filtered, unfulfilled } = matchMaterial(positions, MIN);
  assert.deepEqual(matches.map(routeQty), ["S>D1:100"]);
  assert.deepEqual(filtered.map((f) => [f.destinationDepotId, f.quantity, f.sourceRemainingSurplus]), [["D2", 6, 6], ["D3", 6, 6], ["D4", 6, 6]]);
  const filteredSum = filtered.reduce((s, f) => s + f.quantity, 0);
  assert.equal(filteredSum, 18, "the entries' quantities overlap…");
  assert.equal(new Set(filtered.map((f) => `${f.sourceDepotId}:${f.sourceRemainingSurplus}`)).size, 1, "…they all describe the same 6 units at S");
  assert.equal(positions[0].surplus - matches.reduce((s, m) => s + m.quantity, 0), 6, "only 6 units actually remain at the source");
  assert.deepEqual(unfulfilled.map((u) => [u.depotId, u.uncovered]), [["D2", 30], ["D3", 20], ["D4", 15]]);

  // Engine: reported in the response only — never persisted on recommendations.
  mockWorld(t, { positions: { "MAT1|D1": { stock: 106, demand: 0 }, "MAT1|D2": { stock: 0, demand: 100 }, "MAT1|D3": { stock: 0, demand: 30 } }, depots: ["D1", "D2", "D3"] });
  const { store } = memoryStore(t);
  const r = await run();
  assert.deepEqual(r.filteredRecommendations.map((f) => [f.sourceDepotId, f.destinationDepotId, f.sourceRemainingSurplus]), [["D1", "D3", 6]]);
  assert.ok(store.every((d) => !("sourceRemainingSurplus" in d)));
  assert.equal(DistributionRecommendation.schema.path("sourceRemainingSurplus"), undefined, "not part of the persisted model");
});
