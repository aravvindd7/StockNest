const mongoose = require("mongoose");
const DepotPlantMapping = require("../models/DepotPlantMapping");
const DatasetHistory = require("../models/DatasetHistory");
const { parseWorkbook, validateHeaders, normalizeRow } = require("../utils/excelParser");
const { archiveSnapshot } = require("../utils/datasetHistoryHelper");
const { buildMongoFilter, buildSort, escapeRegex } = require("../utils/queryFilterBuilder");
const mappingService = require("../services/depotPlantMappingService");

const MODULE_KEY = "depotPlantMapping";
const SORTABLE_FIELDS = ["depotId", "plantName", "isActive", "effectiveFrom", "createdAt"];
const FILTER_CONFIG = [
  { dbField: "depotId", type: "text" },
  { dbField: "plantName", type: "text" },
];

// Import columns. "Depot ID" / "Plant Name" also match the canonical
// dataset's Plant_Depot_Map headers (depotId / PlantName) — header matching
// is case- and space-insensitive, the same as every other master import.
const REQUIRED_HEADERS = [
  { header: "Depot ID", key: "depotId" },
  { header: "Plant Name", key: "plantName" },
];
const OPTIONAL_HEADERS = [
  { header: "Active", key: "isActive" },
  { header: "Effective From", key: "effectiveFrom" },
  { header: "Notes", key: "notes" },
];

const DUPLICATE_ACTIVE_MESSAGE = "This plant already has an active depot mapping. Deactivate it first.";

/** GET /api/distribution/plant-mappings — Admin only. Filters: depotId, plantName, isActive=true|false, search. */
async function listMappings(req, res) {
  try {
    const { search, isActive, page = 1, limit = 100 } = req.query;
    const query = buildMongoFilter(req.query, FILTER_CONFIG);
    if (isActive === "true" || isActive === "false") query.isActive = isActive === "true";
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ depotId: rx }, { plantName: rx }, { notes: rx }];
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const sort = buildSort(req.query, SORTABLE_FIELDS, "depotId");

    const [data, total] = await Promise.all([
      DepotPlantMapping.find(query).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      DepotPlantMapping.countDocuments(query),
    ]);
    res.json({ data, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) } });
  } catch (err) {
    console.error("[depotPlantMappingController.listMappings]", err);
    res.status(500).json({ message: "Internal server error while fetching depot-plant mappings." });
  }
}

/** GET /api/distribution/plant-mappings/:id — Admin only. */
async function getMappingById(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid mapping id." });
    const mapping = await DepotPlantMapping.findById(req.params.id).lean();
    if (!mapping) return res.status(404).json({ message: "Depot-plant mapping not found." });
    res.json({ mapping });
  } catch (err) {
    console.error("[depotPlantMappingController.getMappingById]", err);
    res.status(500).json({ message: "Internal server error while fetching the depot-plant mapping." });
  }
}

/** Field + reference + active-uniqueness checks shared by create and update. */
async function validateForWrite(cleaned, fieldErrors, excludeId) {
  const errors = [...fieldErrors];
  if (!errors.length) errors.push(...mappingService.referenceErrors(cleaned, await mappingService.loadReferenceSets()));
  if (errors.length) return { status: 400, body: { message: "Validation failed.", errors } };
  if (cleaned.isActive) {
    const clash = await DepotPlantMapping.findOne({ plantName: cleaned.plantName, isActive: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean();
    if (clash) return { status: 409, body: { message: DUPLICATE_ACTIVE_MESSAGE, existing: { id: clash._id, depotId: clash.depotId } } };
  }
  return null;
}

/** POST /api/distribution/plant-mappings — Admin only. */
async function createMapping(req, res) {
  try {
    const { cleaned, errors } = mappingService.normalizeMappingInput(req.body || {});
    const problem = await validateForWrite(cleaned, errors);
    if (problem) return res.status(problem.status).json(problem.body);
    const mapping = await DepotPlantMapping.create(cleaned);
    res.status(201).json({ mapping });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: DUPLICATE_ACTIVE_MESSAGE });
    console.error("[depotPlantMappingController.createMapping]", err);
    res.status(500).json({ message: "Internal server error while creating the depot-plant mapping." });
  }
}

/** PUT /api/distribution/plant-mappings/:id — Admin only. Omitted fields keep their current value. */
async function updateMapping(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid mapping id." });
    const mapping = await DepotPlantMapping.findById(req.params.id);
    if (!mapping) return res.status(404).json({ message: "Depot-plant mapping not found." });

    const body = req.body || {};
    const merged = {
      depotId: body.depotId ?? mapping.depotId,
      plantName: body.plantName ?? mapping.plantName,
      isActive: body.isActive ?? mapping.isActive,
      effectiveFrom: body.effectiveFrom !== undefined ? body.effectiveFrom : mapping.effectiveFrom,
      notes: body.notes !== undefined ? body.notes : mapping.notes,
    };
    const { cleaned, errors } = mappingService.normalizeMappingInput(merged);
    const problem = await validateForWrite(cleaned, errors, mapping._id);
    if (problem) return res.status(problem.status).json(problem.body);

    Object.assign(mapping, cleaned);
    await mapping.save();
    res.json({ mapping });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: DUPLICATE_ACTIVE_MESSAGE });
    console.error("[depotPlantMappingController.updateMapping]", err);
    res.status(500).json({ message: "Internal server error while updating the depot-plant mapping." });
  }
}

