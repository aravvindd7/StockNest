/**
 * Automatic forecast & recommendation updates (services/derivedDataPipeline.js)
 * — integration tests against a REAL MongoDB (throwaway database
 * stocknest_pipeline_test_<pid>_<time>, dropped afterwards; the application
 * database is never touched). The ML service and the recommendation engine are
 * stubbed so timing and failures can be controlled; the engine's own
 * guarantees are tested in distributionRecommendation.test.js.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");

const TEST_DB = `stocknest_pipeline_test_${process.pid}_${Date.now()}`;
const TEST_URI = process.env.MONGO_TEST_URI || `mongodb://127.0.0.1:27017/${TEST_DB}`;

const DerivedDataState = require("../models/DerivedDataState");
const ForecastPredictions = require("../models/ForecastPredictions");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const ReplenishmentPlan = require("../models/ReplenishmentPlan");
const Sales = require("../models/Sales");
const forecastService = require("../services/forecastGenerationService");
const mlServiceClient = require("../services/mlServiceClient");
const engine = require("../services/distributionRecommendationService");
const pipeline = require("../services/derivedDataPipeline");
const { recordsSourceChange } = require("../middleware/sourceChange");

let ready = false;
let skipReason = "";

test.before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    assert.notEqual(mongoose.connection.name, "stocknest", "refusing to run against the application database");
    await Promise.all([DerivedDataState, ForecastPredictions, DistributionRecommendation, ReplenishmentPlan, Sales].map((M) => M.syncIndexes()));
    ready = true;
  } catch (err) {
    skipReason = `MongoDB test database unavailable: ${err.message}`;
  }
});

test.after(async () => {
  await pipeline.stop();
  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name.startsWith("stocknest_pipeline_test_")) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let window = { key: "W1" };

/** Stubs: a controllable forecast generator and engine that record every call. */
function stubs(t, { forecast, distribution } = {}) {
  const calls = { forecast: [], distribution: [] };
  t.mock.method(forecastService, "currentForecastWindow", async () => window);
  t.mock.method(forecastService, "generateAndStoreForecast", async (opts) => {
    calls.forecast.push(opts.stamp);
    if (forecast) await forecast(opts, calls.forecast.length);
    return { generatedAt: new Date(), predictionsStored: 1 };
  });
  t.mock.method(engine, "generateRecommendations", async (options, ctx) => {
    calls.distribution.push({ options, ctx });
    if (distribution) await distribution(options, ctx, calls.distribution.length);
    return { generationRunId: `DRUN-T${calls.distribution.length}`, generatedAt: new Date(), recommendationsCreated: 2, supersededCount: 1 };
  });
  return calls;
}

const state = async (id) => DerivedDataState.findById(id).lean();

function itest(name, fn) {
  test(name, async (t) => {
    if (!ready) return t.skip(skipReason || "test database not ready");
    await pipeline.stop();
    const db = mongoose.connection.db;
    await Promise.all((await db.listCollections().toArray()).map((c) => db.collection(c.name).deleteMany({})));
    window = { key: "W1" };
    return fn(t);
  });
}

/** Baseline: both stages generated once from an empty state. */
async function baseline(t, opts) {
  const calls = stubs(t, opts);
  await pipeline.runNow();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [1, 1], "first run builds both");
  calls.forecast.length = 0;
  calls.distribution.length = 0;
  return calls;
}

// ─── Forecast ────────────────────────────────────────────────────────────────

itest("sales change → forecast stale → regenerated once, traceable to the Sales version; recommendations follow", async (t) => {
  const calls = await baseline(t);
  await pipeline.runNow();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [0, 0], "nothing stale → nothing runs");

  await pipeline.recordSourceChange(["sales"]);
  await pipeline.runNow();
  assert.equal(calls.forecast.length, 1);
  assert.deepEqual(calls.forecast[0], { forecastVersion: 2, sourceSalesVersion: 1 });
  const f = await state("forecast");
  assert.deepEqual([f.version, f.basedOn.sales, f.status], [2, 1, "current"]);
  assert.equal(calls.distribution.length, 1, "a new forecast makes recommendations stale");
  assert.equal(calls.distribution[0].ctx.sourceVersions.forecast, 2);
});

