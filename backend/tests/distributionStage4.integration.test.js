/**
 * Distribution Stage 4 — integration tests against a REAL MongoDB replica set.
 *
 * Transactions, rollback, write conflicts and unique-index races cannot be
 * proven with mocks, so this suite runs the real routes (auth, middleware,
 * controllers, services, models, indexes) against a throwaway database on the
 * local replica set: stocknest_stage4_test_<pid>_<time>, dropped afterwards.
 * The application database ("stocknest") is never touched. Without a replica
 * set the suite skips (set MONGO_TEST_URI to point elsewhere).
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const XLSX = require("xlsx");

process.env.JWT_SECRET = process.env.JWT_SECRET || "distribution-test-secret";
const TEST_DB = `stocknest_stage4_test_${process.pid}_${Date.now()}`;
const TEST_URI = process.env.MONGO_TEST_URI || `mongodb://127.0.0.1:27017/${TEST_DB}`;

const Stock = require("../models/Stock");
const { STOCK_COLUMNS } = require("../models/Stock");
const Material = require("../models/Material");
const Depot = require("../models/Depot");
const DepotPlantMapping = require("../models/DepotPlantMapping");
const DistributionTransfer = require("../models/DistributionTransfer");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DistributionCounter = require("../models/DistributionCounter");
const StockMovement = require("../models/StockMovement");
const IdempotencyRecord = require("../models/IdempotencyRecord");
const DatasetHistory = require("../models/DatasetHistory");
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
    await Promise.all([Stock, Material, Depot, DepotPlantMapping, DistributionTransfer, DistributionRecommendation, StockMovement, IdempotencyRecord, DatasetHistory]
      .map((M) => M.syncIndexes()));
    const app = express();
    app.use(express.json());
    app.use("/api/distribution", require("../routes/distributionRoutes"));
    app.use("/api/depots", require("../routes/depotRoutes"));
    app.use("/api/stock", require("../routes/stockRoutes"));
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
    if (mongoose.connection.name.startsWith("stocknest_stage4_test_")) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COST = { MAT1: 10.5, MAT2: 3.25 };
const cv = (q, mat = "MAT1") => Math.round(q * COST[mat] * 100) / 100;

function stockRow(MatNo, PlantName, sih, sit = 0, extra = {}) {
  const total = sih + sit;
  return {
    MatNo, PlantName, StockDate: new Date("2026-10-05"), StorageLocation: `SL-${PlantName}`,
    SIHQty: sih, SIH: sih, SITQTY: sit, SIT: sit, TotalStockQty: total, TotalStock: total,
    SIHCV: cv(sih, MatNo), SITCV: cv(sit, MatNo), TotalStockCV: cv(total, MatNo), StockVal: cv(total, MatNo), ...extra,
  };
}

/** Fresh dataset for every test. */
async function seed({ sih = { P1: 1000, P2: 100, P3: 50 }, sit = { P2: 20 }, omitStock = [] } = {}) {
  const db = mongoose.connection.db;
  await Promise.all((await db.listCollections().toArray()).map((c) => db.collection(c.name).deleteMany({})));
  await db.collection("users").insertMany([ADMIN, USER]);
  await Material.insertMany([
    { materialNo: "MAT1", description: "Widget", status: "STD", invCost: COST.MAT1, moq: 1, type: "FG" },
    { materialNo: "MAT2", description: "Gadget", status: "STD", invCost: COST.MAT2, moq: 1, type: "FG" },
  ]);
  await Depot.insertMany(["D1", "D2", "D3", "D9"].map((depotId) => ({ depotId, depotName: `Depot ${depotId}` })));
  await DepotPlantMapping.insertMany([["D1", "P1"], ["D2", "P2"], ["D3", "P3"]].map(([depotId, plantName]) => ({ depotId, plantName, isActive: true })));
  const rows = ["P1", "P2", "P3"].filter((p) => !omitStock.includes(p)).map((p) => stockRow("MAT1", p, sih[p] ?? 0, sit[p] ?? 0));
  rows.push(stockRow("MAT2", "P1", 500, 0));
  await Stock.insertMany(rows);
  // Sentinels for the "untouched" guarantees.
  await db.collection("sales").insertOne({ MatNo: "MAT1", Plant: "P1", FinancialYear: "2026-27", Month: "October", SalesQty: 77 });
  await db.collection("forecastpredictions").insertOne({ materialNo: "MAT1", plant: "P1", financialYear: "2026-27", month: "October", predictedSalesQty: 12.5 });
  await db.collection("forecasterrorstats").insertOne({ materialNo: "MAT1", safetyStock: 9 });
  await db.collection("inventories").insertOne({ legacy: true, currentStock: 42 });
}