/**
 * POST /api/distribution/plant-mappings/import — Admin only, multipart
 * 'file' + 'mode'. REPLACE only (the mapping is a complete configuration).
 *
 * Stricter than the other master imports by design: the WHOLE file is
 * validated first, and if any row fails nothing is written (no partial
 * mapping, no archive entry). An empty file is rejected rather than
 * wiping every mapping. On success the current mappings are archived to
 * Import History (restorable), then replaced.
 */
async function importMappings(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: "No file was uploaded." });
    const mode = String(req.body.mode || "").toUpperCase();
    if (mode !== "REPLACE") {
      return res.status(400).json({ message: "Depot-plant mapping import supports REPLACE mode only." });
    }

    let headers, rows;
    try {
      ({ headers, rows } = parseWorkbook(req.file.buffer));
    } catch (err) {
      return res.status(400).json({ message: err.message || "Could not read this file. Please check the format and try again." });
    }
    if (headers.length === 0) return res.status(400).json({ message: "Could not read any column headers from this file." });

    const { missing, headerToKey } = validateHeaders(headers, REQUIRED_HEADERS);
    if (missing.length > 0) {
      return res.status(422).json({ message: "Import failed: missing required columns.", missingRequiredColumns: missing });
    }
    Object.assign(headerToKey, validateHeaders(headers, OPTIONAL_HEADERS).headerToKey);
    if (rows.length === 0) return res.status(422).json({ message: "Import failed: the file has no mapping rows." });

    const refs = await mappingService.loadReferenceSets();
    const { validRows, errors } = mappingService.validateMappingSet(rows.map((r) => normalizeRow(r, headerToKey)), refs);
    if (errors.length > 0) {
      return res.status(422).json({
        message: "Import failed validation — no mappings were changed.",
        fileName: req.file.originalname,
        importType: mode,
        totalRecords: rows.length,
        addedCount: 0,
        updatedCount: 0,
        failedRecords: errors.length,
        errors: errors.slice(0, 200),
      });
    }

    const current = await DepotPlantMapping.find({}).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: current,
      fileName: req.file.originalname,
      importType: "REPLACE",
      importedBy: req.user.username,
      totalRows: rows.length,
      addedCount: validRows.length,
      failedCount: 0,
    });
    await DepotPlantMapping.deleteMany({});
    await DepotPlantMapping.insertMany(validRows);

    res.json({
      fileName: req.file.originalname,
      importType: mode,
      totalRecords: rows.length,
      addedCount: validRows.length,
      updatedCount: 0,
      failedRecords: 0,
      errors: [],
    });
  } catch (err) {
    console.error("[depotPlantMappingController.importMappings]", err);
    res.status(500).json({ message: "Internal server error while importing depot-plant mappings." });
  }
}

/** GET /api/distribution/plant-mappings/import-history — Admin only. */
async function getImportHistory(req, res) {
  try {
    const data = await DatasetHistory.find({ module: MODULE_KEY }).sort({ createdAt: -1 }).select("-snapshotData");
    res.json({ data });
  } catch (err) {
    console.error("[depotPlantMappingController.getImportHistory]", err);
    res.status(500).json({ message: "Internal server error while fetching import history." });
  }
}

/** POST /api/distribution/plant-mappings/import-history/:id/view — Admin only. Restores a snapshot (current set archived first). */
async function viewImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOne({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });

    const current = await DepotPlantMapping.find({}).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: current,
      fileName: `Snapshot before restoring ${entry.batchId}`,
      importType: "RESTORE",
      importedBy: req.user.username,
      totalRows: current.length,
    });
    await DepotPlantMapping.deleteMany({});
    if (entry.snapshotData.length > 0) await DepotPlantMapping.insertMany(entry.snapshotData);

    res.json({ message: `Restored ${entry.batchId} as the active depot-plant mapping.`, restoredCount: entry.snapshotData.length });
  } catch (err) {
    console.error("[depotPlantMappingController.viewImportHistory]", err);
    res.status(500).json({ message: "Internal server error while restoring this import." });
  }
}

module.exports = {
  listMappings,
  getMappingById,
  createMapping,
  updateMapping,
  importMappings,
  getImportHistory,
  viewImportHistory,
  REQUIRED_HEADERS,
  OPTIONAL_HEADERS,
};
