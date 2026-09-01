const mongoose = require("mongoose");
const Material = require("../models/Material");
const DatasetHistory = require("../models/DatasetHistory");
const { parseWorkbook, validateHeaders, normalizeRow } = require("../utils/excelParser");
const { archiveSnapshot } = require("../utils/datasetHistoryHelper");
const { STATUS_VALUES, TYPE_VALUES } = require("../models/Material");

const MODULE_KEY = "material";
const IMPORT_MODES = ["APPEND", "REPLACE"];

const REQUIRED_HEADERS = [
  { header: "Material No", key: "materialNo" },
  { header: "Description", key: "description" },
  { header: "Model", key: "model" },
  { header: "STD/Discontinued", key: "status" },
  { header: "Inv Cost", key: "invCost" },
  { header: "MOQ", key: "moq" },
  { header: "FG/RM", key: "type" },
];

/**
 * Validates one raw row. An existing Material No is NOT an error here —
 * both APPEND (updates it) and REPLACE (the active set is fresh anyway)
 * handle that constructively. Only a duplicate Material No *within this
 * file* is invalid, since it's ambiguous which row should win.
 */
function validateMaterialRow(rawRow, headerToKey, seenInFile) {
  const normalized = normalizeRow(rawRow, headerToKey);
  const errors = [];
  const materialNo = String(normalized.materialNo || "").trim().toUpperCase();

  if (!materialNo) errors.push("Material No is required.");
  if (!String(normalized.description || "").trim()) errors.push("Description is required.");

  const status = String(normalized.status || "").trim();
  if (!status) errors.push("STD/Discontinued status is required.");
  else if (!STATUS_VALUES.includes(status)) errors.push(`Status must be one of: ${STATUS_VALUES.join(", ")}.`);

  const type = String(normalized.type || "").trim().toUpperCase();
  if (!type) errors.push("FG/RM is required.");
  else if (!TYPE_VALUES.includes(type)) errors.push(`FG/RM must be one of: ${TYPE_VALUES.join(", ")}.`);

  const invCost = Number(normalized.invCost);
  if (normalized.invCost === undefined || normalized.invCost === "" || Number.isNaN(invCost)) {
    errors.push("Inv Cost must be numeric.");
  } else if (invCost < 0) {
    errors.push("Inv Cost cannot be negative.");
  }

  const moq = Number(normalized.moq);
  if (normalized.moq === undefined || normalized.moq === "" || Number.isNaN(moq) || moq <= 0) {
    errors.push("MOQ must be a positive number.");
  }

  if (materialNo) {
    if (seenInFile.has(materialNo)) errors.push("Duplicate Material No within this file.");
    seenInFile.add(materialNo);
  }

  const cleaned = {
    materialNo,
    description: String(normalized.description || "").trim(),
    model: String(normalized.model || "").trim(),
    status: STATUS_VALUES.includes(status) ? status : undefined,
    invCost: Number.isFinite(invCost) ? invCost : undefined,
    moq: Number.isFinite(moq) && moq > 0 ? moq : undefined,
    type: TYPE_VALUES.includes(type) ? type : undefined,
  };

  return { valid: errors.length === 0, errors, materialNo, cleaned };
}

/**
 * POST /api/materials/import — Admin only, multipart 'file' + 'mode'.
 *
 * Both modes archive the CURRENT active set as a history snapshot first
 * (see utils/datasetHistoryHelper.js), so every import is inherently
 * recoverable via Import History's "View" action, without needing
 * separate per-row change tracking.
 *
 * APPEND: upserts by materialNo among active materials.
 * REPLACE: hard-deletes the current active set (already preserved in the
 * snapshot taken a moment earlier) and inserts the file as the fresh
 * active set.
 */
