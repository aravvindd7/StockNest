/**
 * Distribution — priority-based bulk approval, integration tests against a
 * REAL MongoDB replica set (same approach as distributionStage4.integration).
 *
 * Runs the real routes against a throwaway database
 * stocknest_bulk_test_<pid>_<time>, dropped afterwards. The application
 * database ("stocknest") is never touched. Without a replica set the suite
 * skips (set MONGO_TEST_URI to point elsewhere).
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "distribution-test-secret";
const TEST_DB = `stocknest_bulk_test_${process.pid}_${Date.now()}`;
const TEST_URI = process.env.MONGO_TEST_URI || `mongodb://127.0.0.1:27017/${TEST_DB}`;

const Stock = require("../models/Stock");
const Material = require("../models/Material");
const Depot = require("../models/Depot");
const DepotPlantMapping = require("../models/DepotPlantMapping");
const DistributionTransfer = require("../models/DistributionTransfer");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const IdempotencyRecord = require("../models/IdempotencyRecord");
const transactions = require("../utils/transactions");

let ready = false;
let skipReason = "";
let base;
let server;
const ADMIN = { _id: new mongoose.Types.ObjectId(), username: "admin", role: "ADMIN", isActive: true, email: "a@t", passwordHash: "x" };
const USER = { _id: new mongoose.Types.ObjectId(), username: "employee", role: "USER", isActive: true, email: "u@t", passwordHash: "x" };

test.before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    assert.notEqual(mongoose.connection.name, "stocknest", "refusing to run against the application database");
    if (!(await transactions.checkTransactionSupport())) {
      skipReason = `MongoDB at ${TEST_URI} does not support transactions (needs a replica set)`;
      return;
    }
    await Promise.all([Stock, Material, Depot, DepotPlantMapping, DistributionTransfer, DistributionRecommendation, IdempotencyRecord].map((M) => M.syncIndexes()));
    const app = express();
    app.use(express.json());
    app.use("/api/distribution", require("../routes/distributionRoutes"));
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}/api`;
    ready = true;
  } catch (err) {
    skipReason = `MongoDB test database unavailable: ${err.message}`;
  }
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name.startsWith("stocknest_bulk_test_")) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function stockRow(MatNo, PlantName, sih) {
  return {
    MatNo, PlantName, StockDate: new Date("2026-10-05"), StorageLocation: `SL-${PlantName}`,
    SIHQty: sih, SIH: sih, SITQTY: 0, SIT: 0, TotalStockQty: sih, TotalStock: sih,
    SIHCV: sih * 10, SITCV: 0, TotalStockCV: sih * 10, StockVal: sih * 10,
  };
}

async function seed({ sih = 1000 } = {}) {
  const db = mongoose.connection.db;
  await Promise.all((await db.listCollections().toArray()).map((c) => db.collection(c.name).deleteMany({})));
  await db.collection("users").insertMany([ADMIN, USER]);
  await Material.insertMany([{ materialNo: "MAT1", description: "Widget", status: "STD", invCost: 10, moq: 1, type: "FG" }]);
  await Depot.insertMany(["D1", "D2", "D3"].map((depotId) => ({ depotId, depotName: `Depot ${depotId}` })));
  await DepotPlantMapping.insertMany([["D1", "P1"], ["D2", "P2"], ["D3", "P3"]].map(([depotId, plantName]) => ({ depotId, plantName, isActive: true })));
  await Stock.insertMany([stockRow("MAT1", "P1", sih), stockRow("MAT1", "P2", 10), stockRow("MAT1", "P3", 10)]);
}

let recSeq = 0;
async function recs(n, over = {}) {
  // Each fixture gets its own forecast period: at most one PENDING suggestion
  // per material + route + period is a model rule (unique partial index).
  const docs = Array.from({ length: n }, () => {
    const y = 2000 + (recSeq += 1);
    return {
    materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: recSeq % 2 ? "D2" : "D3",
    forecastPeriod: { financialYear: `${y}-${String((y + 1) % 100).padStart(2, "0")}`, startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 1000, sourceStockInHand: 1000, sourceSafetyStock: 0, sourceForecastDemand: 100, sourceSurplus: 900,
    destinationCurrentStock: 10, destinationSafetyStock: 0, destinationForecastDemand: 500, destinationShortage: 490,
    recommendedQuantity: 10, priority: "CRITICAL", reason: "short", generationRunId: "RUN-1", ...over,
    };
  });
  return DistributionRecommendation.create(docs);
}

const token = (u) => `Bearer ${jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET)}`;
let keySeq = 0;
const newKey = () => `bulk-key-${process.pid}-${(keySeq += 1)}`;

async function api(method, path, { body, key = newKey(), user = ADMIN } = {}) {
  const headers = { Authorization: token(user) };
  if (key) headers["Idempotency-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), replay: res.headers.get("idempotent-replay") };
}

const summary = async () => (await api("GET", "/distribution/recommendations/pending-summary", { key: null })).body;
/** The bulk request the UI sends: the chosen priorities + every reviewed recommendation of those priorities. */
const bulkBody = (sum, priorities) => ({
  priorities,
  recommendations: sum.priorities.filter((p) => priorities.includes(p.priority)).flatMap((p) => p.recommendations),
});
const bulk = (body, opts) => api("POST", "/distribution/recommendations/approve-bulk", { body, ...opts });