const token = (u) => `Bearer ${jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET)}`;
let keySeq = 0;
const newKey = () => `test-key-${process.pid}-${(keySeq += 1)}`;

async function api(method, path, { body, key = newKey(), user = ADMIN, raw } = {}) {
  const headers = { Authorization: token(user) };
  if (key) headers["Idempotency-Key"] = key;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  return { status: res.status, body: await res.json(), replay: res.headers.get("idempotent-replay") };
}

const stockOf = async (MatNo, PlantName) => Stock.findOne({ MatNo, PlantName }).lean();
const materialTotal = async (MatNo) => (await Stock.find({ MatNo }).lean()).reduce((s, r) => s + r.TotalStockQty, 0);

function assertConsistent(row) {
  assert.equal(row.SIHQty + row.SITQTY, row.TotalStockQty, "SIH + SIT = Total");
  assert.equal(row.SIH, row.SIHQty);
  assert.equal(row.SIT, row.SITQTY);
  assert.equal(row.TotalStock, row.TotalStockQty);
  assert.equal(row.SIHCV, cv(row.SIHQty, row.MatNo), "SIHCV = SIHQty × cost");
  assert.equal(row.SITCV, cv(row.SITQTY, row.MatNo), "SITCV = SITQTY × cost");
  assert.equal(row.TotalStockCV, cv(row.TotalStockQty, row.MatNo), "TotalStockCV = TotalStockQty × cost");
  assert.equal(row.StockVal, row.TotalStockCV);
}