async function importMaterials(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: "No file was uploaded." });

    const mode = String(req.body.mode || "").toUpperCase();
    if (!IMPORT_MODES.includes(mode)) {
      return res.status(400).json({ message: "Import mode must be APPEND or REPLACE." });
    }

    let headers, rows;
    try {
      ({ headers, rows } = parseWorkbook(req.file.buffer));
    } catch (err) {
      return res.status(400).json({ message: err.message || "Could not read this file. Please check the format and try again." });
    }
    if (headers.length === 0) {
      return res.status(400).json({ message: "Could not read any column headers from this file." });
    }

    const { missing, headerToKey } = validateHeaders(headers, REQUIRED_HEADERS);
    if (missing.length > 0) {
      return res.status(422).json({ message: "Import failed: missing required columns.", missingRequiredColumns: missing });
    }

    const seenInFile = new Set();
    const errors = [];
    const validRows = [];

    rows.forEach((rawRow, idx) => {
      const result = validateMaterialRow(rawRow, headerToKey, seenInFile);
      const rowNumber = idx + 2;
      if (result.valid) validRows.push(result.cleaned);
      else errors.push({ row: rowNumber, materialNo: result.materialNo || "", error: result.errors.join(" ") });
    });

    let addedCount = 0;
    let updatedCount = 0;

    if (mode === "APPEND") {
      const currentActive = await Material.find({ isActive: true }).lean();
      await archiveSnapshot({
        moduleKey: MODULE_KEY,
        activeRecords: currentActive,
        fileName: req.file.originalname,
        importType: "APPEND",
        importedBy: req.user.username,
        totalRows: rows.length,
        failedCount: errors.length,
      });

      for (const row of validRows) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await Material.findOne({ materialNo: row.materialNo, isActive: true });
        if (!existing) {
          // eslint-disable-next-line no-await-in-loop
          await Material.create(row);
          addedCount += 1;
        } else {
          existing.description = row.description;
          existing.model = row.model;
          existing.status = row.status;
          existing.invCost = row.invCost;
          existing.moq = row.moq;
          existing.type = row.type;
          // eslint-disable-next-line no-await-in-loop
          await existing.save();
          updatedCount += 1;
        }
      }
    } else {
      const currentActive = await Material.find({ isActive: true }).lean();
      await archiveSnapshot({
        moduleKey: MODULE_KEY,
        activeRecords: currentActive,
        fileName: req.file.originalname,
        importType: "REPLACE",
        importedBy: req.user.username,
        totalRows: rows.length,
        addedCount: validRows.length,
        failedCount: errors.length,
      });

      await Material.deleteMany({ isActive: true });
      if (validRows.length > 0) {
        await Material.insertMany(validRows.map((r) => ({ ...r, isActive: true })));
      }
      addedCount = validRows.length;
    }

    res.json({
      fileName: req.file.originalname,
      importType: mode,
      totalRecords: rows.length,
      addedCount,
      updatedCount,
      failedRecords: errors.length,
      errors: errors.slice(0, 200),
    });
  } catch (err) {
    console.error("[materialImportController.importMaterials]", err);
    res.status(500).json({ message: "Internal server error while importing materials." });
  }
}

/** GET /api/materials/import-history — Admin only. */
async function getImportHistory(req, res) {
  try {
    const data = await DatasetHistory.find({ module: MODULE_KEY }).sort({ createdAt: -1 }).select("-snapshotData");
    res.json({ data });
  } catch (err) {
    console.error("[materialImportController.getImportHistory]", err);
    res.status(500).json({ message: "Internal server error while fetching import history." });
  }
}

/**
 * POST /api/materials/import-history/:id/view — Admin only.
 * Restores a historical snapshot as the active Material Master. The
 * current active set is archived first, so this is always reversible by
 * viewing that new entry afterward.
 */
async function viewImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOne({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });

    const currentActive = await Material.find({ isActive: true }).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: currentActive,
      fileName: `Snapshot before restoring ${entry.batchId}`,
      importType: "RESTORE",
      importedBy: req.user.username,
      totalRows: currentActive.length,
    });

    await Material.deleteMany({ isActive: true });
    if (entry.snapshotData.length > 0) {
      await Material.insertMany(entry.snapshotData.map((d) => ({ ...d, isActive: true })));
    }

    res.json({ message: `Restored ${entry.batchId} as the active Material Master.`, restoredCount: entry.snapshotData.length });
  } catch (err) {
    console.error("[materialImportController.viewImportHistory]", err);
    res.status(500).json({ message: "Internal server error while restoring this import." });
  }
}

/**
 * DELETE /api/materials/import-history/:id — Admin only.
 * Removes a historical snapshot. This can never affect the active
 * dataset — history entries are archived copies, not the live data.
 */
async function removeImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOneAndDelete({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });
    res.json({ message: "Import history entry removed.", batchId: entry.batchId });
  } catch (err) {
    console.error("[materialImportController.removeImportHistory]", err);
    res.status(500).json({ message: "Internal server error while removing this import history entry." });
  }
}

module.exports = { importMaterials, getImportHistory, viewImportHistory, removeImportHistory };
