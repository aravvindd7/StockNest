/**
 * Depot ↔ Plant mapping — validation and lookup (Distribution Stage 2).
 *
 * Every write path (create, update, Excel import) normalizes input here and
 * checks it against the real masters BEFORE anything is written:
 *   - depotId must exist in Depot Master;
 *   - plantName must be an exact Plant value already used by Sales Master
 *     (Plant) or Stock Master (PlantName) — never derived from a depot name;
 *   - at most one ACTIVE mapping per plant (several plants may share a depot).
 *
 * resolveActivePlantMapping() is the single read path every consumer
 * (depot demand, depot safety stock, forecast evaluation) uses to translate
 * plants → depots, so they all see the same mapping and the same problems.
 */
const DepotPlantMapping = require("../models/DepotPlantMapping");
const Depot = require("../models/Depot");
const Sales = require("../models/Sales");
const Stock = require("../models/Stock");

const TRUE_VALUES = new Set(["true", "yes", "y", "1", "active"]);
const FALSE_VALUES = new Set(["false", "no", "n", "0", "inactive"]);

/** Parses an Active flag; blank means active. Returns undefined for an unrecognized value. */
function parseActive(raw) {
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return undefined;
}

/** Normalizes raw input (API body or import row) into model fields plus field-level errors. */
function normalizeMappingInput(raw = {}) {
  const errors = [];
  const depotId = String(raw.depotId ?? "").trim().toUpperCase();
  const plantName = String(raw.plantName ?? "").trim();
  const isActive = parseActive(raw.isActive);

  if (!depotId) errors.push("Depot ID is required.");
  if (!plantName) errors.push("Plant Name is required.");
  if (isActive === undefined) errors.push(`Active must be Yes/No (got "${raw.isActive}").`);

  let effectiveFrom;
  if (raw.effectiveFrom !== undefined && raw.effectiveFrom !== null && raw.effectiveFrom !== "") {
    effectiveFrom = raw.effectiveFrom instanceof Date ? raw.effectiveFrom : new Date(raw.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) {
      errors.push("Effective From must be a valid date.");
      effectiveFrom = undefined;
    }
  }
  const notes = raw.notes === undefined || raw.notes === null ? undefined : String(raw.notes).trim() || undefined;

  return { cleaned: { depotId, plantName, isActive: isActive !== false, effectiveFrom, notes }, errors };
}

/** Loads the reference sets every validation needs: Depot Master IDs and the Sales ∪ Stock plant values. */
async function loadReferenceSets() {
  const [depots, salesPlants, stockPlants] = await Promise.all([
    Depot.find({}).select("depotId").lean(),
    Sales.distinct("Plant"),
    Stock.distinct("PlantName"),
  ]);
  const clean = (values) => values.map((v) => String(v || "").trim()).filter(Boolean);
  return {
    depotIds: new Set(depots.map((d) => String(d.depotId).trim().toUpperCase())),
    plantNames: new Set([...clean(salesPlants), ...clean(stockPlants)]),
  };
}

/** Reference errors for one normalized mapping. */
function referenceErrors(cleaned, refs) {
  const errors = [];
  if (cleaned.depotId && !refs.depotIds.has(cleaned.depotId)) {
    errors.push(`Depot ID "${cleaned.depotId}" does not exist in Depot Master.`);
  }
  if (cleaned.plantName && !refs.plantNames.has(cleaned.plantName)) {
    errors.push(`Plant "${cleaned.plantName}" is not a Plant used in Sales Master or Stock Master.`);
  }
  return errors;
}

/**
 * Validates a whole candidate mapping set (an import file) — every row's
 * fields and references, plus "one active mapping per plant" across the set.
 * Returns { validRows, errors: [{ row, depotId, plantName, error }] }.
 */
function validateMappingSet(rawRows, refs) {
  const errors = [];
  const validRows = [];
  const activePlantRow = new Map();

  rawRows.forEach((raw, idx) => {
    const rowNumber = idx + 2; // header is row 1
    const { cleaned, errors: fieldErrors } = normalizeMappingInput(raw);
    const rowErrors = [...fieldErrors, ...referenceErrors(cleaned, refs)];
    if (cleaned.isActive && cleaned.plantName) {
      const firstRow = activePlantRow.get(cleaned.plantName);
      if (firstRow) rowErrors.push(`Plant "${cleaned.plantName}" already has an active mapping in this file (row ${firstRow}).`);
      else activePlantRow.set(cleaned.plantName, rowNumber);
    }
    if (rowErrors.length) errors.push({ row: rowNumber, depotId: cleaned.depotId, plantName: cleaned.plantName, error: rowErrors.join(" ") });
    else validRows.push(cleaned);
  });

  return { validRows, errors };
}

/**
 * The active plant → depot translation, plus what is wrong with it.
 * Active mappings pointing at a depot that no longer exists are excluded
 * from plantToDepot and reported, never silently used.
 */
async function resolveActivePlantMapping() {
  const [mappings, depots] = await Promise.all([
    DepotPlantMapping.find({}).lean(),
    Depot.find({}).select("depotId depotName").lean(),
  ]);
  const depotNames = new Map(depots.map((d) => [String(d.depotId).toUpperCase(), d.depotName]));
  const plantToDepot = new Map();
  const mappingsToUnknownDepots = [];
  const inactiveByPlant = new Map();

  mappings.forEach((m) => {
    if (!m.isActive) {
      if (!inactiveByPlant.has(m.plantName)) inactiveByPlant.set(m.plantName, []);
      inactiveByPlant.get(m.plantName).push(m.depotId);
      return;
    }
    if (!depotNames.has(m.depotId)) mappingsToUnknownDepots.push({ plantName: m.plantName, depotId: m.depotId });
    else plantToDepot.set(m.plantName, m.depotId);
  });

  // Plants whose ONLY mappings are inactive (an active one takes precedence).
  const inactiveOnlyPlants = new Map([...inactiveByPlant].filter(([plant]) => !plantToDepot.has(plant)));
  const mappedDepots = new Set(plantToDepot.values());
  const depotsWithoutActiveMapping = [...depotNames.keys()].filter((d) => !mappedDepots.has(d)).sort();

  return { plantToDepot, depotNames, inactiveOnlyPlants, mappingsToUnknownDepots, depotsWithoutActiveMapping };
}

module.exports = {
  parseActive,
  normalizeMappingInput,
  loadReferenceSets,
  referenceErrors,
  validateMappingSet,
  resolveActivePlantMapping,
};