/** Creates (manual) + approves a transfer through the API; returns it. */
async function approvedTransfer({ qty = 300, src = "D1", dst = "D2", material = "MAT1" } = {}) {
  const created = await api("POST", "/distribution/transfers", { body: { materialNo: material, sourceDepotId: src, destinationDepotId: dst, requestedQuantity: qty, reason: "test" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await api("POST", `/distribution/transfers/${created.body.transfer._id}/approve`, { body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body.transfer;
}

async function inTransitTransfer(opts) {
  const t = await approvedTransfer(opts);
  assert.equal((await api("POST", `/distribution/transfers/${t._id}/dispatch`, { body: {} })).status, 200);
  const moved = await api("POST", `/distribution/transfers/${t._id}/in-transit`, { body: {} });
  assert.equal(moved.status, 200);
  return moved.body.transfer;
}

/** Inserts a transfer directly in a given state (bypasses the API) — used to set up races. */
async function rawApprovedTransfer(transferId, qty) {
  const now = new Date();
  await mongoose.connection.db.collection("distributiontransfers").insertOne({
    transferId, materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", status: "APPROVED", reason: "race",
    requestedQuantity: qty, approvedQuantity: qty, requestedBy: "admin", requestedAt: now, approvedBy: "admin", approvedAt: now,
    statusHistory: [], __v: 0, createdAt: now, updatedAt: now,
  });
  return DistributionTransfer.findOne({ transferId }).lean();
}

function itest(name, fn) {
  test(name, async (t) => {
    if (!ready) return t.skip(skipReason || "test database not ready");
    await seed();
    return fn(t);
  });
}

// ─── Transactions & capability ───────────────────────────────────────────────

itest("transactions: capability check passes on the replica set", async () => {
  assert.equal(transactions.transactionStatus().supported, true);
});

itest("fail closed: without transactions every Stage 4 write returns 503 and writes nothing", async (t) => {
  t.after(() => transactions.setTransactionSupportForTests(true));
  transactions.setTransactionSupportForTests(false, "IllegalOperation");
  const res = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", requestedQuantity: 5, reason: "x" } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "TRANSACTIONS_UNAVAILABLE");
  assert.equal(await DistributionTransfer.countDocuments(), 0);
});

itest("authorization + key: admin only; Idempotency-Key required and validated", async () => {
  const body = { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", requestedQuantity: 5, reason: "x" };
  assert.equal((await api("POST", "/distribution/transfers", { body, user: USER })).status, 403);
  const noKey = await api("POST", "/distribution/transfers", { body, key: null });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal((await api("POST", "/distribution/transfers", { body, key: "bad key!" })).body.code, "IDEMPOTENCY_KEY_INVALID");
  assert.equal(await DistributionTransfer.countDocuments(), 0);
});

// ─── Manual transfers & lifecycle ────────────────────────────────────────────

itest("manual transfer: REQUESTED, atomic TRF counter, no stock movement; validation errors", async () => {
  const before = await Stock.find().lean();
  const a = await api("POST", "/distribution/transfers", { body: { materialNo: "mat1", sourceDepotId: "d1", destinationDepotId: "D2", requestedQuantity: 10, reason: "top-up" } });
  const b = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", requestedQuantity: 10, reason: "top-up" } });
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.deepEqual([a.body.transfer.transferId, b.body.transfer.transferId], ["TRF-000001", "TRF-000002"]);
  assert.equal(a.body.transfer.status, "REQUESTED");
  assert.equal(a.body.transfer.recommendationId, undefined, "manual transfers need no recommendation");
  assert.equal((await DistributionCounter.findById("transferId").lean()).seq, 2);
  assert.deepEqual(await Stock.find().lean(), before, "creating a transfer moves no stock");

  const bad = async (body) => (await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", requestedQuantity: 5, reason: "x", ...body } })).body.code;
  assert.equal(await bad({ destinationDepotId: "D1" }), "SAME_DEPOT");
  assert.equal(await bad({ materialNo: "NOPE" }), "MATERIAL_NOT_FOUND");
  assert.equal(await bad({ destinationDepotId: "D404" }), "DEPOT_NOT_FOUND");
  assert.equal(await bad({ destinationDepotId: "D9" }), "DEPOT_NOT_MAPPED");
  assert.equal(await bad({ requestedQuantity: 0 }), "INVALID_REQUEST");
  assert.equal(await bad({ requestedQuantity: 2000 }), "INSUFFICIENT_AVAILABLE_STOCK");
  assert.equal(await DistributionTransfer.countDocuments(), 2);
});

itest("dispatch: source SIH −q, destination SIT +q, all mirrors/values consistent, ledger + resolved rows recorded", async () => {
  const t = await approvedTransfer({ qty: 300 });
  const srcBefore = await stockOf("MAT1", "P1");
  const dstBefore = await stockOf("MAT1", "P2");
  const totalBefore = await materialTotal("MAT1");
  const res = await api("POST", `/distribution/transfers/${t._id}/dispatch`, { body: { dispatchedQuantity: 280 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const src = await stockOf("MAT1", "P1");
  const dst = await stockOf("MAT1", "P2");
  assert.deepEqual([src.SIHQty, src.SITQTY, src.TotalStockQty], [srcBefore.SIHQty - 280, srcBefore.SITQTY, srcBefore.TotalStockQty - 280]);
  assert.deepEqual([dst.SIHQty, dst.SITQTY, dst.TotalStockQty], [dstBefore.SIHQty, dstBefore.SITQTY + 280, dstBefore.TotalStockQty + 280]);
  assertConsistent(src);
  assertConsistent(dst);
  assert.equal(await materialTotal("MAT1"), totalBefore, "Planning's material TotalStockQty is unchanged by a dispatch");

  const tr = res.body.transfer;
  assert.deepEqual([tr.status, tr.dispatchedQuantity, tr.sourcePlantName, tr.destinationPlantName, tr.unitCost], ["DISPATCHED", 280, "P1", "P2", COST.MAT1]);
  assert.equal(tr.sourceStockId, String(src._id));
  assert.equal(tr.destinationStockId, String(dst._id));
  assert.deepEqual(tr.statusHistory.map((h) => [h.status, h.changedBy]), [["REQUESTED", "admin"], ["APPROVED", "admin"], ["DISPATCHED", "admin"]]);

  const ledger = await StockMovement.find({ transferId: tr.transferId }).sort({ side: -1 }).lean();
  assert.deepEqual(ledger.map((m) => [m.movementType, m.side, m.depotId, m.plantName, m.quantity]), [["DISPATCH", "SOURCE", "D1", "P1", 280], ["DISPATCH", "DESTINATION", "D2", "P2", 280]]);
  assert.deepEqual(ledger[0].change, { SIHQty: -280, SITQTY: 0, TotalStockQty: -280 });
  assert.equal(ledger[0].before.SIHQty, srcBefore.SIHQty);
  assert.equal(ledger[0].after.SIHQty, src.SIHQty);
  assert.equal(ledger[1].after.SITCV, dst.SITCV);
  assert.equal(ledger[0].actor, "admin");
  assert.ok(ledger[0].idempotencyKey);
});

itest("full receipt: destination SIT −q, SIH +q; material total unchanged end-to-end", async () => {
  const totalBefore = await materialTotal("MAT1");
  const dstBefore = await stockOf("MAT1", "P2");
  const t = await inTransitTransfer({ qty: 200 });
  const res = await api("POST", `/distribution/transfers/${t._id}/receive`, { body: { receivedQuantity: 200 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const dst = await stockOf("MAT1", "P2");
  assert.deepEqual([dst.SIHQty, dst.SITQTY], [dstBefore.SIHQty + 200, dstBefore.SITQTY]);
  assertConsistent(dst);
  assert.equal(await materialTotal("MAT1"), totalBefore, "no loss → network total unchanged");
  assert.deepEqual([res.body.transfer.status, res.body.transfer.receivedQuantity, res.body.transfer.transitLossQuantity], ["RECEIVED", 200, 0]);
  const types = (await StockMovement.find({ transferId: t.transferId }).lean()).map((m) => m.movementType).sort();
  assert.deepEqual(types, ["DISPATCH", "DISPATCH", "RECEIPT"]);
  assert.deepEqual(res.body.transfer.statusHistory.map((h) => h.status), ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT", "RECEIVED"]);
});

itest("partial receipt: 1,000 dispatched / 950 received preserved; 50 transit loss recorded with mandatory reason", async () => {
  await Stock.updateOne({ MatNo: "MAT1", PlantName: "P1" }, { $set: stockRow("MAT1", "P1", 1500, 0) });
  const totalBefore = await materialTotal("MAT1");
  const dstBefore = await stockOf("MAT1", "P2");
  const t = await inTransitTransfer({ qty: 1000 });

  const noReason = await api("POST", `/distribution/transfers/${t._id}/receive`, { body: { receivedQuantity: 950 } });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.code, "DISCREPANCY_REASON_REQUIRED");
  assert.equal((await api("POST", `/distribution/transfers/${t._id}/receive`, { body: { receivedQuantity: 1001, discrepancyReason: "x" } })).body.code, "RECEIVED_EXCEEDS_DISPATCHED");

  const res = await api("POST", `/distribution/transfers/${t._id}/receive`, { body: { receivedQuantity: 950, discrepancyReason: "50 cartons water-damaged" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tr = res.body.transfer;
  assert.deepEqual([tr.dispatchedQuantity, tr.receivedQuantity, tr.transitLossQuantity, tr.discrepancyReason], [1000, 950, 50, "50 cartons water-damaged"]);

  const dst = await stockOf("MAT1", "P2");
  assert.deepEqual([dst.SIHQty, dst.SITQTY, dst.TotalStockQty], [dstBefore.SIHQty + 950, dstBefore.SITQTY, dstBefore.TotalStockQty + 950]);
  assertConsistent(dst);
  assert.equal(await materialTotal("MAT1"), totalBefore - 50, "only the transit loss leaves the network");

  const ledger = await StockMovement.find({ transferId: tr.transferId, side: "DESTINATION", movementType: { $ne: "DISPATCH" } }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(ledger.map((m) => [m.movementType, m.quantity, m.change]), [
    ["RECEIPT", 950, { SIHQty: 950, SITQTY: -950, TotalStockQty: 0 }],
    ["TRANSIT_LOSS", 50, { SIHQty: 0, SITQTY: -50, TotalStockQty: -50 }],
  ]);
  assert.equal(ledger[0].after.SITQTY, ledger[1].before.SITQTY, "ledger entries chain exactly");
});

itest("in-transit and cancellation rules: no cancel after dispatch; cancel moves no stock and releases the commitment", async () => {
  const before = await Stock.find().lean();
  const created = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", requestedQuantity: 900, reason: "x" } });
  const blocked = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", requestedQuantity: 200, reason: "x" } });
  assert.equal(blocked.body.code, "INSUFFICIENT_AVAILABLE_STOCK", "900 of 1,000 already committed");
  const noReason = await api("POST", `/distribution/transfers/${created.body.transfer._id}/cancel`, { body: {} });
  assert.equal(noReason.status, 400);
  const cancelled = await api("POST", `/distribution/transfers/${created.body.transfer._id}/cancel`, { body: { cancellationReason: "demand fell" } });
  assert.deepEqual([cancelled.status, cancelled.body.transfer.status], [200, "CANCELLED"]);
  assert.deepEqual(await Stock.find().lean(), before);
  const nowOk = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", requestedQuantity: 200, reason: "x" } });
  assert.equal(nowOk.status, 201, "commitment released");

  const approved = await approvedTransfer({ qty: 100, dst: "D2" });
  assert.equal((await api("POST", `/distribution/transfers/${approved._id}/cancel`, { body: { cancellationReason: "x" } })).body.transfer.status, "CANCELLED");

  const moving = await approvedTransfer({ qty: 50, dst: "D2" });
  await api("POST", `/distribution/transfers/${moving._id}/dispatch`, { body: {} });
  const late = await api("POST", `/distribution/transfers/${moving._id}/cancel`, { body: { cancellationReason: "x" } });
  assert.deepEqual([late.status, late.body.code], [409, "INVALID_STATUS_TRANSITION"]);
  const skip = await api("POST", `/distribution/transfers/${moving._id}/receive`, { body: { receivedQuantity: 50 } });
  assert.equal(skip.body.code, "INVALID_STATUS_TRANSITION", "must be IN_TRANSIT before receipt");
});

// ─── Atomicity & concurrency ─────────────────────────────────────────────────

itest("rollback: a failure after the stock updates rolls back stock, transfer, ledger and idempotency record", async (t) => {
  const tr = await approvedTransfer({ qty: 100 });
  const stockBefore = await Stock.find().lean();
  t.mock.method(StockMovement, "create", async () => { throw new Error("ledger unavailable"); });
  t.mock.method(console, "error", () => {});
  const key = newKey();
  const res = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {}, key });
  assert.equal(res.status, 500);
  assert.deepEqual(await Stock.find().lean(), stockBefore, "stock updates rolled back");
  assert.equal((await DistributionTransfer.findById(tr._id).lean()).status, "APPROVED");
  assert.equal(await StockMovement.countDocuments(), 0);
  assert.equal(await IdempotencyRecord.countDocuments({ key }), 0, "failed request stores no result — a retry runs again");
  t.mock.restoreAll();
  assert.equal((await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {}, key })).status, 200, "retry with the same key succeeds");
});

itest("double dispatch race: exactly one wins; stock moves once", async () => {
  const tr = await approvedTransfer({ qty: 300 });
  const results = await Promise.all([1, 2, 3].map(() => api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {} })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await stockOf("MAT1", "P1")).SIHQty, 700);
  assert.equal(await StockMovement.countDocuments({ movementType: "DISPATCH" }), 2);
});

itest("double receipt race: exactly one wins; receipt applied once", async () => {
  const tr = await inTransitTransfer({ qty: 200 });
  const dstBefore = await stockOf("MAT1", "P2");
  const results = await Promise.all([1, 2].map(() => api("POST", `/distribution/transfers/${tr._id}/receive`, { body: { receivedQuantity: 200 } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const dst = await stockOf("MAT1", "P2");
  assert.equal(dst.SIHQty, dstBefore.SIHQty + 200);
  assert.equal(await StockMovement.countDocuments({ movementType: "RECEIPT" }), 1);
});

itest("insufficient SIH: dispatch blocked atomically; in-transit stock is never dispatchable", async () => {
  await Stock.updateOne({ MatNo: "MAT1", PlantName: "P1" }, { $set: stockRow("MAT1", "P1", 100, 900) }); // 1,000 total, only 100 in hand
  const tr = await rawApprovedTransfer("TRF-900001", 150);
  const before = await Stock.find().lean();
  const res = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {} });
  assert.deepEqual([res.status, res.body.code, res.body.details.stockInHand], [409, "INSUFFICIENT_STOCK_IN_HAND", 100]);
  assert.deepEqual(await Stock.find().lean(), before);
  assert.equal(await StockMovement.countDocuments(), 0);
});

itest("concurrent transfers consuming the same source: dispatch guard lets only what SIH covers through", async () => {
  const a = await rawApprovedTransfer("TRF-900001", 600);
  const b = await rawApprovedTransfer("TRF-900002", 600); // 1,200 against 1,000 in hand
  const results = await Promise.all([a, b].map((tr) => api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {} })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await stockOf("MAT1", "P1")).SIHQty, 400);
  assert.ok((await stockOf("MAT1", "P1")).SIHQty >= 0);
});

itest("concurrent commitments: simultaneous requests for the same stock are serialized — no over-commitment", async () => {
  const body = (dst) => ({ materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: dst, requestedQuantity: 600, reason: "race" });
  const results = await Promise.all([api("POST", "/distribution/transfers", { body: body("D2") }), api("POST", "/distribution/transfers", { body: body("D3") })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await DistributionTransfer.countDocuments(), 1);
});

itest("optimistic version: a stale expectedVersion is rejected", async () => {
  const tr = await approvedTransfer({ qty: 10 });
  const stale = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { expectedVersion: tr.__v - 1 } });
  assert.deepEqual([stale.status, stale.body.code], [409, "STALE_VERSION"]);
  assert.equal((await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { expectedVersion: tr.__v } })).status, 200);
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

itest("idempotent retry: same key + same request replays the original result without moving stock again", async () => {
  const tr = await approvedTransfer({ qty: 100 });
  const key = newKey();
  const first = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { dispatchedQuantity: 100 }, key });
  const again = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { dispatchedQuantity: 100 }, key });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.replay, "true");
  assert.deepEqual(again.body, first.body);
  assert.equal((await stockOf("MAT1", "P1")).SIHQty, 900);
  assert.equal(await StockMovement.countDocuments(), 2);

  // Concurrent duplicates with one key also apply once.
  const tr2 = await approvedTransfer({ qty: 50, dst: "D3" });
  const k2 = newKey();
  const both = await Promise.all([1, 2].map(() => api("POST", `/distribution/transfers/${tr2._id}/dispatch`, { body: {}, key: k2 })));
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(await StockMovement.countDocuments({ transferId: tr2.transferId }), 2);
});

itest("same key + different request → 409; nothing applied", async () => {
  const tr = await approvedTransfer({ qty: 100 });
  const key = newKey();
  await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { dispatchedQuantity: 40 }, key });
  const diffBody = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: { dispatchedQuantity: 60 }, key });
  assert.deepEqual([diffBody.status, diffBody.body.code], [409, "IDEMPOTENCY_KEY_REUSED"]);
  const other = await approvedTransfer({ qty: 10, dst: "D3" });
  const diffResource = await api("POST", `/distribution/transfers/${other._id}/dispatch`, { body: { dispatchedQuantity: 40 }, key });
  assert.equal(diffResource.body.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await DistributionTransfer.findById(other._id).lean()).status, "APPROVED");
});

