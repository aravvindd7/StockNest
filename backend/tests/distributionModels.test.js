/**
 * Distribution Master Stage 1 — model, lifecycle and reference-check tests.
 *
 * DB-free: documents are checked with doc.validate(), persisted records are
 * simulated with Model.hydrate() (which runs the same init hook a real load
 * does), and Material/Depot lookups are mocked with t.mock.method — the same
 * conventions as the existing suite.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DistributionRecommendation = require("../models/DistributionRecommendation");
const DistributionTransfer = require("../models/DistributionTransfer");
const Material = require("../models/Material");
const Depot = require("../models/Depot");
const distributionService = require("../services/distributionService");
const {
  RECOMMENDATION_TRANSITIONS,
  TRANSFER_TRANSITIONS,
  TRANSFER_STATUSES,
  RECOMMENDATION_STATUSES,
  canTransition,
} = require("../utils/distributionLifecycle");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function recommendationData(overrides = {}) {
  return {
    materialNo: "mat0001",
    sourceDepotId: "dep001",
    destinationDepotId: "dep002",
    forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 },
    sourceCurrentStock: 2570,
    sourceStockInHand: 2279,
    sourceSafetyStock: 12,
    sourceForecastDemand: 1186,
    sourceSurplus: 1372,
    destinationCurrentStock: 366,
    destinationSafetyStock: 12,
    destinationForecastDemand: 2441,
    destinationShortage: 2087,
    recommendedQuantity: 1372,
    priority: "CRITICAL",
    reason: "DEP002 covers 0.45 months of demand; DEP001 holds 1,372 units above safety stock + 3-month demand.",
    ...overrides,
  };
}

const T0 = new Date("2026-10-09T09:00:00Z");
const at = (h) => new Date(T0.getTime() + h * 3600 * 1000);

function transferData(overrides = {}) {
  return {
    transferId: "trf-000001",
    materialNo: "MAT0001",
    sourceDepotId: "DEP001",
    destinationDepotId: "DEP002",
    reason: "Shortage at DEP002",
    requestedQuantity: 500,
    requestedBy: "admin",
    requestedAt: T0,
    ...overrides,
  };
}

const approvedFields = { approvedQuantity: 450, approvedBy: "admin", approvedAt: at(1) };
// Stage 4: a dispatch also records the exact Stock rows moved and the unit cost used.
const dispatchedFields = {
  dispatchedQuantity: 450, dispatchedBy: "dep001.user", dispatchedAt: at(2),
  sourcePlantName: "Chennai Plant", sourceStockId: new mongoose.Types.ObjectId(),
  destinationPlantName: "Coimbatore Plant", destinationStockId: new mongoose.Types.ObjectId(), unitCost: 54.04,
};
const inTransitFields = { inTransitBy: "carrier", inTransitAt: at(3) };
const receivedFields = { receivedQuantity: 440, receivedBy: "dep002.user", receivedAt: at(30), transitLossQuantity: 10, discrepancyReason: "10 damaged in transit" };

/**
 * A record as if loaded from MongoDB in the given status (runs the init hook).
 * Built through the constructor first so setters (trim/uppercase) apply — data
 * read back from MongoDB is already normalized.
 */
function persisted(Model, data) {
  return Model.hydrate(new Model(data).toObject());
}

async function errorsOf(doc) {
  try {
    await doc.validate();
    return {};
  } catch (err) {
    assert.ok(err instanceof mongoose.Error.ValidationError, `expected ValidationError, got ${err}`);
    return err.errors;
  }
}

// ─── Lifecycle maps ──────────────────────────────────────────────────────────

