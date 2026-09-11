/**
 * Material Master → Stock Master status synchronization.
 *
 * Material Master is the single source of truth for a material's lifecycle
 * status. Stock Master's `Status` column is a denormalized mirror of that
 * source of truth, so every write path (Material create/edit/soft-delete,
 * Stock add/import) and the startup backfill converge on the exact same
 * derivation here — never a second, drifting copy of the rule.
 *
 * Mapping:
 *   Material STD + isActive:true  → Stock "Active"
 *   Material Discontinued         → Stock "Discontinued"
 *   Material inactive (isActive:false) → Stock "Discontinued"
 *
 * Only the Status field is ever written; stock quantities and every other
 * column are left untouched. Matching is by Material Master `materialNo` ↔
 * Stock Master `MatNo`, normalized (trim + uppercase) on both sides.
 */

const Material = require("../models/Material");
const Stock = require("../models/Stock");

const STOCK_STATUS_ACTIVE = "Active";
const STOCK_STATUS_DISCONTINUED = "Discontinued";

/**
 * Derive the Stock Master Status for a Material Master record.
 *
 * @param {{isActive?: boolean, status?: string}} material
 * @returns {"Active"|"Discontinued"}
 */
function deriveStockStatus(material = {}) {
  return material.isActive && material.status === "STD" ? STOCK_STATUS_ACTIVE : STOCK_STATUS_DISCONTINUED;
}

/**
 * Build a normalized (trim + uppercase) materialNo → Stock status map from an
 * array of Material documents. Material numbers with no usable value are
 * skipped. Pure and DB-free so it is directly unit-testable.
 *
 * @param {Array<{materialNo?: string, isActive?: boolean, status?: string}>} materials
 * @returns {Map<string, "Active"|"Discontinued">}
 */
function buildStatusMapFromMaterials(materials) {
  const map = new Map();
  materials.forEach((m) => {
    const key = String(m.materialNo || "").trim().toUpperCase();
    if (key) map.set(key, deriveStockStatus(m));
  });
  return map;
}

/**
 * Load every Material (active and inactive alike — an inactive material still
 * drives its existing Stock rows to "Discontinued") and return the status map.
 *
 * @returns {Promise<Map<string, "Active"|"Discontinued">>}
 */
async function loadMaterialStatusMap() {
  const materials = await Material.find({}).select("materialNo status isActive").lean();
  return buildStatusMapFromMaterials(materials);
}

/**
 * Backfill/synchronize ALL existing Stock records to their Material Master
 * status. Idempotent and non-destructive: only rows whose Status differs are
 * touched, and only the Status field changes. Stock rows whose MatNo has no
 * matching material are left untouched (unknown — never guessed).
 *
 * @returns {Promise<{totalMaterials:number, updatedActive:number, updatedDiscontinued:number}>}
 */
async function syncStockStatusesFromMaterials() {
  const statusMap = await loadMaterialStatusMap();
  const active = [];
  const discontinued = [];
  for (const [matNo, status] of statusMap) {
    (status === STOCK_STATUS_ACTIVE ? active : discontinued).push(matNo);
  }

  let updatedActive = 0;
  let updatedDiscontinued = 0;
  if (active.length > 0) {
    const r = await Stock.updateMany(
      { MatNo: { $in: active }, Status: { $ne: STOCK_STATUS_ACTIVE } },
      { $set: { Status: STOCK_STATUS_ACTIVE } }
    );
    updatedActive = r.modifiedCount;
  }
  if (discontinued.length > 0) {
    const r = await Stock.updateMany(
      { MatNo: { $in: discontinued }, Status: { $ne: STOCK_STATUS_DISCONTINUED } },
      { $set: { Status: STOCK_STATUS_DISCONTINUED } }
    );
    updatedDiscontinued = r.modifiedCount;
  }

  return { totalMaterials: statusMap.size, updatedActive, updatedDiscontinued };
}

/**
 * Sync all Stock rows for a single material to its Material Master status.
 * Used by the Material controller on create/edit/soft-delete. A no-op when
 * the material no longer exists.
 *
 * @param {string} materialNo
 * @returns {Promise<{updated:number, status?:string}>}
 */
async function syncStockStatusForMaterial(materialNo) {
  const key = String(materialNo || "").trim().toUpperCase();
  if (!key) return { updated: 0 };
  const material = await Material.findOne({ materialNo: key }).select("materialNo status isActive").lean();
  if (!material) return { updated: 0 };

  const status = deriveStockStatus(material);
  const r = await Stock.updateMany({ MatNo: key, Status: { $ne: status } }, { $set: { Status: status } });
  return { updated: r.modifiedCount, status };
}

module.exports = {
  STOCK_STATUS_ACTIVE,
  STOCK_STATUS_DISCONTINUED,
  deriveStockStatus,
  buildStatusMapFromMaterials,
  loadMaterialStatusMap,
  syncStockStatusesFromMaterials,
  syncStockStatusForMaterial,
};