// ─── Recommendation review ───────────────────────────────────────────────────

async function pendingRecommendation(over = {}) {
  return DistributionRecommendation.create({
    materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2",
    forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 1000, sourceStockInHand: 1000, sourceSafetyStock: 0, sourceForecastDemand: 100, sourceSurplus: 900,
    destinationCurrentStock: 120, destinationSafetyStock: 0, destinationForecastDemand: 500, destinationShortage: 380,
    recommendedQuantity: 380, priority: "CRITICAL", reason: "D2 short", generationRunId: "RUN-1", ...over,
  });
}

itest("approve recommendation: creates a linked REQUESTED transfer, moves no stock", async () => {
  const rec = await pendingRecommendation();
  const before = await Stock.find().lean();
  const res = await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: { reviewNotes: "ok" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { recommendation, transfer } = res.body;
  assert.deepEqual([recommendation.status, recommendation.approvedQuantity, recommendation.reviewedBy, recommendation.transferId], ["APPROVED", 380, "admin", transfer.transferId]);
  assert.deepEqual([transfer.status, transfer.requestedQuantity, transfer.recommendationId], ["REQUESTED", 380, String(rec._id)]);
  assert.deepEqual(await Stock.find().lean(), before, "approval never moves physical stock");
  assert.equal((await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: {} })).body.code, "INVALID_STATUS_TRANSITION");
});