itest("stock-only changes do not regenerate the forecast (Stock is not a forecast input)", async (t) => {
  const calls = await baseline(t);
  await pipeline.recordSourceChange(["stock"]);
  await pipeline.runNow();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [0, 1]);
});

itest("rolling window moves with the calendar → forecast regenerated without a data change", async (t) => {
  const calls = await baseline(t);
  window = { key: "W2" };
  await pipeline.runNow();
  assert.equal(calls.forecast.length, 1);
  assert.equal((await state("forecast")).basedOn.window, "W2");
});

itest("failed forecast keeps the stored forecast, records the failure, backs off, and a later run recovers", async (t) => {
  // Real forecast service with the ML call failing: the stored predictions must survive.
  await Sales.collection.insertOne({ MatNo: "MAT1", FinancialYear: "2026-27", Month: "September", SalesQty: 5 });
  await ForecastPredictions.collection.insertOne({ materialNo: "MAT1", plant: "P1", financialYear: "2026-27", month: "October", quarter: "Q3", predictedSalesQty: 42, model: "XGBoost", modelVersion: "v", generatedAt: new Date() });
  t.mock.method(engine, "generateRecommendations", async () => ({ generationRunId: "DRUN-X", generatedAt: new Date(), recommendationsCreated: 0, supersededCount: 0 }));
  const ml = t.mock.method(mlServiceClient, "requestForecast", async () => { throw new Error("ML service unreachable"); });
  t.mock.method(console, "error", () => {});

  await pipeline.runNow();
  const f = await state("forecast");
  assert.equal(f.status, "failed");
  assert.equal(f.failures, 1);
  assert.ok(new Date(f.nextRetryAt) > new Date(), "retry scheduled with backoff");
  assert.equal(await ForecastPredictions.countDocuments({ predictedSalesQty: 42 }), 1, "last valid forecast kept");
  assert.equal((await pipeline.getStatus()).forecast.status, "failed");

  await pipeline.runNow();
  assert.equal(ml.mock.callCount(), 1, "in backoff → not hammered");

  ml.mock.mockImplementation(async () => ({ horizonMonths: 3, forecasts: [{ materialNo: "MAT1", plant: "P1", financialYear: "2026-27", month: "October", quarter: "Q3", predictedSalesQty: 50, model: "XGBoost", modelVersion: "v", monthsAheadInHorizon: 1 }] }));
  await pipeline.regenerateForecast({ actor: "admin" }); // manual Regenerate Forecast bypasses the backoff
  const after = await state("forecast");
  assert.deepEqual([after.status, after.failures, after.version, after.lastTrigger], ["current", 0, 1, "admin"]);
  const doc = await ForecastPredictions.findOne({ materialNo: "MAT1" }).lean();
  assert.deepEqual([doc.predictedSalesQty, doc.forecastVersion, doc.sourceSalesVersion], [50, 1, 0], "stored predictions carry their version + Sales version");
});

itest("only one generation at a time: concurrent cycles run once; a lease held elsewhere blocks this runner", async (t) => {
  const calls = stubs(t, { forecast: () => sleep(150) });
  await Promise.all([pipeline.runNow(), pipeline.runNow(), pipeline.runNow()]);
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [1, 1]);

  await DerivedDataState.updateOne({ _id: "lease" }, { $set: { owner: "other-process", until: new Date(Date.now() + 60_000) } }, { upsert: true });
  await pipeline.recordSourceChange(["sales"]);
  await pipeline.runNow();
  assert.equal(calls.forecast.length, 1, "another live runner holds the lease");
  await DerivedDataState.updateOne({ _id: "lease" }, { $set: { until: new Date(0) } });
  await pipeline.runNow();
  assert.equal(calls.forecast.length, 2, "picked up once the lease is free");
});

