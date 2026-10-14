/**
 * Distribution Stage 2 — depot demand aggregation + depot safety stock tests.
 *
 * DB-free: ForecastPredictions / Material / Sales / DepotPlantMapping / Depot
 * reads and the ML backtest call are mocked; the clock is injected.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const ForecastPredictions = require("../models/ForecastPredictions");
const Material = require("../models/Material");
const Sales = require("../models/Sales");
const Depot = require("../models/Depot");
const DepotPlantMapping = require("../models/DepotPlantMapping");
const DepotSafetyStock = require("../models/DepotSafetyStock");
const ForecastErrorStats = require("../models/ForecastErrorStats");
const mlServiceClient = require("../services/mlServiceClient");
const { getDepotDemand } = require("../services/depotDemandService");
const { computeDepotSafetyStock, refreshDepotSafetyStock } = require("../services/depotSafetyStockService");
const { calculateSafetyStockForMaterial } = require("../services/safetyStockService");

// 13 Oct 2026 → working quarter Q3; latest actual Sales month = September 2026
// → horizon rule window = October 2026 … June 2027 (9 months).
const NOW = new Date(2026, 9, 13, 12);
const WINDOW = [["2026-27", "October"], ["2026-27", "November"], ["2026-27", "December"], ["2026-27", "January"],
  ["2026-27", "February"], ["2026-27", "March"], ["2027-28", "April"], ["2027-28", "May"], ["2027-28", "June"]];

const pred = (materialNo, plant, financialYear, month, qty, model = "XGBoost") => ({ materialNo, plant, financialYear, month, predictedSalesQty: qty, model });

/** Full forecasts for every window month for the given material × plants. */
function fullForecast(materialNo, plants, qty = 10) {
  return plants.flatMap((plant) => WINDOW.map(([fy, m]) => pred(materialNo, plant, fy, m, qty)));
}

function setup(t, { predictions, mappings, depots = ["D1", "D2"], materials = ["MAT1", "MAT2"], salesPeriods = [["2026-27", "September"], ["2026-27", "August"]] }) {
  t.mock.method(ForecastPredictions, "find", (filter) => ({
    lean: async () => (filter.materialNo ? predictions.filter((p) => filter.materialNo.$in.includes(p.materialNo)) : predictions),
  }));
  t.mock.method(Material, "find", () => ({ select: () => ({ lean: async () => materials.map((materialNo) => ({ materialNo })) }) }));
  t.mock.method(Sales, "aggregate", async () => salesPeriods.map(([fy, month]) => ({ _id: { fy, month } })));
  t.mock.method(DepotPlantMapping, "find", () => ({ lean: async () => mappings }));
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => depots.map((depotId) => ({ depotId, depotName: `Depot ${depotId}` })) }) }));
}

const active = (depotId, plantName) => ({ depotId, plantName, isActive: true });

// ─── Depot demand ────────────────────────────────────────────────────────────