itest("approval override: lower quantity accepted; above the snapshot's surplus/shortage rejected", async () => {
  const rec = await pendingRecommendation();
  const tooMuch = await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: { approvedQuantity: 381 } });
  assert.deepEqual([tooMuch.status, tooMuch.body.code], [422, "QUANTITY_EXCEEDS_RECOMMENDATION"]);
  const ok = await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: { approvedQuantity: 250 } });
  assert.deepEqual([ok.status, ok.body.recommendation.approvedQuantity, ok.body.transfer.requestedQuantity], [200, 250, 250]);
});

itest("stale recommendation: live SIH minus open commitments re-checked → 409 with current figures", async () => {
  const rec = await pendingRecommendation();
  await Stock.updateOne({ MatNo: "MAT1", PlantName: "P1" }, { $set: stockRow("MAT1", "P1", 300, 700) }); // SIH fell to 300
  await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", requestedQuantity: 100, reason: "x" } });
  const res = await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: {} });
  assert.deepEqual([res.status, res.body.code], [409, "STALE_RECOMMENDATION"]);
  assert.deepEqual(res.body.details.current, { stockInHand: 300, openCommitments: 100, available: 200 });
  assert.equal((await DistributionRecommendation.findById(rec._id).lean()).status, "PENDING", "nothing changed");
});