itest("new source data arriving during a generation is not lost — processed right after", async (t) => {
  let armed = false;
  const calls = await baseline(t, {
    forecast: async (_opts, n) => { if (armed && n === 1) await pipeline.recordSourceChange(["sales"]); }, // arrives mid-run
  });
  armed = true;
  await pipeline.recordSourceChange(["sales"]);
  await pipeline.runNow();
  assert.equal(calls.forecast.length, 2, "regenerated again for the newer Sales version");
  assert.deepEqual(calls.forecast.map((s) => s.sourceSalesVersion), [1, 2]);
  assert.equal((await state("forecast")).basedOn.sales, 2);
});

// ─── Distribution ────────────────────────────────────────────────────────────

for (const source of ["stock", "materials", "depots", "depotPlantMapping", "depotSafetyStock", "transfers"]) {
  itest(`${source} change → recommendations regenerated (forecast untouched), run uses the new input version`, async (t) => {
    const calls = await baseline(t);
    await pipeline.recordSourceChange([source]);
    await pipeline.runNow();
    assert.deepEqual([calls.forecast.length, calls.distribution.length], [0, 1]);
    assert.equal(calls.distribution[0].ctx.sourceVersions[source], 1);
    assert.equal(calls.distribution[0].ctx.user, pipeline.AUTOMATIC_USER);
    assert.equal(calls.distribution[0].options.dryRun, false);
    assert.equal(calls.distribution[0].options.allowMissingSafetyStock, undefined, "missing safety stock is never silently allowed");
  });
}

itest("coalescing: several changes in quick succession → ONE forecast + ONE recommendation run", async (t) => {
  const calls = await baseline(t);
  pipeline.config.debounceMs = 150;
  t.after(() => { pipeline.config.debounceMs = 3000; });
  await pipeline.start();
  await pipeline.recordSourceChange(["sales"]);
  await pipeline.recordSourceChange(["stock"]);
  await pipeline.recordSourceChange(["depotSafetyStock"]);
  await sleep(600);
  await pipeline.stop();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [1, 1]);
});

itest("no recursion: a recommendation run writing recommendations never makes anything stale", async (t) => {
  const calls = await baseline(t, {
    distribution: async () => {
      await DistributionRecommendation.collection.insertOne({ materialNo: "MAT1", status: "PENDING", generationRunId: "DRUN-W" });
    },
  });
  await pipeline.recordSourceChange(["stock"]);
  await pipeline.runNow();
  await pipeline.runNow();
  assert.equal(calls.distribution.length, 1);
  const s = await state("sources");
  assert.deepEqual(s.versions, { stock: 1 }, "derived writes bump no source version");
});

itest("failed recommendation run keeps the previous run; a busy engine (manual run) is not a failure", async (t) => {
  let armed = false;
  const calls = await baseline(t, {
    distribution: async (_o, _c, n) => {
      if (!armed) return;
      if (n === 1) { const e = new Error("A recommendation generation run is already in progress."); e.status = 409; throw e; }
      if (n === 2) throw new Error("engine failed");
    },
  });
  armed = true;
  t.mock.method(console, "error", () => {});
  const before = await state("distribution");
  await pipeline.recordSourceChange(["stock"]);
  await pipeline.runNow();
  let d = await state("distribution");
  assert.equal(d.status, "current", "busy is retried, not recorded as failure");
  await pipeline.runNow();
  d = await state("distribution");
  assert.deepEqual([d.status, d.failures, d.generationRunId, d.version], ["failed", 1, before.generationRunId, before.version], "previous run kept");
  assert.equal(calls.distribution.length, 2);
});

