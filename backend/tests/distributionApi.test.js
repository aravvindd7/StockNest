/**
 * Distribution Master Stage 1 — API tests.
 *
 * Mounts the real distribution router (real requireAuth + requireRole("ADMIN"),
 * real controller and service) on an ephemeral local Express server and calls
 * it over HTTP with signed JWTs. Only the data layer is mocked (User lookup and
 * the two Distribution models), so no MongoDB is touched.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "distribution-test-secret";

const User = require("../models/User");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DistributionTransfer = require("../models/DistributionTransfer");
const distributionRoutes = require("../routes/distributionRoutes");

const USERS = {
  admin: { _id: new mongoose.Types.ObjectId(), username: "admin", role: "ADMIN", isActive: true },
  employee: { _id: new mongoose.Types.ObjectId(), username: "employee", role: "USER", isActive: true },
  disabled: { _id: new mongoose.Types.ObjectId(), username: "old", role: "ADMIN", isActive: false },
};
const tokenFor = (user) => jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "5m" });

const REC_ID = new mongoose.Types.ObjectId().toString();
const TRF_ID = new mongoose.Types.ObjectId().toString();
const RECOMMENDATION = { _id: REC_ID, materialNo: "MAT0001", sourceDepotId: "DEP001", destinationDepotId: "DEP002", recommendedQuantity: 100, status: "PENDING" };
const TRANSFER = { _id: TRF_ID, transferId: "TRF-000001", materialNo: "MAT0001", sourceDepotId: "DEP001", destinationDepotId: "DEP002", requestedQuantity: 100, status: "REQUESTED" };

let baseUrl;
let server;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/distribution", distributionRoutes);
  app.use((req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/distribution`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

/** Mocks auth lookups + both Distribution models; records every model call. */
function setup(t, { recommendations = [RECOMMENDATION], transfers = [TRANSFER] } = {}) {
  const calls = { recFind: [], trfFind: [], recSort: [], trfSort: [], recById: [], trfById: [] };
  t.mock.method(User, "findById", async (id) => Object.values(USERS).find((u) => u._id.toString() === String(id)) || null);

  const chain = (rows, findLog, sortLog) => (filter) => {
    findLog.push(filter);
    const q = {
      sort: (s) => { sortLog.push(s); return q; },
      skip: () => q,
      limit: () => q,
      lean: async () => rows,
    };
    return q;
  };
  t.mock.method(DistributionRecommendation, "find", chain(recommendations, calls.recFind, calls.recSort));
  t.mock.method(DistributionRecommendation, "countDocuments", async () => recommendations.length);
  t.mock.method(DistributionRecommendation, "findById", (id) => {
    calls.recById.push(id);
    return { lean: async () => recommendations.find((r) => r._id === String(id)) || null };
  });
  t.mock.method(DistributionTransfer, "find", chain(transfers, calls.trfFind, calls.trfSort));
  t.mock.method(DistributionTransfer, "countDocuments", async () => transfers.length);
  t.mock.method(DistributionTransfer, "findById", (id) => {
    calls.trfById.push(id);
    return { lean: async () => transfers.find((r) => r._id === String(id)) || null };
  });
  t.mock.method(console, "error", () => {});
  return calls;
}

async function call(path, { user = USERS.admin, method = "GET", token } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = token;
  else if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  return { status: res.status, body: await res.json() };
}

// ─── Authorization ───────────────────────────────────────────────────────────

const ENDPOINTS = ["/recommendations", `/recommendations/${REC_ID}`, "/transfers", `/transfers/${TRF_ID}`];

test("auth: every endpoint rejects a missing token with 401", async (t) => {
  setup(t);
  for (const path of ENDPOINTS) assert.equal((await call(path, { user: null })).status, 401, path);
});

test("auth: malformed/invalid tokens and deactivated accounts get 401", async (t) => {
  setup(t);
  assert.equal((await call("/transfers", { token: "Token abc" })).status, 401);
  assert.equal((await call("/transfers", { token: "Bearer not-a-jwt" })).status, 401);
  assert.equal((await call("/transfers", { user: USERS.disabled })).status, 401);
});

test("auth: non-ADMIN users get 403 on every endpoint and no data is read", async (t) => {
  const calls = setup(t);
  for (const path of ENDPOINTS) assert.equal((await call(path, { user: USERS.employee })).status, 403, path);
  assert.equal(calls.recFind.length + calls.trfFind.length + calls.recById.length + calls.trfById.length, 0);
});

// ─── Recommendations ─────────────────────────────────────────────────────────

test("GET /recommendations lists with pagination, newest first by default", async (t) => {
  const calls = setup(t);
  const { status, body } = await call("/recommendations");
  assert.equal(status, 200);
  assert.deepEqual(body.data, [RECOMMENDATION]);
  assert.deepEqual(body.pagination, { page: 1, limit: 100, total: 1, totalPages: 1 });
  assert.deepEqual(calls.recSort[0], { generatedAt: -1, _id: 1 });
  assert.equal(calls.trfFind.length, 0, "recommendations never read transfers");
});