itest("reject recommendation: reason required; REJECTED is final", async () => {
  const rec = await pendingRecommendation();
  assert.equal((await api("POST", `/distribution/recommendations/${rec._id}/reject`, { body: {} })).status, 400);
  const res = await api("POST", `/distribution/recommendations/${rec._id}/reject`, { body: { reviewNotes: "Supplier delivery due" } });
  assert.deepEqual([res.status, res.body.recommendation.status, res.body.recommendation.reviewNotes], [200, "REJECTED", "Supplier delivery due"]);
  assert.equal((await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: {} })).body.code, "INVALID_STATUS_TRANSITION");
  assert.equal(await DistributionTransfer.countDocuments(), 0);
});

// ─── Stock row resolution ────────────────────────────────────────────────────

itest("missing destination Stock row: blocked with a clear error, no Stock row is ever created", async () => {
  await seed({ omitStock: ["P3"] });
  const res = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D3", requestedQuantity: 5, reason: "x" } });
  assert.deepEqual([res.status, res.body.code], [422, "DESTINATION_STOCK_ROW_MISSING"]);
  assert.match(res.body.message, /destination Stock Master record must exist first/);

  // Row removed after dispatch → receipt blocked, nothing created.
  await seed();
  const tr = await inTransitTransfer({ qty: 10, dst: "D3" });
  await Stock.deleteOne({ MatNo: "MAT1", PlantName: "P3" });
  const count = await Stock.countDocuments();
  const rec = await api("POST", `/distribution/transfers/${tr._id}/receive`, { body: { receivedQuantity: 10 } });
  assert.equal(rec.body.code, "DESTINATION_STOCK_ROW_MISSING");
  assert.equal(await Stock.countDocuments(), count);
});