itest("generation never touches MANUAL replenishment plans or transfers", async (t) => {
  await ReplenishmentPlan.create({ materialNo: "MAT1", financialYear: "2026-27", quarter: "Q3", requiredStock: 100, distributionMode: "MANUAL", basedOnForecastVersion: 1,
    distribution: [{ month: "October", percentage: 45, quantity: 45, source: "forecast" }, { month: "November", percentage: 35, quantity: 35, source: "forecast" }, { month: "December", percentage: 20, quantity: 20, source: "forecast" }] });
  const before = await ReplenishmentPlan.find().lean();
  await baseline(t);
  await pipeline.recordSourceChange(["sales"]);
  await pipeline.runNow();
  assert.deepEqual(await ReplenishmentPlan.find().lean(), before, "manual allocation untouched by forecast regeneration");
  assert.equal(await mongoose.connection.db.collection("distributiontransfers").countDocuments(), 0);
});

// ─── Events ──────────────────────────────────────────────────────────────────

itest("events: one successful operation = one event (a 9,072-row import bumps Sales once); failures and replays record nothing", async () => {
  const app = express();
  app.post("/import", recordsSourceChange("sales"), async (_req, res) => {
    await Sales.collection.insertMany(Array.from({ length: 9072 }, (_, i) => ({ MatNo: `MAT${i % 18}`, SalesQty: i })));
    res.json({ added: 9072 });
  });
  app.post("/fail", recordsSourceChange("sales"), (_req, res) => res.status(400).json({ message: "invalid file" }));
  app.post("/replay", recordsSourceChange("stock"), (_req, res) => { res.set("Idempotent-Replay", "true"); res.json({}); });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/import`, { method: "POST" });
  await fetch(`${base}/fail`, { method: "POST" });
  await fetch(`${base}/replay`, { method: "POST" });
  await sleep(200);
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual((await state("sources")).versions, { sales: 1 });
});

test("route wiring: every source write raises its event; review actions and transfer approval raise none", () => {
  const sourceOf = (layer) => layer.route.stack.map((s) => s.handle.sourceChange).find(Boolean);
  const routes = {
    sales: require("../routes/salesRoutes"), stock: require("../routes/stockRoutes"), materials: require("../routes/materialRoutes"),
    depots: require("../routes/depotRoutes"), distribution: require("../routes/distributionRoutes"),
  };
  const writes = (router) => router.stack.filter((l) => l.route && !l.route.methods.get).map((l) => [`${Object.keys(l.route.methods)[0]} ${l.route.path}`, sourceOf(l)]);
  const map = Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, Object.fromEntries(writes(r))]));
  assert.deepEqual(map.sales, { "post /import-history/:id/view": "sales", "delete /import-history/:id": undefined, "post /import": "sales", "post /": "sales" });
  assert.equal(map.stock["post /import"], "stock");
  assert.equal(map.stock["post /"], "stock");
  assert.equal(map.stock["post /import-history/:id/view"], "stock");
  for (const r of ["post /", "put /:id", "delete /:id", "post /import", "post /import-history/:id/view"]) {
    assert.equal(map.materials[r], "materials", r);
    assert.equal(map.depots[r], "depots", r);
  }
  const d = map.distribution;
  assert.equal(d["post /transfers/:id/dispatch"], "stock");
  assert.equal(d["post /transfers/:id/receive"], "stock");
  assert.equal(d["post /transfers/:id/cancel"], "transfers");
  assert.equal(d["post /transfers"], "transfers");
  assert.equal(d["post /safety-stock/refresh"], "depotSafetyStock");
  for (const r of ["post /plant-mappings", "put /plant-mappings/:id", "post /plant-mappings/import", "post /plant-mappings/import-history/:id/view"]) assert.equal(d[r], "depotPlantMapping", r);
  for (const r of ["post /recommendations/generate", "post /recommendations/:id/approve", "post /recommendations/:id/reject", "post /recommendations/approve-bulk", "post /transfers/:id/approve", "post /transfers/:id/in-transit"]) {
    assert.equal(d[r], undefined, `${r} must not raise a source event`);
  }
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

itest("first start adopts existing results as the baseline — nothing regenerated", async (t) => {
  await ForecastPredictions.collection.insertOne({ materialNo: "MAT1", plant: "P1", financialYear: "2026-27", month: "October", generatedAt: new Date("2026-10-01") });
  await DistributionRecommendation.collection.insertOne({ materialNo: "MAT1", status: "PENDING", generationRunId: "DRUN-EXISTING", generatedAt: new Date("2026-10-02") });
  const calls = stubs(t);
  await pipeline.bootstrap();
  await pipeline.runNow();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [0, 0]);
  const [f, d] = [await state("forecast"), await state("distribution")];
  assert.deepEqual([f.adopted, f.version, d.adopted, d.generationRunId], [true, 1, true, "DRUN-EXISTING"]);
  assert.equal((await pipeline.getStatus()).distribution.status, "current");
});

// ─── Stability hardening ─────────────────────────────────────────────────────

itest("manual Regenerate Recommendations records its inputs → no duplicate automatic run afterwards", async (t) => {
  const calls = await baseline(t);
  await pipeline.recordSourceChange(["stock"]); // stale…
  await pipeline.regenerateRecommendations({}, { user: "admin" }); // …then an admin forces a run
  assert.equal(calls.distribution.length, 1);
  await pipeline.runNow();
  assert.equal(calls.distribution.length, 1, "the manual run already covered the latest inputs");
  assert.equal((await state("distribution")).lastTrigger, "admin");
});

itest("manual Regenerate Forecast → recommendations follow exactly once, then nothing is stale", async (t) => {
  const calls = await baseline(t);
  await pipeline.regenerateForecast({ actor: "admin" });
  await pipeline.runNow();
  await pipeline.runNow();
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [1, 1]);
  assert.equal(calls.distribution[0].ctx.sourceVersions.forecast, 2);
});

itest("event during a running recommendation run → exactly one follow-up run for the newer state", async (t) => {
  let armed = false;
  const calls = await baseline(t, {
    distribution: async (_o, _c, n) => { if (armed && n === 1) await pipeline.recordSourceChange(["stock"]); },
  });
  armed = true;
  await pipeline.recordSourceChange(["stock"]);
  await pipeline.runNow();
  assert.equal(calls.distribution.length, 2, "one run + one follow-up");
  assert.deepEqual(calls.distribution.map((c) => c.ctx.sourceVersions.stock), [1, 2]);
  await pipeline.runNow();
  assert.equal(calls.distribution.length, 2, "nothing left stale");
});

itest("a change recorded by another process (script) is picked up by the server's periodic check", async (t) => {
  const calls = await baseline(t);
  // What scripts/recordSourceChange.js does from a separate process: bump the version in the database.
  await DerivedDataState.updateOne({ _id: "sources" }, { $inc: { "versions.depotSafetyStock": 1 } }, { upsert: true });
  await pipeline.runNow(); // the periodic check runs exactly this cycle
  assert.deepEqual([calls.forecast.length, calls.distribution.length], [0, 1]);
  assert.equal(pipeline.config.clockCheckMs, 5 * 60_000);
});

test("scripts/recordSourceChange.js validates its arguments before touching any database", () => {
  const { spawnSync } = require("node:child_process");
  const run = (args) => spawnSync(process.execPath, ["scripts/recordSourceChange.js", ...args], { cwd: require("node:path").join(__dirname, ".."), encoding: "utf8", env: { ...process.env, MONGO_URI: "mongodb://127.0.0.1:1/never-used" } });
  for (const args of [[], ["sales", "nonsense"]]) {
    const r = run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Valid sources: sales, stock, materials, depots, depotPlantMapping, depotSafetyStock, transfers/);
  }
});