function itest(name, fn) {
  test(name, async (t) => {
    if (!ready) return t.skip(skipReason || "test database not ready");
    await seed();
    return fn(t);
  });
}

// ─── Pending summary ─────────────────────────────────────────────────────────

itest("pending summary: PENDING only, per priority count + units + id/version; list filters ignored", async () => {
  await recs(3, { priority: "CRITICAL", recommendedQuantity: 20 });
  await recs(2, { priority: "HIGH", recommendedQuantity: 15 });
  await recs(1, { priority: "LOW" });
  const [approved] = await recs(1, { priority: "CRITICAL" });
  const [rejected] = await recs(1, { priority: "HIGH" });
  const [superseded] = await recs(1, { priority: "MEDIUM" });
  await DistributionRecommendation.updateOne({ _id: approved._id }, { $set: { status: "APPROVED", approvedQuantity: 10 } });
  await DistributionRecommendation.updateOne({ _id: rejected._id }, { $set: { status: "REJECTED" } });
  await DistributionRecommendation.updateOne({ _id: superseded._id }, { $set: { status: "SUPERSEDED" } });

  const res = await api("GET", "/distribution/recommendations/pending-summary?status=APPROVED&priority=LOW&search=zzz", { key: null });
  assert.equal(res.status, 200);
  const by = Object.fromEntries(res.body.priorities.map((p) => [p.priority, [p.count, p.units, p.recommendations.length]]));
  assert.deepEqual(by, { CRITICAL: [3, 60, 3], HIGH: [2, 30, 2], MEDIUM: [0, 0, 0], LOW: [1, 10, 1] });
  assert.deepEqual(res.body.total, { count: 6, units: 100 });
  assert.ok(res.body.priorities[0].recommendations.every((r) => typeof r.id === "string" && r.version === 0));
  assert.equal((await api("GET", "/distribution/recommendations/pending-summary", { key: null, user: USER })).status, 403);
});

// ─── Bulk approval ───────────────────────────────────────────────────────────

itest("Critical + High: every reviewed PENDING record approved (beyond one page), linked REQUESTED transfers at the recommended qty", async () => {
  await recs(55, { priority: "CRITICAL" });
  await recs(4, { priority: "HIGH", recommendedQuantity: 25 });
  await recs(3, { priority: "MEDIUM" });
  await recs(2, { priority: "LOW" });
  const stockBefore = await Stock.find().lean();
  const sum = await summary();

  const res = await bulk(bulkBody(sum, ["HIGH", "CRITICAL"]));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body;
  assert.deepEqual([b.requested, b.approved, b.failed, b.transfersCreated, b.approvedUnits, b.notIncluded], [59, 59, 0, 59, 650, 0]);
  assert.deepEqual(b.priorities, ["CRITICAL", "HIGH"], "canonical priority order");
  assert.deepEqual(b.byPriority.map((p) => [p.priority, p.approved, p.approvedUnits]), [["CRITICAL", 55, 550], ["HIGH", 4, 100]]);
  assert.equal(b.results[0].priority, "CRITICAL", "most urgent approved first");

  const transfers = await DistributionTransfer.find().lean();
  assert.equal(transfers.length, 59);
  assert.ok(transfers.every((t) => t.status === "REQUESTED" && t.recommendationId && t.requestedBy === "admin"));
  for (const r of await DistributionRecommendation.find({ priority: { $in: ["CRITICAL", "HIGH"] } }).lean()) {
    const t = transfers.find((x) => String(x.recommendationId) === String(r._id));
    assert.deepEqual([r.status, r.approvedQuantity, r.transferId, t.requestedQuantity], ["APPROVED", r.recommendedQuantity, t.transferId, r.recommendedQuantity]);
  }
  assert.equal(await DistributionRecommendation.countDocuments({ priority: { $in: ["MEDIUM", "LOW"] }, status: "PENDING" }), 5, "unselected priorities untouched");
  assert.deepEqual(await Stock.find().lean(), stockBefore, "approval never moves physical stock");
});