test("demand: window follows the existing horizon rule (month after latest actual → end of working quarter + 2)", async (t) => {
  setup(t, { predictions: [...fullForecast("MAT1", ["P1"]), ...fullForecast("MAT2", ["P1"])], mappings: [active("D1", "P1")], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  assert.equal(r.window.source, "forecastHorizonRule");
  assert.deepEqual(r.window.latestActualMonth, { financialYear: "2026-27", month: "September" });
  assert.deepEqual(r.window.months.map((m) => [m.financialYear, m.month]), WINDOW);
  assert.equal(r.integrity.status, "OK");
  assert.equal(r.summary.rows, 18);

  const limited = await getDepotDemand({ horizonMonths: "3" }, NOW);
  assert.deepEqual(limited.window.months.map((m) => m.month), ["October", "November", "December"]);
  assert.equal(limited.data.length, 6);
  // Window months past the requested horizon are not an integrity problem.
  assert.equal(limited.integrity.status, "OK");
  assert.deepEqual(limited.integrity.excludedForecastMonths, []);
  assert.equal(limited.summary.predictionsBeyondRequestedHorizon, 2 * 6);
});

test("demand: plants feeding the same depot are summed per Material × Depot × Month", async (t) => {
  setup(t, {
    predictions: [...fullForecast("MAT1", ["P1"], 10.25), ...fullForecast("MAT1", ["P2"], 5), ...fullForecast("MAT1", ["P3"], 7)],
    mappings: [active("D1", "P1"), active("D1", "P2"), active("D2", "P3")],
    materials: ["MAT1"],
  });
  const r = await getDepotDemand({}, NOW);
  const oct = r.data.filter((row) => row.month === "October");
  assert.deepEqual(oct.map((row) => [row.depotId, row.forecastDemand, row.sourcePlants, row.predictionCount, row.complete]), [
    ["D1", 15.3, ["P1", "P2"], 2, true],
    ["D2", 7, ["P3"], 1, true],
  ]);
  assert.equal(oct[0].depotName, "Depot D1");
  assert.equal(oct[0].quarter, "Q3");
  assert.equal(r.summary.totalForecastDemand, Math.round(9 * (10.25 + 5 + 7) * 10) / 10);
});

test("demand: unmapped plants are excluded from demand and reported", async (t) => {
  setup(t, { predictions: [...fullForecast("MAT1", ["P1"]), ...fullForecast("MAT1", ["P9"])], mappings: [active("D1", "P1")], materials: ["MAT1"], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  assert.deepEqual(r.integrity.unmappedPlants, [{ plantName: "P9", predictionCount: 9 }]);
  assert.ok(r.data.every((row) => row.sourcePlants.join() === "P1"));
  assert.equal(r.integrity.status, "ISSUES_FOUND");
});

test("demand: plants with only INACTIVE mappings are reported separately and excluded", async (t) => {
  setup(t, {
    predictions: [...fullForecast("MAT1", ["P1"]), ...fullForecast("MAT1", ["P2"])],
    mappings: [active("D1", "P1"), { depotId: "D2", plantName: "P2", isActive: false }],
    materials: ["MAT1"],
  });
  const r = await getDepotDemand({}, NOW);
  assert.deepEqual(r.integrity.inactiveMappingPlants, [{ plantName: "P2", predictionCount: 9, inactiveDepotIds: ["D2"] }]);
  assert.deepEqual(r.integrity.unmappedPlants, []);
  assert.deepEqual(r.integrity.depotsWithoutActiveMapping, ["D2"]);
  assert.ok(!r.data.some((row) => row.depotId === "D2"));
});

test("demand: an active mapping that points at a depot missing from Depot Master is reported, never used", async (t) => {
  setup(t, { predictions: fullForecast("MAT1", ["P1", "P2"]), mappings: [active("D1", "P1"), active("GONE", "P2")], materials: ["MAT1"], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  assert.deepEqual(r.integrity.mappingsToUnknownDepots, [{ plantName: "P2", depotId: "GONE" }]);
  assert.deepEqual(r.integrity.unmappedPlants, [{ plantName: "P2", predictionCount: 9 }]);
  assert.ok(!r.data.some((row) => row.depotId === "GONE"));
});

test("demand: missing forecasts are listed (never zero-filled) and mark partial depot cells incomplete", async (t) => {
  const predictions = [...fullForecast("MAT1", ["P1"]), ...fullForecast("MAT1", ["P2"]).filter((p) => p.month !== "October")];
  setup(t, { predictions, mappings: [active("D1", "P1"), active("D1", "P2")], materials: ["MAT1", "MAT2"], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  const { missingForecasts } = r.integrity;
  // MAT1@P2 October + MAT2 (operational material, no forecasts at all) × 2 plants × 9 months.
  assert.equal(missingForecasts.count, 1 + 18);
  assert.deepEqual(missingForecasts.items[0], { materialNo: "MAT1", plantName: "P2", depotId: "D1", financialYear: "2026-27", month: "October", quarter: "Q3" });
  const oct = r.data.find((row) => row.materialNo === "MAT1" && row.month === "October");
  assert.equal(oct.forecastDemand, 10);
  assert.equal(oct.complete, false);
  assert.ok(!r.data.some((row) => row.materialNo === "MAT2"), "no fabricated zero rows");
});

test("demand: stale (already-actual) and out-of-horizon forecast months are excluded and reported", async (t) => {
  const predictions = [
    ...fullForecast("MAT1", ["P1"]),
    pred("MAT1", "P1", "2026-27", "September", 99), // now an actual month
    pred("MAT1", "P1", "2027-28", "July", 99), // beyond the window
  ];
  setup(t, { predictions, mappings: [active("D1", "P1")], materials: ["MAT1"], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  assert.deepEqual(r.integrity.excludedForecastMonths, [
    { financialYear: "2026-27", month: "September", predictionCount: 1, reason: "ALREADY_ACTUAL" },
    { financialYear: "2027-28", month: "July", predictionCount: 1, reason: "OUTSIDE_FORECAST_WINDOW" },
  ]);
  assert.ok(!r.data.some((row) => row.forecastDemand === 99));
});

test("demand: forecasts for discontinued/unknown materials are excluded and reported", async (t) => {
  setup(t, { predictions: [...fullForecast("MAT1", ["P1"]), ...fullForecast("OLD9", ["P1"])], mappings: [active("D1", "P1")], materials: ["MAT1"], depots: ["D1"] });
  const r = await getDepotDemand({}, NOW);
  assert.deepEqual(r.integrity.unknownOrInactiveMaterials, [{ materialNo: "OLD9", predictionCount: 9 }]);
  assert.deepEqual([...new Set(r.data.map((row) => row.materialNo))], ["MAT1"]);
});

test("demand: materialNo / depotId filters narrow both data and missing-forecast expectations", async (t) => {
  setup(t, { predictions: [...fullForecast("MAT1", ["P1", "P3"]), ...fullForecast("MAT2", ["P1", "P3"])], mappings: [active("D1", "P1"), active("D2", "P3")] });
  const r = await getDepotDemand({ materialNo: "mat2", depotId: "d2" }, NOW);
  assert.deepEqual([...new Set(r.data.map((row) => `${row.materialNo}@${row.depotId}`))], ["MAT2@D2"]);
  assert.equal(r.integrity.missingForecasts.count, 0);
  assert.deepEqual(ForecastPredictions.find.mock.calls[0].arguments[0], { materialNo: { $in: ["MAT2"] } });
});

test("demand: with no Sales history the window falls back to the stored prediction months", async (t) => {
  setup(t, { predictions: [pred("MAT1", "P1", "2026-27", "November", 4), pred("MAT1", "P1", "2026-27", "October", 3)], mappings: [active("D1", "P1")], materials: ["MAT1"], depots: ["D1"], salesPeriods: [] });
  const r = await getDepotDemand({}, NOW);
  assert.equal(r.window.source, "storedPredictions");
  assert.deepEqual(r.window.months.map((m) => m.month), ["October", "November"]);
});

// ─── Depot safety stock ──────────────────────────────────────────────────────

/** Backtest rows: 8 months for one material at the given plants, with per-plant actual/pred. */
function backtestRows(plants, errorFor) {
  const months = ["April", "May", "June", "July", "August", "September", "October", "November"];
  return plants.flatMap((plant) => months.map((Month, i) => ({
    MatNo: "mat1", Plant: plant, FinancialYear: "2025-26", Month, month_index: 24 + i,
    actual: 100 + errorFor(plant, i), xgb_pred: 100,
  })));
}

test("depot safety stock: one plant per depot = that plant's own 90th-percentile underforecast", () => {
  const rows = backtestRows(["P1", "P2"], (plant, i) => (plant === "P1" ? i * 10 : -5));
  const { docs } = computeDepotSafetyStock(rows, new Map([["P1", "D1"], ["P2", "D2"]]));
  const d1 = docs.find((d) => d.depotId === "D1");
  const expected = calculateSafetyStockForMaterial("MAT1", rows.filter((r) => r.Plant === "P1"));
  assert.equal(d1.safetyStock, expected.safetyStock);
  assert.equal(d1.status, "FORECAST_ERROR_BASED");
  assert.deepEqual(d1.plants, ["P1"]);
  const d2 = docs.find((d) => d.depotId === "D2");
  assert.equal(d2.status, "NO_HISTORICAL_UNDERFORECAST");
  assert.equal(d2.safetyStock, 0);
});

test("depot safety stock: plants sharing a depot are summed per month BEFORE the percentile (depot scale)", () => {
  // P1 and P2 underforecast in opposite months: pooled per-plant errors would be large,
  // but the depot's combined monthly demand error is small.
  const rows = backtestRows(["P1", "P2"], (plant, i) => (plant === "P1" ? (i % 2 ? 40 : -38) : (i % 2 ? -38 : 40)));
  const { docs } = computeDepotSafetyStock(rows, new Map([["P1", "D1"], ["P2", "D1"]]));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].observationCount, 8, "one observation per depot-month, not per plant-month");
  assert.equal(docs[0].safetyStock, 2); // combined error is +2 every month
  assert.deepEqual(docs[0].plants, ["P1", "P2"]);
});

test("depot safety stock: unmapped plants are skipped and reported; invalid rows counted; duplicates collapsed", () => {
  const rows = [...backtestRows(["P1", "P9"], () => 5), { ...backtestRows(["P1"], () => 5)[0] }, { MatNo: "MAT1", Plant: "P1", actual: NaN, xgb_pred: 1 }];
  const out = computeDepotSafetyStock(rows, new Map([["P1", "D1"]]));
  assert.deepEqual(out.unmappedPlants, [{ plantName: "P9", observationCount: 8 }]);
  assert.equal(out.invalidRows, 1);
  assert.equal(out.docs[0].observationCount, 8);
});

test("depot safety stock: fewer than 6 observations → INSUFFICIENT_HISTORY", () => {
  const rows = backtestRows(["P1"], () => 10).slice(0, 5);
  const [doc] = computeDepotSafetyStock(rows, new Map([["P1", "D1"]])).docs;
  assert.equal(doc.status, "INSUFFICIENT_HISTORY");
  assert.equal(doc.safetyStock, 0);
});

test("depot safety stock model: Material × Depot unique; non-negative integer safety stock", () => {
  assert.ok(DepotSafetyStock.schema.indexes().some(([f, o]) => f.materialNo === 1 && f.depotId === 1 && o.unique));
  const bad = new DepotSafetyStock({ materialNo: "m", depotId: "d", safetyStock: -1.5, status: "ERROR", observationCount: 0, underForecastCount: 0, meanUnderforecast: 0, mae: 0, rmse: 0, calculatedAt: new Date() });
  assert.ok(bad.validateSync().errors.safetyStock);
  assert.notEqual(DepotSafetyStock.collection.collectionName, ForecastErrorStats.collection.collectionName);
});

test("depot safety stock refresh: writes ONLY depotsafetystocks (upsert + stale cleanup), never ForecastErrorStats", async (t) => {
  t.mock.method(DepotPlantMapping, "find", () => ({ lean: async () => [active("D1", "P1"), active("D2", "P2")] }));
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => [{ depotId: "D1" }, { depotId: "D2" }] }) }));
  t.mock.method(mlServiceClient, "requestBacktestRows", async () => ({ dataSource: "mongodb", rows: backtestRows(["P1", "P2", "P7"], (p, i) => i * 3) }));
  const bulk = t.mock.method(DepotSafetyStock, "bulkWrite", async () => ({}));
  const del = t.mock.method(DepotSafetyStock, "deleteMany", async () => ({ deletedCount: 1 }));
  const fes = t.mock.method(ForecastErrorStats, "findOneAndUpdate", async () => { throw new Error("must not be called"); });

  const summary = await refreshDepotSafetyStock();
  assert.equal(summary.processed, 2);
  assert.deepEqual(summary.unmappedPlants, [{ plantName: "P7", observationCount: 8 }]);
  assert.equal(summary.removedStale, 1);
  const ops = bulk.mock.calls[0].arguments[0];
  assert.deepEqual(ops.map((o) => o.updateOne.filter), [{ materialNo: "MAT1", depotId: "D1" }, { materialNo: "MAT1", depotId: "D2" }]);
  assert.ok(ops.every((o) => o.updateOne.upsert && o.updateOne.update.$set.calculatedAt === summary.calculatedAt));
  assert.deepEqual(del.mock.calls[0].arguments[0], { calculatedAt: { $lt: summary.calculatedAt } });
  assert.equal(fes.mock.callCount(), 0);
});

test("depot safety stock refresh: refuses to run without any active mapping (nothing written, ML not called)", async (t) => {
  t.mock.method(DepotPlantMapping, "find", () => ({ lean: async () => [] }));
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => [{ depotId: "D1" }] }) }));
  const ml = t.mock.method(mlServiceClient, "requestBacktestRows", async () => ({ rows: [] }));
  const bulk = t.mock.method(DepotSafetyStock, "bulkWrite", async () => ({}));
  await assert.rejects(refreshDepotSafetyStock(), (err) => err.status === 422 && /No active depot-plant mappings/.test(err.message));
  assert.equal(ml.mock.callCount() + bulk.mock.callCount(), 0);
});
