/**
 * Distribution Stage 2 — Depot ↔ Plant mapping tests.
 *
 * Schema/uniqueness, reference validation against Depot Master and the
 * Sales/Stock plant values, create/update conflict handling, REPLACE-only
 * all-or-nothing import, and ADMIN authorization over HTTP. DB-free: model
 * statics are mocked with t.mock.method, same as the existing suite.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "distribution-test-secret";

const DepotPlantMapping = require("../models/DepotPlantMapping");
const Depot = require("../models/Depot");
const Sales = require("../models/Sales");
const Stock = require("../models/Stock");
const User = require("../models/User");
const DatasetHistory = require("../models/DatasetHistory");
const service = require("../services/depotPlantMappingService");
const controller = require("../controllers/depotPlantMappingController");
const distributionRoutes = require("../routes/distributionRoutes");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEPOTS = ["DEP001", "DEP002", "DEP003"];
const SALES_PLANTS = ["Chennai Plant", "Coimbatore Plant"];
const STOCK_PLANTS = ["Chennai Plant", "Madurai Plant"];

function mockReferences(t) {
  t.mock.method(Depot, "find", () => ({ select: () => ({ lean: async () => DEPOTS.map((depotId) => ({ depotId })) }) }));
  t.mock.method(Sales, "distinct", async () => SALES_PLANTS);
  t.mock.method(Stock, "distinct", async () => STOCK_PLANTS);
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function workbook(aoa) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), "Mapping");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function importRequest(aoa, mode = "REPLACE") {
  return { body: { mode }, file: { buffer: workbook(aoa), originalname: "mapping.xlsx" }, user: { username: "admin" } };
}

/** Mocks persistence for import/restore and records the write sequence. */
function mockWrites(t) {
  const events = [];
  t.mock.method(DepotPlantMapping, "find", () => ({ lean: async () => [{ depotId: "DEP009", plantName: "Old Plant", isActive: true }] }));
  t.mock.method(DepotPlantMapping, "deleteMany", async () => { events.push("delete"); });
  t.mock.method(DepotPlantMapping, "insertMany", async (rows) => { events.push(["insert", rows]); });
  t.mock.method(DatasetHistory, "countDocuments", async () => 0);
  t.mock.method(DatasetHistory, "create", async (doc) => { events.push(["archive", doc]); return doc; });
  t.mock.method(console, "error", () => {});
  return events;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

test("schema: depotId and plantName required; depotId uppercased; plantName trimmed (case kept); active by default", async () => {
  const missing = new DepotPlantMapping({});
  const err = missing.validateSync();
  assert.ok(err.errors.depotId && err.errors.plantName);

  const doc = new DepotPlantMapping({ depotId: " dep001 ", plantName: "  Chennai Plant " });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.depotId, "DEP001");
  assert.equal(doc.plantName, "Chennai Plant");
  assert.equal(doc.isActive, true);
});

test("schema: one ACTIVE mapping per plant (partial unique index); depotId is not unique, so plants can share a depot", () => {
  const indexes = DepotPlantMapping.schema.indexes();
  const plantIdx = indexes.find(([fields]) => fields.plantName === 1);
  assert.deepEqual(plantIdx[1], { unique: true, partialFilterExpression: { isActive: true }, background: true });
  assert.ok(!indexes.some(([fields, opts]) => fields.depotId === 1 && opts.unique));
  assert.ok(!DepotPlantMapping.schema.path("depotId").options.unique);
});

test("Depot Master is unchanged — no plant field was added to it", () => {
  assert.deepEqual(Object.keys(Depot.schema.paths).sort(), ["__v", "_id", "createdAt", "depotId", "depotName", "updatedAt"]);
});

// ─── Normalization & reference validation ────────────────────────────────────

test("parseActive accepts the usual Yes/No spellings, blank = active, rejects anything else", () => {
  for (const v of [undefined, "", true, "Y", "yes", "TRUE", "1", "Active"]) assert.equal(service.parseActive(v), true, String(v));
  for (const v of [false, "N", "no", "false", "0", "Inactive"]) assert.equal(service.parseActive(v), false, String(v));
  assert.equal(service.parseActive("maybe"), undefined);
});