test("GET /recommendations applies column filters, search, sort allow-list and limits", async (t) => {
  const calls = setup(t);
  const { body } = await call("/recommendations?status=PENDING,APPROVED&destinationDepotId=DEP002&recommendedQuantityMin=50&search=mat0&sortBy=priority&sortDir=desc&page=2&limit=9999");
  const filter = calls.recFind[0];
  assert.deepEqual(filter.status, { $in: ["PENDING", "APPROVED"] });
  assert.deepEqual(filter.destinationDepotId, { $in: ["DEP002"] });
  assert.deepEqual(filter.recommendedQuantity, { $gte: 50 });
  assert.equal(filter.$or.length, 4);
  assert.deepEqual(calls.recSort[0], { priority: -1, _id: 1 });
  assert.equal(body.pagination.page, 2);
  assert.equal(body.pagination.limit, 500, "limit is capped");

  await call("/recommendations?sortBy=__proto__");
  assert.deepEqual(calls.recSort[1], { generatedAt: -1, _id: 1 }, "unknown sort field falls back");
});

test("GET /recommendations/:id returns one, 404 when missing, 400 when malformed", async (t) => {
  setup(t);
  const ok = await call(`/recommendations/${REC_ID}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { recommendation: RECOMMENDATION });
  assert.equal((await call(`/recommendations/${new mongoose.Types.ObjectId()}`)).status, 404);
  const bad = await call("/recommendations/not-an-id");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.message, "Invalid recommendation id.");
});

// ─── Transfers ───────────────────────────────────────────────────────────────

test("GET /transfers lists with pagination and filters, newest request first", async (t) => {
  const calls = setup(t);
  const { status, body } = await call("/transfers?status=IN_TRANSIT&materialNoMode=startsWith&materialNoText=MAT00");
  assert.equal(status, 200);
  assert.deepEqual(body.data, [TRANSFER]);
  assert.deepEqual(calls.trfFind[0].status, { $in: ["IN_TRANSIT"] });
  assert.deepEqual(calls.trfFind[0].materialNo, { $regex: "^MAT00", $options: "i" });
  assert.deepEqual(calls.trfSort[0], { requestedAt: -1, _id: 1 });
  assert.equal(calls.recFind.length, 0, "transfers never read recommendations");
});

test("GET /transfers/:id returns one, 404 when missing, 400 when malformed", async (t) => {
  setup(t);
  const ok = await call(`/transfers/${TRF_ID}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { transfer: TRANSFER });
  assert.equal((await call(`/transfers/${new mongoose.Types.ObjectId()}`)).status, 404);
  assert.equal((await call("/transfers/123")).status, 400);
});

test("a database failure returns 500 without leaking details", async (t) => {
  setup(t);
  t.mock.method(DistributionTransfer, "countDocuments", async () => { throw new Error("connection lost"); });
  const res = await call("/transfers");
  assert.equal(res.status, 500);
  assert.equal(res.body.message, "Internal server error while fetching distribution transfers.");
});

// ─── Stage 1 is read-only ────────────────────────────────────────────────────

test("recommendation/transfer write routes are exactly generation + the Stage 4 lifecycle, each transactional and idempotent", async (t) => {
  setup(t);
  // No direct edit/delete routes ever exist for recommendations or transfers.
  for (const [method, path] of [["PUT", `/recommendations/${REC_ID}`], ["PATCH", `/transfers/${TRF_ID}`], ["DELETE", `/transfers/${TRF_ID}`], ["DELETE", `/recommendations/${REC_ID}`]]) {
    assert.equal((await call(path, { method })).status, 404, `${method} ${path}`);
  }
  const { requireTransactions } = require("../utils/transactions");
  const { requireIdempotencyKey } = require("../middleware/idempotency");
  const writes = distributionRoutes.stack
    .filter((l) => l.route && /^\/(recommendations|transfers)/.test(l.route.path) && !l.route.methods.get)
    .map((l) => ({ route: `${Object.keys(l.route.methods).join(",")} ${l.route.path}`, handles: l.route.stack.map((x) => x.handle) }));
  assert.deepEqual(writes.map((w) => w.route), [
    "post /recommendations/generate",
    "post /recommendations/:id/approve", "post /recommendations/:id/reject",
    "post /transfers", "post /transfers/:id/approve", "post /transfers/:id/dispatch",
    "post /transfers/:id/in-transit", "post /transfers/:id/receive", "post /transfers/:id/cancel",
  ]);
  writes.filter((w) => w.route !== "post /recommendations/generate").forEach((w) => {
    assert.equal(w.handles[0], requireTransactions, `${w.route} must fail closed without transactions`);
    assert.equal(w.handles[1], requireIdempotencyKey, `${w.route} must require an Idempotency-Key`);
  });
});