test("lifecycle: transfer follows REQUESTED → APPROVED → DISPATCHED → IN_TRANSIT → RECEIVED", () => {
  const path = ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT", "RECEIVED"];
  for (let i = 1; i < path.length; i += 1) assert.ok(canTransition(TRANSFER_TRANSITIONS, path[i - 1], path[i]));
  assert.ok(canTransition(TRANSFER_TRANSITIONS, "REQUESTED", "CANCELLED"));
  assert.ok(canTransition(TRANSFER_TRANSITIONS, "APPROVED", "CANCELLED"));
  for (const from of ["DISPATCHED", "IN_TRANSIT", "RECEIVED"]) assert.ok(!canTransition(TRANSFER_TRANSITIONS, from, "CANCELLED"));
  assert.ok(!canTransition(TRANSFER_TRANSITIONS, "REQUESTED", "DISPATCHED"), "cannot skip approval");
  assert.ok(!canTransition(TRANSFER_TRANSITIONS, "RECEIVED", "REQUESTED"), "terminal");
  assert.deepEqual(Object.keys(TRANSFER_TRANSITIONS).sort(), [...TRANSFER_STATUSES].sort());
});

test("lifecycle: recommendation PENDING → APPROVED | REJECTED | SUPERSEDED, all terminal", () => {
  for (const to of ["APPROVED", "REJECTED", "SUPERSEDED"]) assert.ok(canTransition(RECOMMENDATION_TRANSITIONS, "PENDING", to));
  for (const from of ["APPROVED", "REJECTED", "SUPERSEDED"]) assert.deepEqual(RECOMMENDATION_TRANSITIONS[from], []);
  assert.deepEqual(Object.keys(RECOMMENDATION_TRANSITIONS).sort(), [...RECOMMENDATION_STATUSES].sort());
});

// ─── DistributionRecommendation ──────────────────────────────────────────────

test("recommendation: valid record passes, normalizes identifiers, defaults PENDING + generatedAt", async () => {
  const doc = new DistributionRecommendation(recommendationData());
  assert.deepEqual(await errorsOf(doc), {});
  assert.equal(doc.materialNo, "MAT0001");
  assert.equal(doc.sourceDepotId, "DEP001");
  assert.equal(doc.status, "PENDING");
  assert.ok(doc.generatedAt instanceof Date);
});

test("recommendation: required snapshot fields are enforced", async () => {
  const errors = await errorsOf(new DistributionRecommendation({}));
  for (const f of ["materialNo", "sourceDepotId", "destinationDepotId", "forecastPeriod", "sourceCurrentStock", "sourceStockInHand",
    "sourceSafetyStock", "sourceSurplus", "destinationCurrentStock", "destinationSafetyStock",
    "destinationForecastDemand", "destinationShortage", "recommendedQuantity", "priority", "reason"]) {
    assert.ok(errors[f], `${f} should be required`);
  }
});

test("recommendation: invalid quantities are rejected", async () => {
  const cases = [
    [{ recommendedQuantity: 0 }, "recommendedQuantity"],
    [{ recommendedQuantity: 12.5 }, "recommendedQuantity"],
    [{ recommendedQuantity: -5 }, "recommendedQuantity"],
    [{ sourceCurrentStock: -1 }, "sourceCurrentStock"],
    [{ destinationShortage: -3 }, "destinationShortage"],
    [{ recommendedQuantity: 1373 }, "recommendedQuantity"], // > sourceSurplus — never strip the source
    [{ sourceSurplus: 3000 }, "sourceSurplus"], // > sourceStockInHand
    [{ sourceSurplus: 2300 }, "sourceSurplus"], // ≤ total stock but > stock in hand: in-transit stock is not transferable
    [{ sourceStockInHand: 2600 }, "sourceStockInHand"], // stock in hand > total stock
    [{ destinationCurrentStock: "lots" }, "destinationCurrentStock"],
  ];
  for (const [override, field] of cases) {
    const errors = await errorsOf(new DistributionRecommendation(recommendationData(override)));
    assert.ok(errors[field], `${JSON.stringify(override)} should fail on ${field}`);
  }
});