test("normalizeMappingInput reports missing fields, bad Active flag and invalid dates", () => {
  const { errors } = service.normalizeMappingInput({ depotId: "", plantName: " ", isActive: "maybe", effectiveFrom: "not a date" });
  assert.equal(errors.length, 4);
  const ok = service.normalizeMappingInput({ depotId: "dep001", plantName: "Chennai Plant", effectiveFrom: "2026-10-01", notes: " n " });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.cleaned.depotId, "DEP001");
  assert.ok(ok.cleaned.effectiveFrom instanceof Date);
  assert.equal(ok.cleaned.notes, "n");
});

test("references: depot must exist in Depot Master; plant must be a Sales OR Stock plant value", async (t) => {
  mockReferences(t);
  const refs = await service.loadReferenceSets();
  assert.deepEqual([...refs.plantNames].sort(), ["Chennai Plant", "Coimbatore Plant", "Madurai Plant"]);
  assert.deepEqual(service.referenceErrors({ depotId: "DEP001", plantName: "Madurai Plant" }, refs), [], "Stock-only plant is valid");
  const errors = service.referenceErrors({ depotId: "DEP999", plantName: "Chennai" }, refs);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /DEP999.*Depot Master/);
  assert.match(errors[1], /"Chennai" is not a Plant/, "no name matching: 'Chennai' is not 'Chennai Plant'");
});

test("validateMappingSet: per-row errors with row numbers; duplicate active plant rejected; shared depot and inactive history allowed", async (t) => {
  mockReferences(t);
  const refs = await service.loadReferenceSets();
  const { validRows, errors } = service.validateMappingSet([
    { depotId: "DEP001", plantName: "Chennai Plant" },
    { depotId: "DEP001", plantName: "Madurai Plant" }, // two plants → one depot: allowed
    { depotId: "DEP002", plantName: "Chennai Plant" }, // second ACTIVE mapping for the same plant
    { depotId: "DEP003", plantName: "Chennai Plant", isActive: "No" }, // inactive history: allowed
    { depotId: "DEP404", plantName: "Coimbatore Plant" },
  ], refs);
  assert.equal(validRows.length, 3);
  assert.deepEqual(errors.map((e) => e.row), [4, 6]);
  assert.match(errors[0].error, /already has an active mapping in this file \(row 2\)/);
  assert.match(errors[1].error, /DEP404/);
});

// ─── Create / update ─────────────────────────────────────────────────────────

