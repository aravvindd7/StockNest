const mongoose = require("mongoose");
const Depot = require("../models/Depot");
const DatasetHistory = require("../models/DatasetHistory");
const { parseWorkbook, validateHeaders, normalizeRow } = require("../utils/excelParser");
const { archiveSnapshot } = require("../utils/datasetHistoryHelper");

const MODULE_KEY = "depot";
const IMPORT_MODES = ["APPEND", "REPLACE"];

const REQUIRED_HEADERS = [
  { header: "Depot ID", key: "depotId" },
  { header: "Depot Name", key: "depotName" },
];

/** Duplicate Depot ID within the file is the only row-level error — see materialImportController.js for the parallel pattern. */
function validateDepotRow(rawRow, headerToKey, seenInFile) {
  const normalized = normalizeRow(rawRow, headerToKey);
  const errors = [];
  const depotId = String(normalized.depotId || "").trim().toUpperCase();
  const depotName = String(normalized.depotName || "").trim();

  if (!depotId) errors.push("Depot ID is required.");
  if (!depotName) errors.push("Depot Name is required.");

  if (depotId) {
    if (seenInFile.has(depotId)) errors.push("Duplicate Depot ID within this file.");
    seenInFile.add(depotId);
  }

  return { valid: errors.length === 0, errors, depotId, cleaned: { depotId, depotName } };
}

/**
 * POST /api/depots/import — Admin only, multipart 'file' + 'mode'.
 * Same Append/Replace/snapshot pattern as Material — see
 * materialImportController.js for the detailed design comments.
 */
async function importDepots(req, res) {
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
      const result = validateDepotRow(rawRow, headerToKey, seenInFile);
      const rowNumber = idx + 2;
      if (result.valid) validRows.push(result.cleaned);
      else errors.push({ row: rowNumber, depotId: result.depotId || "", error: result.errors.join(" ") });
    });

    let addedCount = 0;
    let updatedCount = 0;

    if (mode === "APPEND") {
      const currentActive = await Depot.find({}).lean();
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
        const existing = await Depot.findOne({ depotId: row.depotId });
        if (!existing) {
          // eslint-disable-next-line no-await-in-loop
          await Depot.create(row);
          addedCount += 1;
        } else {
          existing.depotName = row.depotName;
          // eslint-disable-next-line no-await-in-loop
          await existing.save();
          updatedCount += 1;
        }
      }
    } else {
      const currentActive = await Depot.find({}).lean();
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

      await Depot.deleteMany({});
      if (validRows.length > 0) {
        await Depot.insertMany(validRows);
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
    console.error("[depotImportController.importDepots]", err);
    res.status(500).json({ message: "Internal server error while importing depots." });
  }
}

async function getImportHistory(req, res) {
  try {
    const data = await DatasetHistory.find({ module: MODULE_KEY }).sort({ createdAt: -1 }).select("-snapshotData");
    res.json({ data });
  } catch (err) {
    console.error("[depotImportController.getImportHistory]", err);
    res.status(500).json({ message: "Internal server error while fetching import history." });
  }
}

async function viewImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOne({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });

    const currentActive = await Depot.find({}).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: currentActive,
      fileName: `Snapshot before restoring ${entry.batchId}`,
      importType: "RESTORE",
      importedBy: req.user.username,
      totalRows: currentActive.length,
    });

    await Depot.deleteMany({});
    if (entry.snapshotData.length > 0) {
      await Depot.insertMany(entry.snapshotData);
    }

    res.json({ message: `Restored ${entry.batchId} as the active Depot Master.`, restoredCount: entry.snapshotData.length });
  } catch (err) {
    console.error("[depotImportController.viewImportHistory]", err);
    res.status(500).json({ message: "Internal server error while restoring this import." });
  }
}

async function removeImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOneAndDelete({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });
    res.json({ message: "Import history entry removed.", batchId: entry.batchId });
  } catch (err) {
    console.error("[depotImportController.removeImportHistory]", err);
    res.status(500).json({ message: "Internal server error while removing this import history entry." });
  }
}

module.exports = { importDepots, getImportHistory, viewImportHistory, removeImportHistory };