itest("stale data: a record that changed after review is reported, never forced through", async () => {
  const [a, b, c] = await recs(3, { priority: "CRITICAL" });
  const sum = await summary();
  // After the dialog was opened: one is rejected individually, one is approved individually.
  await api("POST", `/distribution/recommendations/${a._id}/reject`, { body: { reviewNotes: "not needed" } });
  await api("POST", `/distribution/recommendations/${b._id}/approve`, { body: {} });

  const res = await bulk(bulkBody(sum, ["CRITICAL"]));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.requested, res.body.approved, res.body.failed, res.body.transfersCreated], [3, 1, 2, 1]);
  const failed = res.body.results.filter((r) => r.status === "FAILED");
  assert.deepEqual(failed.map((r) => r.code).sort(), ["STALE_VERSION", "STALE_VERSION"]);
  assert.ok(failed.every((r) => r.message));
  assert.equal(res.body.results.find((r) => r.status === "APPROVED").recommendationId, String(c._id));
  assert.equal((await DistributionRecommendation.findById(a._id).lean()).status, "REJECTED");
  assert.equal(await DistributionTransfer.countDocuments(), 2, "the individual approval + one bulk approval — no duplicate for b");
});

itest("live availability: earlier approvals' commitments are seen; the rest fail STALE_RECOMMENDATION", async () => {
  await seed({ sih: 25 });
  await recs(3, { priority: "CRITICAL", recommendedQuantity: 10 });
  const res = await bulk(bulkBody(await summary(), ["CRITICAL"]));
  assert.deepEqual([res.body.approved, res.body.failed], [2, 1]);
  assert.equal(res.body.results.find((r) => r.status === "FAILED").code, "STALE_RECOMMENDATION");
  const committed = (await DistributionTransfer.find().lean()).reduce((s, t) => s + t.requestedQuantity, 0);
  assert.equal(committed, 20, "never commits more than the source's stock in hand");
});

itest("recommendations created after review are not approved — only counted", async () => {
  await recs(2, { priority: "HIGH" });
  const sum = await summary();
  await recs(3, { priority: "HIGH" }); // e.g. a new generation run
  const res = await bulk(bulkBody(sum, ["HIGH"]));
  assert.deepEqual([res.body.requested, res.body.approved, res.body.notIncluded], [2, 2, 3]);
  assert.equal(await DistributionRecommendation.countDocuments({ status: "PENDING" }), 3);
});

itest("a reviewed record outside the chosen priorities is refused (PRIORITY_NOT_SELECTED)", async () => {
  await recs(1, { priority: "CRITICAL" });
  await recs(1, { priority: "LOW" });
  const sum = await summary();
  const res = await bulk({ priorities: ["CRITICAL"], recommendations: sum.priorities.flatMap((p) => p.recommendations) });
  assert.deepEqual([res.body.approved, res.body.failed], [1, 1]);
  assert.equal(res.body.results.find((r) => r.status === "FAILED").code, "PRIORITY_NOT_SELECTED");
  assert.equal(await DistributionRecommendation.countDocuments({ priority: "LOW", status: "PENDING" }), 1);
});