test("recommendation: invalid identifiers / period / enums are rejected", async () => {
  const cases = [
    [{ destinationDepotId: "DEP001" }, "destinationDepotId"], // same as source
    [{ materialNo: "   " }, "materialNo"],
    [{ priority: "URGENT" }, "priority"],
    [{ forecastPeriod: { financialYear: "2026", startMonth: "October", horizonMonths: 3 } }, "forecastPeriod.financialYear"],
    [{ forecastPeriod: { financialYear: "2026-27", startMonth: "Oct", horizonMonths: 3 } }, "forecastPeriod.startMonth"],
    [{ forecastPeriod: { financialYear: "2026-27", startMonth: "October", horizonMonths: 13 } }, "forecastPeriod.horizonMonths"],
  ];
  for (const [override, field] of cases) {
    const errors = await errorsOf(new DistributionRecommendation(recommendationData(override)));
    assert.ok(errors[field], `${JSON.stringify(override)} should fail on ${field}`);
  }
});

test("recommendation: accepts every valid status value only via legal paths; rejects unknown status", async () => {
  assert.ok((await errorsOf(new DistributionRecommendation(recommendationData({ status: "DONE" })))).status);
  // A brand-new recommendation cannot be born APPROVED.
  const born = new DistributionRecommendation(recommendationData({ status: "APPROVED", ...approvedReview() }));
  assert.match((await errorsOf(born)).status.message, /must start as PENDING/);
});

function approvedReview() {
  return { approvedQuantity: 1000, reviewedBy: "admin", reviewedAt: T0 };
}

test("recommendation: PENDING → APPROVED requires review data and an approved quantity ≤ surplus", async () => {
  const doc = persisted(DistributionRecommendation, recommendationData({ status: "PENDING" }));
  doc.status = "APPROVED";
  const errors = await errorsOf(doc);
  assert.ok(errors.approvedQuantity && errors.reviewedBy && errors.reviewedAt);

  Object.assign(doc, { ...approvedReview(), approvedQuantity: 2000 });
  assert.ok((await errorsOf(doc)).approvedQuantity, "approved quantity above surplus");

  doc.approvedQuantity = 1000; // admin edited the 1,372 suggestion down
  assert.deepEqual(await errorsOf(doc), {});
});

test("recommendation: PENDING → REJECTED needs reviewer; approvedQuantity/transferId not allowed", async () => {
  const doc = persisted(DistributionRecommendation, recommendationData({ status: "PENDING" }));
  doc.status = "REJECTED";
  assert.ok((await errorsOf(doc)).reviewedBy);
  Object.assign(doc, { reviewedBy: "admin", reviewedAt: T0, approvedQuantity: 5, transferId: "TRF-000001" });
  const errors = await errorsOf(doc);
  assert.ok(errors.approvedQuantity && errors.transferId);
});

test("recommendation: terminal statuses cannot move again", async () => {
  for (const [from, to] of [["APPROVED", "PENDING"], ["REJECTED", "APPROVED"], ["SUPERSEDED", "PENDING"], ["APPROVED", "REJECTED"]]) {
    const extra = from === "APPROVED" ? approvedReview() : from === "REJECTED" ? { reviewedBy: "admin", reviewedAt: T0 } : {};
    const doc = persisted(DistributionRecommendation, recommendationData({ status: from, ...extra }));
    doc.status = to;
    const errors = await errorsOf(doc);
    assert.match(errors.status?.message || "", new RegExp(`Invalid recommendation status transition: ${from} → ${to}`));
  }
});

test("recommendation: generated snapshot is immutable once persisted", () => {
  const doc = persisted(DistributionRecommendation, recommendationData());
  doc.recommendedQuantity = 1;
  doc.reason = "edited";
  doc.materialNo = "MAT0002";
  assert.equal(doc.recommendedQuantity, 1372);
  assert.match(doc.reason, /covers 0.45 months/);
  assert.equal(doc.materialNo, "MAT0001");
});