itest("ambiguous Stock rows: two rows for material + plant block the operation (no guessing)", async () => {
  await Stock.create({ ...stockRow("MAT1", "P1", 5, 0), StorageLocation: "SL-OTHER" });
  const res = await api("POST", "/distribution/transfers", { body: { materialNo: "MAT1", sourceDepotId: "D1", destinationDepotId: "D2", requestedQuantity: 5, reason: "x" } });
  assert.deepEqual([res.status, res.body.code, res.body.details.rows.length], [409, "AMBIGUOUS_STOCK_ROWS", 2]);
});

itest("inconsistent Stock row (SIH + SIT ≠ Total) blocks movement", async () => {
  const tr = await approvedTransfer({ qty: 10 });
  await Stock.updateOne({ MatNo: "MAT1", PlantName: "P1" }, { $set: { TotalStockQty: 5 } });
  const res = await api("POST", `/distribution/transfers/${tr._id}/dispatch`, { body: {} });
  assert.deepEqual([res.status, res.body.code], [409, "STOCK_ROW_INCONSISTENT"]);
});

// ─── Ledger ──────────────────────────────────────────────────────────────────

itest("ledger: duplicate movement impossible (unique key) and entries are append-only", async () => {
  const tr = await inTransitTransfer({ qty: 10 });
  const [entry] = await StockMovement.find({ transferId: tr.transferId, side: "SOURCE" }).lean();
  const { _id, createdAt, ...copy } = entry;
  await assert.rejects(StockMovement.create(copy), (e) => e.code === 11000);
  await assert.rejects(StockMovement.updateOne({ _id }, { $set: { quantity: 1 } }), /append-only/);
  await assert.rejects(StockMovement.deleteMany({}), /append-only/);
  const doc = await StockMovement.findById(_id);
  doc.quantity = 1;
  await assert.rejects(doc.save(), /append-only/);
  const listed = await api("GET", `/distribution/transfers/${tr.transferId}/movements`);
  assert.equal(listed.body.data.length, 2);
});

// ─── Guards on existing masters ──────────────────────────────────────────────

function stockWorkbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([STOCK_COLUMNS.map((c) => c.label), ...rows.map((r) => STOCK_COLUMNS.map((c) => r[c.key] ?? ""))]), "Stock");
  return new Blob([XLSX.write(book, { type: "buffer", bookType: "xlsx" })]);
}
function importForm(rows, mode) {
  const form = new FormData();
  form.append("file", stockWorkbook(rows), "stock.xlsx");
  form.append("mode", mode);
  return form;
}

itest("Stock imports/restore blocked while stock is DISPATCHED/IN_TRANSIT (409); unaffected APPEND allowed", async () => {
  await inTransitTransfer({ qty: 10 });
  const before = await Stock.find().lean();
  const replace = await api("POST", "/stock/import", { raw: importForm([stockRow("MAT1", "P1", 1, 0)], "REPLACE"), key: null });
  assert.deepEqual([replace.status, replace.body.code], [409, "ACTIVE_DISTRIBUTION_MOVEMENTS"]);
  assert.equal(replace.body.activeTransfers[0].status, "IN_TRANSIT");
  const appendHit = await api("POST", "/stock/import", { raw: importForm([stockRow("MAT1", "P2", 1, 0)], "APPEND"), key: null });
  assert.equal(appendHit.status, 409, "APPEND touching the destination row");
  const restoreEntry = await DatasetHistory.create({ module: "stock", batchId: "STK-IMP-9999", fileName: "f", importType: "REPLACE", importedBy: "admin", snapshotData: [] });
  const restore = await api("POST", `/stock/import-history/${restoreEntry._id}/view`, { key: null });
  assert.equal(restore.status, 409);
  assert.deepEqual(await Stock.find().lean(), before, "nothing overwritten");

  const appendOther = await api("POST", "/stock/import", { raw: importForm([stockRow("MAT2", "P1", 600, 0)], "APPEND"), key: null });
  assert.equal(appendOther.status, 200, "rows unrelated to active movements may still be appended");
});

itest("Depot ID integrity: referenced depot cannot be deleted, re-IDed or dropped by REPLACE; name still editable", async () => {
  await approvedTransfer({ qty: 10 });
  const d1 = await Depot.findOne({ depotId: "D1" }).lean();
  const del = await api("DELETE", `/depots/${d1._id}`, { key: null });
  assert.deepEqual([del.status, del.body.code], [409, "DEPOT_REFERENCED"]);
  const reId = await api("PUT", `/depots/${d1._id}`, { body: { depotId: "D1X", depotName: "x" }, key: null });
  assert.equal(reId.status, 409);
  const rename = await api("PUT", `/depots/${d1._id}`, { body: { depotId: "D1", depotName: "Chennai Central" }, key: null });
  assert.equal(rename.status, 200);
  const unreferenced = await Depot.findOne({ depotId: "D9" }).lean();
  assert.equal((await api("DELETE", `/depots/${unreferenced._id}`, { key: null })).status, 200);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Depot ID", "Depot Name"], ["D2", "x"], ["D3", "y"]]), "Depots");
  const form = new FormData();
  form.append("file", new Blob([XLSX.write(book, { type: "buffer", bookType: "xlsx" })]), "depots.xlsx");
  form.append("mode", "REPLACE");
  const replace = await api("POST", "/depots/import", { raw: form, key: null });
  assert.deepEqual([replace.status, replace.body.code], [409, "DEPOT_REFERENCED"]);
  assert.ok(await Depot.exists({ depotId: "D1" }));
});

// ─── Untouched collections ───────────────────────────────────────────────────

itest("full lifecycle leaves Sales, Materials, ForecastPredictions, ForecastErrorStats and legacy inventories untouched", async () => {
  const db = mongoose.connection.db;
  const snap = async () => JSON.stringify(await Promise.all(["sales", "materials", "forecastpredictions", "forecasterrorstats", "inventories"].map((c) => db.collection(c).find().sort({ _id: 1 }).toArray())));
  const before = await snap();
  const tr = await inTransitTransfer({ qty: 100 });
  await api("POST", `/distribution/transfers/${tr._id}/receive`, { body: { receivedQuantity: 90, discrepancyReason: "short" } });
  const rec = await pendingRecommendation({ recommendedQuantity: 100 });
  await api("POST", `/distribution/recommendations/${rec._id}/approve`, { body: {} });
  assert.equal(await snap(), before);
});