itest("idempotency: same key replays (no duplicate transfers); different body → 409; new key → nothing approved twice", async () => {
  await recs(4, { priority: "CRITICAL" });
  const body = bulkBody(await summary(), ["CRITICAL"]);
  const key = newKey();
  const first = await bulk(body, { key });
  const again = await bulk({ ...body, recommendations: [...body.recommendations].reverse(), priorities: ["critical"] }, { key });
  assert.equal(first.replay, null);
  assert.equal(again.replay, "true", "same request (order/case-insensitive) is replayed");
  assert.deepEqual(again.body, first.body);
  assert.equal(await DistributionTransfer.countDocuments(), 4);

  const conflict = await bulk({ ...body, recommendations: body.recommendations.slice(1) }, { key });
  assert.deepEqual([conflict.status, conflict.body.code], [409, "IDEMPOTENCY_KEY_REUSED"]);

  const fresh = await bulk(body); // new key, same (now stale) selection
  assert.deepEqual([fresh.body.approved, fresh.body.failed], [0, 4]);
  assert.equal(await DistributionTransfer.countDocuments(), 4, "never a duplicate transfer");
  assert.equal(await IdempotencyRecord.countDocuments({ scope: "POST /recommendations/approve-bulk" }), 2);
});

itest("request validation, auth and Idempotency-Key are enforced; nothing written on rejection", async () => {
  const [r] = await recs(1);
  const ok = { priorities: ["CRITICAL"], recommendations: [{ id: String(r._id), version: 0 }] };
  const code = async (body, opts) => (await bulk(body, opts)).body.code;
  assert.equal(await code({ ...ok, priorities: [] }), "INVALID_REQUEST");
  assert.equal(await code({ ...ok, priorities: ["URGENT"] }), "INVALID_REQUEST");
  assert.equal(await code({ ...ok, recommendations: [] }), "INVALID_REQUEST");
  assert.equal(await code({ ...ok, recommendations: [{ id: "nope", version: 0 }] }), "INVALID_REQUEST");
  assert.equal(await code({ ...ok, recommendations: [{ id: String(r._id), version: 0, approvedQuantity: 5 }] }), "INVALID_REQUEST", "no quantity editing in bulk");
  assert.equal(await code({ ...ok, recommendations: [ok.recommendations[0], ok.recommendations[0]] }), "INVALID_REQUEST");
  assert.equal(await code({ ...ok, filters: { materialNo: "MAT1" } }), "INVALID_REQUEST", "table filters are not part of bulk approval");
  assert.equal(await code({ ...ok, recommendations: Array.from({ length: 501 }, () => ({ id: String(new mongoose.Types.ObjectId()), version: 0 })) }), "INVALID_REQUEST");
  assert.equal((await bulk(ok, { user: USER })).status, 403);
  assert.equal(await code(ok, { key: null }), "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(await DistributionTransfer.countDocuments(), 0);
  assert.equal((await DistributionRecommendation.findById(r._id).lean()).status, "PENDING");
});

itest("individual approval is unchanged (edited quantity + notes still supported)", async () => {
  const [r] = await recs(1, { recommendedQuantity: 40 });
  const res = await api("POST", `/distribution/recommendations/${r._id}/approve`, { body: { approvedQuantity: 25, reviewNotes: "partial", expectedVersion: 0 } });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.recommendation.approvedQuantity, res.body.transfer.requestedQuantity, res.body.recommendation.reviewNotes], [25, 25, "partial"]);
});

itest("an unexpected error mid-batch rolls the whole batch back — nothing half-approved", async (t) => {
  await recs(3, { priority: "CRITICAL" });
  const body = bulkBody(await summary(), ["CRITICAL"]);
  const realCreate = DistributionTransfer.create;
  let calls = 0;
  t.after(() => { DistributionTransfer.create = realCreate; });
  DistributionTransfer.create = function (...args) {
    calls += 1;
    if (calls === 2) throw new Error("simulated database failure");
    return realCreate.apply(this, args);
  };
  const orig = console.error;
  console.error = () => {};
  const res = await bulk(body);
  console.error = orig;
  assert.equal(res.status, 500);
  assert.equal(await DistributionTransfer.countDocuments(), 0, "the first approval was rolled back too");
  assert.equal(await DistributionRecommendation.countDocuments({ status: "PENDING" }), 3);
  assert.equal(await IdempotencyRecord.countDocuments(), 0, "a failed request stores nothing, so a retry runs again");
});