// ─── DistributionTransfer ────────────────────────────────────────────────────

test("transfer: valid REQUESTED transfer passes and normalizes transferId", async () => {
  const doc = new DistributionTransfer(transferData());
  assert.deepEqual(await errorsOf(doc), {});
  assert.equal(doc.transferId, "TRF-000001");
  assert.equal(doc.status, "REQUESTED");
});

test("transfer: required fields and transferId format", async () => {
  const errors = await errorsOf(new DistributionTransfer({}));
  for (const f of ["transferId", "materialNo", "sourceDepotId", "destinationDepotId", "reason", "requestedQuantity", "requestedBy"]) {
    assert.ok(errors[f], `${f} should be required`);
  }
  assert.ok((await errorsOf(new DistributionTransfer(transferData({ transferId: "T-1" })))).transferId);
});

test("transfer: invalid quantities and same-depot route are rejected", async () => {
  const cases = [
    [{ requestedQuantity: 0 }, "requestedQuantity"],
    [{ requestedQuantity: 2.5 }, "requestedQuantity"],
    [{ requestedQuantity: -10 }, "requestedQuantity"],
    [{ destinationDepotId: "DEP001" }, "destinationDepotId"],
  ];
  for (const [override, field] of cases) {
    assert.ok((await errorsOf(new DistributionTransfer(transferData(override))))[field], `${JSON.stringify(override)} → ${field}`);
  }
});

test("transfer: a new transfer must start REQUESTED and unknown statuses are rejected", async () => {
  const born = new DistributionTransfer(transferData({ status: "RECEIVED", ...approvedFields, ...dispatchedFields, ...inTransitFields, ...receivedFields }));
  assert.match((await errorsOf(born)).status.message, /must start as REQUESTED/);
  assert.ok((await errorsOf(new DistributionTransfer(transferData({ status: "LOST" })))).status);
});

test("transfer: full lifecycle walks every legal step with stage data", async () => {
  const doc = persisted(DistributionTransfer, transferData());
  const steps = [["APPROVED", approvedFields], ["DISPATCHED", dispatchedFields], ["IN_TRANSIT", inTransitFields], ["RECEIVED", receivedFields]];
  for (const [status, fields] of steps) {
    Object.assign(doc, fields, { status });
    assert.deepEqual(await errorsOf(doc), {}, `step to ${status}`);
    doc.$locals.persistedStatus = status; // as if saved
  }
});

test("transfer: illegal transitions are rejected", async () => {
  const cases = [
    ["REQUESTED", {}, "DISPATCHED", dispatchedFields],
    ["REQUESTED", {}, "RECEIVED", receivedFields],
    ["DISPATCHED", { ...approvedFields, ...dispatchedFields }, "CANCELLED", { cancelledBy: "admin", cancelledAt: at(5), cancellationReason: "x" }],
    ["RECEIVED", { ...approvedFields, ...dispatchedFields, ...inTransitFields, ...receivedFields }, "IN_TRANSIT", {}],
    ["CANCELLED", { cancelledBy: "admin", cancelledAt: at(1), cancellationReason: "x" }, "APPROVED", approvedFields],
  ];
  for (const [from, fromData, to, toData] of cases) {
    const doc = persisted(DistributionTransfer, transferData({ status: from, ...fromData }));
    Object.assign(doc, toData, { status: to });
    assert.match((await errorsOf(doc)).status?.message || "", new RegExp(`${from} → ${to}`), `${from} → ${to}`);
  }
});

test("transfer: each reached stage requires its data; unreached stages must be empty", async () => {
  const missing = persisted(DistributionTransfer, transferData());
  missing.status = "APPROVED";
  const errors = await errorsOf(missing);
  assert.ok(errors.approvedQuantity && errors.approvedBy && errors.approvedAt);

  const premature = new DistributionTransfer(transferData({ dispatchedQuantity: 10 }));
  assert.match((await errorsOf(premature)).dispatchedQuantity.message, /cannot be set before/);
});

