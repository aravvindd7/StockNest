/**
 * Material Master → Stock Master status synchronization — unit tests.
 *
 * Covers the pure, DB-free mapping rules in utils/stockStatusSync.js: the
 * STD/Discontinued → Active/Discontinued derivation, and the normalized
 * materialNo → status map builder an import row resolves against. The
 * DB-writing sync functions (syncStockStatusesFromMaterials /
 * syncStockStatusForMaterial) are exercised against the live MongoDB in the
 * end-to-end verification, which is where their correctness matters.
 *
 * Run with: `npm test` (node --test).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STOCK_STATUS_ACTIVE,
  STOCK_STATUS_DISCONTINUED,
  deriveStockStatus,
  buildStatusMapFromMaterials,
} = require("../utils/stockStatusSync");

// ─── deriveStockStatus ───────────────────────────────────────────────────────

test("1. STD + isActive → Active", () => {
  assert.equal(deriveStockStatus({ status: "STD", isActive: true }), STOCK_STATUS_ACTIVE);
});

test("2. Discontinued + isActive → Discontinued", () => {
  assert.equal(deriveStockStatus({ status: "Discontinued", isActive: true }), STOCK_STATUS_DISCONTINUED);
});

test("3. STD + isActive:false (soft-deleted) → Discontinued", () => {
  assert.equal(deriveStockStatus({ status: "STD", isActive: false }), STOCK_STATUS_DISCONTINUED);
});

test("4. Discontinued + isActive:false → Discontinued", () => {
  assert.equal(deriveStockStatus({ status: "Discontinued", isActive: false }), STOCK_STATUS_DISCONTINUED);
});

test("5. missing/invalid material record → Discontinued (fail-safe, never Active)", () => {
  assert.equal(deriveStockStatus(undefined), STOCK_STATUS_DISCONTINUED);
  assert.equal(deriveStockStatus({}), STOCK_STATUS_DISCONTINUED);
  assert.equal(deriveStockStatus({ status: "STD" }), STOCK_STATUS_DISCONTINUED); // isActive undefined
  assert.equal(deriveStockStatus({ status: "Weird", isActive: true }), STOCK_STATUS_DISCONTINUED);
});

// ─── buildStatusMapFromMaterials ─────────────────────────────────────────────

const SAMPLES = [
  { materialNo: "  mat0001 ", status: "STD", isActive: true }, // trimmed + uppercased
  { materialNo: "MAT0017", status: "Discontinued", isActive: true },
  { materialNo: "mat0009", status: "STD", isActive: false }, // soft-deleted → Discontinued
];
const MAP = buildStatusMapFromMaterials(SAMPLES);

test("6. material numbers are normalized (trim + uppercase) on both sides", () => {
  assert.equal(MAP.get("MAT0001"), STOCK_STATUS_ACTIVE);
  assert.ok(MAP.has("MAT0001"));
});

test("7. STD → Active, Discontinued → Discontinued, inactive → Discontinued", () => {
  assert.equal(MAP.get("MAT0001"), STOCK_STATUS_ACTIVE);
  assert.equal(MAP.get("MAT0017"), STOCK_STATUS_DISCONTINUED);
  assert.equal(MAP.get("MAT0009"), STOCK_STATUS_DISCONTINUED);
});

test("8. blank material numbers are skipped, never mapped", () => {
  const m = buildStatusMapFromMaterials([
    { materialNo: "   ", status: "STD", isActive: true },
    { materialNo: null, status: "STD", isActive: true },
    { materialNo: undefined, status: "STD", isActive: true },
  ]);
  assert.equal(m.size, 0);
});

test("9. import derivation — a discontinued material can never resolve to Active", () => {
  // This is exactly the lookup an import row performs: map.get(matNo). For
  // every discontinued/inactive material, the resolved status must be
  // Discontinued, regardless of the file's incoming Status value.
  for (const material of [
    { materialNo: "MAT0017", status: "Discontinued", isActive: true },
    { materialNo: "MAT0018", status: "STD", isActive: false },
  ]) {
    const map = buildStatusMapFromMaterials([material]);
    const resolved = map.get(String(material.materialNo).trim().toUpperCase());
    assert.equal(resolved, STOCK_STATUS_DISCONTINUED);
    assert.notEqual(resolved, STOCK_STATUS_ACTIVE);
  }
});