test("create: valid mapping → 201; unknown depot/plant → 400; existing active mapping for the plant → 409", async (t) => {
  mockReferences(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(DepotPlantMapping, "findOne", () => ({ lean: async () => null }));
  t.mock.method(DepotPlantMapping, "create", async (doc) => ({ _id: "x", ...doc }));

  let res = response();
  await controller.createMapping({ body: { depotId: "dep002", plantName: "Coimbatore Plant" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(DepotPlantMapping.create.mock.calls[0].arguments[0].depotId, "DEP002");

  res = response();
  await controller.createMapping({ body: { depotId: "DEP777", plantName: "Coimbatore" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.errors.length, 2);

  t.mock.method(DepotPlantMapping, "findOne", () => ({ lean: async () => ({ _id: "existing", depotId: "DEP001" }) }));
  res = response();
  await controller.createMapping({ body: { depotId: "DEP002", plantName: "Chennai Plant" } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(DepotPlantMapping.create.mock.callCount(), 1, "no write on conflict");

  // A race that slips past the check is still caught by the unique index.
  t.mock.method(DepotPlantMapping, "findOne", () => ({ lean: async () => null }));
  t.mock.method(DepotPlantMapping, "create", async () => { const e = new Error("dup"); e.code = 11000; throw e; });
  res = response();
  await controller.createMapping({ body: { depotId: "DEP002", plantName: "Chennai Plant" } }, res);
  assert.equal(res.statusCode, 409);
});

test("create: an INACTIVE mapping for an already-mapped plant is allowed (history)", async (t) => {
  mockReferences(t);
  t.mock.method(DepotPlantMapping, "findOne", () => ({ lean: async () => ({ _id: "existing" }) }));
  t.mock.method(DepotPlantMapping, "create", async (doc) => doc);
  const res = response();
  await controller.createMapping({ body: { depotId: "DEP003", plantName: "Chennai Plant", isActive: false } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(DepotPlantMapping.findOne.mock.callCount(), 0);
});

test("update: merges fields, re-validates references and checks active clashes excluding itself", async (t) => {
  mockReferences(t);
  const id = new mongoose.Types.ObjectId();
  const doc = { _id: id, depotId: "DEP001", plantName: "Chennai Plant", isActive: false, save: async () => {} };
  t.mock.method(DepotPlantMapping, "findById", async () => doc);
  t.mock.method(DepotPlantMapping, "findOne", () => ({ lean: async () => null }));

  let res = response();
  await controller.updateMapping({ params: { id: String(id) }, body: { isActive: true, notes: "re-activated" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(doc.isActive, true);
  assert.deepEqual(DepotPlantMapping.findOne.mock.calls[0].arguments[0], { plantName: "Chennai Plant", isActive: true, _id: { $ne: id } });

  res = response();
  await controller.updateMapping({ params: { id: String(id) }, body: { depotId: "NOPE" } }, res);
  assert.equal(res.statusCode, 400);

  res = response();
  await controller.updateMapping({ params: { id: "bad" }, body: {} }, res);
  assert.equal(res.statusCode, 400);
});

// ─── Import (REPLACE only, validated before writing) ─────────────────────────

const HEADER = ["Depot ID", "Plant Name", "Active", "Effective From", "Notes"];

test("import: only REPLACE mode is accepted", async (t) => {
  const events = mockWrites(t);
  for (const mode of ["APPEND", "", "replace-all"]) {
    const res = response();
    await controller.importMappings(importRequest([HEADER, ["DEP001", "Chennai Plant"]], mode), res);
    assert.equal(res.statusCode, 400, mode);
  }
  assert.deepEqual(events, []);
});

test("import: missing required columns → 422, nothing written", async (t) => {
  const events = mockWrites(t);
  const res = response();
  await controller.importMappings(importRequest([["Depot ID", "Notes"], ["DEP001", "x"]]), res);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body.missingRequiredColumns, ["Plant Name"]);
  assert.deepEqual(events, []);
});

test("import: ANY invalid row rejects the whole file — no archive, delete or insert", async (t) => {
  mockReferences(t);
  const events = mockWrites(t);
  const res = response();
  await controller.importMappings(importRequest([
    HEADER,
    ["DEP001", "Chennai Plant", "Y", "", ""],
    ["DEP002", "Chennai Plant", "Y", "", ""], // duplicate active plant
    ["DEP404", "Madurai Plant", "", "", ""], // unknown depot
  ]), res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.failedRecords, 2);
  assert.equal(res.body.addedCount, 0);
  assert.deepEqual(res.body.errors.map((e) => e.row), [3, 4]);
  assert.deepEqual(events, []);
});

test("import: empty file is rejected instead of wiping the mapping", async (t) => {
  mockReferences(t);
  const events = mockWrites(t);
  const res = response();
  await controller.importMappings(importRequest([HEADER]), res);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(events, []);
});

test("import: valid file archives the current set to Import History, then replaces it", async (t) => {
  mockReferences(t);
  const events = mockWrites(t);
  const res = response();
  await controller.importMappings(importRequest([
    HEADER,
    ["dep001", "Chennai Plant", "Yes", "2026-10-01", "primary"],
    ["DEP001", "Madurai Plant", "", "", ""],
    ["DEP002", "Coimbatore Plant", "", "", ""],
  ]), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.addedCount, 3);
  assert.deepEqual(events.map((e) => (Array.isArray(e) ? e[0] : e)), ["archive", "delete", "insert"]);
  const archive = events[0][1];
  assert.equal(archive.module, "depotPlantMapping");
  assert.equal(archive.batchId, "DPM-IMP-0001");
  assert.equal(archive.importType, "REPLACE");
  assert.equal(archive.snapshotData[0].plantName, "Old Plant");
  const inserted = events[2][1];
  assert.deepEqual(inserted.map((r) => [r.depotId, r.plantName, r.isActive]), [
    ["DEP001", "Chennai Plant", true], ["DEP001", "Madurai Plant", true], ["DEP002", "Coimbatore Plant", true],
  ]);
  assert.ok(inserted[0].effectiveFrom instanceof Date);
});

test("import: the canonical dataset's Plant_Depot_Map headers (depotId / PlantName + extra columns) are accepted", async (t) => {
  mockReferences(t);
  const events = mockWrites(t);
  const res = response();
  await controller.importMappings(importRequest([
    ["depotId", "depotName", "PlantName", "Region", "SizeClass"],
    ["DEP001", "Chennai", "Chennai Plant", "South", "Large"],
  ]), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(events[2][1].map((r) => [r.depotId, r.plantName]), [["DEP001", "Chennai Plant"]]);
});

test("restore: archives the current set, then restores the snapshot", async (t) => {
  const events = mockWrites(t);
  t.mock.method(DatasetHistory, "findOne", async () => ({ batchId: "DPM-IMP-0001", snapshotData: [{ depotId: "DEP001", plantName: "Chennai Plant", isActive: true }] }));
  const res = response();
  await controller.viewImportHistory({ params: { id: String(new mongoose.Types.ObjectId()) }, user: { username: "admin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.restoredCount, 1);
  assert.deepEqual(events.map((e) => (Array.isArray(e) ? e[0] : e)), ["archive", "delete", "insert"]);
  assert.equal(events[0][1].importType, "RESTORE");
});

test("import history: DatasetHistory accepts the new module key", () => {
  assert.ok(DatasetHistory.MODULES.includes("depotPlantMapping"));
  const doc = new DatasetHistory({ module: "depotPlantMapping", batchId: "DPM-IMP-0001", fileName: "f", importType: "REPLACE", importedBy: "admin" });
  assert.equal(doc.validateSync(), undefined);
});

// ─── ADMIN authorization over HTTP ───────────────────────────────────────────

test("authorization: every mapping endpoint is ADMIN-only (401 without token, 403 for USER)", async (t) => {
  const admin = { _id: new mongoose.Types.ObjectId(), username: "admin", role: "ADMIN", isActive: true };
  const employee = { _id: new mongoose.Types.ObjectId(), username: "employee", role: "USER", isActive: true };
  t.mock.method(User, "findById", async (id) => [admin, employee].find((u) => String(u._id) === String(id)) || null);
  t.mock.method(DepotPlantMapping, "find", () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }));
  t.mock.method(DepotPlantMapping, "countDocuments", async () => 0);
  const create = t.mock.method(DepotPlantMapping, "create", async () => ({}));
  const del = t.mock.method(DepotPlantMapping, "deleteMany", async () => {});

  const app = express();
  app.use(express.json());
  app.use("/api/distribution", distributionRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/distribution`;
  const call = (method, path, user) => fetch(`${base}${path}`, {
    method,
    headers: user ? { Authorization: `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET)}` } : {},
  }).then((r) => r.status);

  const id = String(new mongoose.Types.ObjectId());
  const endpoints = [["GET", "/plant-mappings"], ["POST", "/plant-mappings"], ["GET", `/plant-mappings/${id}`], ["PUT", `/plant-mappings/${id}`],
    ["POST", "/plant-mappings/import"], ["GET", "/plant-mappings/import-history"], ["POST", `/plant-mappings/import-history/${id}/view`],
    ["GET", "/demand"], ["GET", "/safety-stock"], ["POST", "/safety-stock/refresh"], ["GET", "/forecast-evaluation"]];
  for (const [method, path] of endpoints) {
    assert.equal(await call(method, path), 401, `${method} ${path} without token`);
    assert.equal(await call(method, path, employee), 403, `${method} ${path} as USER`);
  }
  assert.equal(await call("GET", "/plant-mappings", admin), 200);
  assert.equal(create.mock.callCount() + del.mock.callCount(), 0, "rejected requests never write");
});