test("transfer: quantities can only shrink along the chain", async () => {
  const doc = persisted(DistributionTransfer, transferData({ status: "IN_TRANSIT", ...approvedFields, ...dispatchedFields, ...inTransitFields }));
  doc.status = "RECEIVED";
  Object.assign(doc, receivedFields, { receivedQuantity: 451 });
  assert.ok((await errorsOf(doc)).receivedQuantity, "received > dispatched");

  const over = persisted(DistributionTransfer, transferData());
  Object.assign(over, approvedFields, { status: "APPROVED", approvedQuantity: 501 });
  assert.ok((await errorsOf(over)).approvedQuantity, "approved > requested");

  const shortReceipt = persisted(DistributionTransfer, transferData({ status: "IN_TRANSIT", ...approvedFields, ...dispatchedFields, ...inTransitFields }));
  Object.assign(shortReceipt, receivedFields, { status: "RECEIVED", receivedQuantity: 0, transitLossQuantity: 450 });
  assert.deepEqual(await errorsOf(shortReceipt), {}, "a short/zero receipt is recorded as-is");
});

test("transfer: timestamps must follow the lifecycle order", async () => {
  const doc = persisted(DistributionTransfer, transferData());
  Object.assign(doc, approvedFields, { status: "APPROVED", approvedAt: at(-1) });
  assert.ok((await errorsOf(doc)).approvedAt);
});

test("transfer: cancellation needs actor, time and reason, and keeps approval data when cancelled after approval", async () => {
  const fromRequested = persisted(DistributionTransfer, transferData());
  fromRequested.status = "CANCELLED";
  const errors = await errorsOf(fromRequested);
  assert.ok(errors.cancelledBy && errors.cancelledAt && errors.cancellationReason);

  const fromApproved = persisted(DistributionTransfer, transferData({ status: "APPROVED", ...approvedFields }));
  Object.assign(fromApproved, { status: "CANCELLED", cancelledBy: "admin", cancelledAt: at(4), cancellationReason: "Demand fell" });
  assert.deepEqual(await errorsOf(fromApproved), {});

  const stray = new DistributionTransfer(transferData({ cancellationReason: "why" }));
  assert.ok((await errorsOf(stray)).cancellationReason, "cancel data only on CANCELLED");
});

test("transfer: statusHistory records each status change with actor and time", () => {
  const doc = new DistributionTransfer(transferData());
  doc.appendStatusHistory();
  assert.deepEqual(doc.statusHistory.map((h) => [h.status, h.changedBy, h.changedAt.getTime()]), [["REQUESTED", "admin", T0.getTime()]]);

  const loaded = persisted(DistributionTransfer, transferData({ statusHistory: [{ status: "REQUESTED", changedAt: T0, changedBy: "admin" }] }));
  loaded.appendStatusHistory(); // no status change → no entry
  assert.equal(loaded.statusHistory.length, 1);
  Object.assign(loaded, approvedFields, { status: "APPROVED" });
  loaded.$locals.statusNote = "Approved with reduced quantity";
  loaded.appendStatusHistory();
  assert.equal(loaded.statusHistory.length, 2);
  assert.equal(loaded.statusHistory[1].status, "APPROVED");
  assert.equal(loaded.statusHistory[1].changedBy, "admin");
  assert.equal(loaded.statusHistory[1].note, "Approved with reduced quantity");
});

test("transfer: identity and request fields are immutable once persisted", () => {
  const doc = persisted(DistributionTransfer, transferData());
  doc.transferId = "TRF-999999";
  doc.requestedQuantity = 1;
  doc.sourceDepotId = "DEP009";
  assert.equal(doc.transferId, "TRF-000001");
  assert.equal(doc.requestedQuantity, 500);
  assert.equal(doc.sourceDepotId, "DEP001");
});

// ─── Recommendation vs transfer separation ───────────────────────────────────

test("separation: recommendations and transfers are distinct models/collections with distinct lifecycles", () => {
  assert.notEqual(DistributionRecommendation.collection.collectionName, DistributionTransfer.collection.collectionName);
  assert.equal(DistributionRecommendation.collection.collectionName, "distributionrecommendations");
  assert.equal(DistributionTransfer.collection.collectionName, "distributiontransfers");
  // A transfer carries no forecast/surplus snapshot; a recommendation carries no dispatch/receipt data.
  for (const p of ["sourceSurplus", "destinationShortage", "destinationForecastDemand", "priority"]) {
    assert.equal(DistributionTransfer.schema.path(p), undefined, `transfer should not have ${p}`);
  }
  for (const p of ["dispatchedQuantity", "receivedQuantity", "dispatchedAt", "receivedAt"]) {
    assert.equal(DistributionRecommendation.schema.path(p), undefined, `recommendation should not have ${p}`);
  }
  assert.equal(DistributionTransfer.schema.path("recommendationId").options.ref, "DistributionRecommendation");
  assert.ok(!DistributionRecommendation.STATUS_VALUES.includes("DISPATCHED"));
});

test("indexes: one open PENDING recommendation per material + route + period; unique transferId", () => {
  const recIdx = DistributionRecommendation.schema.indexes().find(([, o]) => o.unique);
  assert.deepEqual(recIdx[1].partialFilterExpression, { status: "PENDING" });
  assert.ok(DistributionTransfer.schema.path("transferId").options.unique);
});

// ─── Reference checks against Material / Depot Master ────────────────────────

function mockMasters(t, { material = { materialNo: "MAT0001", status: "STD" }, depots = ["DEP001", "DEP002"] } = {}) {
  t.mock.method(Material, "findOne", () => ({ select: () => ({ lean: async () => material }) }));
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => depots.map((depotId) => ({ depotId })) }) }));
}

test("references: valid active material and existing depots pass (normalized)", async (t) => {
  mockMasters(t);
  const errors = await distributionService.validateReferences({ materialNo: " mat0001", sourceDepotId: "dep001", destinationDepotId: "DEP002" });
  assert.deepEqual(errors, []);
  assert.deepEqual(Material.findOne.mock.calls[0].arguments[0], { materialNo: "MAT0001", isActive: true });
  assert.deepEqual(Depot.find.mock.calls[0].arguments[0], { depotId: { $in: ["DEP001", "DEP002"] } });
});

test("references: unknown material, discontinued material and unknown depots are reported", async (t) => {
  mockMasters(t, { material: null, depots: ["DEP001"] });
  const errors = await distributionService.validateReferences({ materialNo: "MAT9999", sourceDepotId: "DEP001", destinationDepotId: "DEP777" });
  assert.ok(errors.some((e) => /MAT9999.*does not exist/.test(e)));
  assert.ok(errors.some((e) => /DEP777.*does not exist/.test(e)));

  t.mock.restoreAll();
  mockMasters(t, { material: { materialNo: "MAT0019", status: "Discontinued" } });
  assert.ok((await distributionService.validateReferences({ materialNo: "MAT0019", sourceDepotId: "DEP001", destinationDepotId: "DEP002" }))
    .some((e) => /discontinued/.test(e)));
});

test("references: missing or identical depots fail without querying the masters", async (t) => {
  mockMasters(t);
  assert.ok((await distributionService.validateReferences({ materialNo: "MAT0001", sourceDepotId: "DEP001", destinationDepotId: "dep001" }))
    .some((e) => /must be different/.test(e)));
  assert.ok((await distributionService.validateReferences({ materialNo: "", sourceDepotId: "", destinationDepotId: "DEP002" })).length >= 2);
  assert.equal(Material.findOne.mock.callCount(), 0);
});
