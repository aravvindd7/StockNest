const mongoose = require("mongoose");
const Stock = require("../models/Stock");
const { STOCK_COLUMNS } = require("../models/Stock");
const Material = require("../models/Material");
const DatasetHistory = require("../models/DatasetHistory");
const { parseWorkbook, validateHeaders, normalizeRow } = require("../utils/excelParser");
const { archiveSnapshot } = require("../utils/datasetHistoryHelper");
const { buildMatchQuery } = require("../utils/stockMatcher");

const MODULE_KEY = "stock";
const IMPORT_MODES = ["APPEND", "REPLACE"];

// Stock's Excel headers are the same 43 field names as the model/table
// (Section 8: "the imported Excel file should directly follow the
// 43-column Stock Master structure").
const REQUIRED_HEADERS = STOCK_COLUMNS.map((c) => ({ header: c.label, key: c.key }));

/**
 * Validates one raw row. PlantName/MatNo/StockDate/StorageLocation are
 * required (they're also the matching key — Section 9); every other
 * field is optional and defaults sensibly. MatNo must also reference a
 * material that already exists in Material Master — Stock/Sales must
 * never invent new materials on import (data-consistency requirement:
 * every module references the same Material Master, which is the single
 * source of truth). There is no "duplicate within file" rejection here,
 * unlike Material/Depot — if the same file lists the same Plant/Mat/Date/
 * Location combination twice, the second row is expected to simply
 * overwrite the first when applied, which is reasonable default behavior
 * for a corrections-style stock feed rather than an error.
 */
function validateStockRow(rawRow, headerToKey, validMaterialNos) {
  const normalized = normalizeRow(rawRow, headerToKey);
  const errors = [];

  const plantName = String(normalized.PlantName || "").trim();
  const matNo = String(normalized.MatNo || "").trim().toUpperCase();
  const storageLocation = String(normalized.StorageLocation || "").trim();
  const stockDateRaw = normalized.StockDate;

  if (!plantName) errors.push("PlantName is required.");
  if (!matNo) errors.push("MatNo is required.");
  else if (!validMaterialNos.has(matNo)) errors.push(`MatNo "${matNo}" does not exist in Material Master.`);
  if (!storageLocation) errors.push("StorageLocation is required.");

  let stockDate = null;
  if (!stockDateRaw && stockDateRaw !== 0) {
    errors.push("StockDate is required.");
  } else {
    stockDate = stockDateRaw instanceof Date ? stockDateRaw : new Date(stockDateRaw);
    if (Number.isNaN(stockDate.getTime())) {
      errors.push("StockDate must be a valid date.");
      stockDate = null;
    }
  }

  const cleaned = {};
  STOCK_COLUMNS.forEach(({ key, type }) => {
    if (key === "StockDate") {
      cleaned[key] = stockDate;
      return;
    }
    if (key === "MatNo") {
      cleaned[key] = matNo;
      return;
    }
    const raw = normalized[key];
    if (type === "Number") cleaned[key] = raw === undefined || raw === "" ? 0 : Number(raw) || 0;
    else if (type === "Date") cleaned[key] = raw ? new Date(raw) : undefined;
    else cleaned[key] = raw === undefined || raw === null ? "" : String(raw).trim();
  });

  return {
    valid: errors.length === 0,
    errors,
    matchKey: `${plantName} / ${matNo} / ${storageLocation}`,
    cleaned,
  };
}

/**
 * POST /api/stock/import — Admin only, multipart 'file' + 'mode'.
 * Same Append/Replace/snapshot pattern as Material/Depot. Append uses the
 * isolated matching function (utils/stockMatcher.js) to decide add vs
 * update per row, per Section 9.
 */
async function importStock(req, res) {
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

    const validMaterialNos = new Set(
      (await Material.find({ isActive: true }).select("materialNo").lean()).map((m) => m.materialNo)
    );

    const errors = [];
    const validRows = [];

    rows.forEach((rawRow, idx) => {
      const result = validateStockRow(rawRow, headerToKey, validMaterialNos);
      const rowNumber = idx + 2;
      if (result.valid) validRows.push(result.cleaned);
      else errors.push({ row: rowNumber, materialNo: result.matchKey, error: result.errors.join(" ") });
    });

    let addedCount = 0;
    let updatedCount = 0;

    if (mode === "APPEND") {
      const currentActive = await Stock.find({}).lean();
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
        const existing = await Stock.findOne(buildMatchQuery(row));
        if (!existing) {
          // eslint-disable-next-line no-await-in-loop
          await Stock.create(row);
          addedCount += 1;
        } else {
          Object.assign(existing, row);
          // eslint-disable-next-line no-await-in-loop
          await existing.save();
          updatedCount += 1;
        }
      }
    } else {
      const currentActive = await Stock.find({}).lean();
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

      await Stock.deleteMany({});
      if (validRows.length > 0) {
        await Stock.insertMany(validRows);
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
    console.error("[stockImportController.importStock]", err);
    res.status(500).json({ message: "Internal server error while importing stock records." });
  }
}

async function getImportHistory(req, res) {
  try {
    const data = await DatasetHistory.find({ module: MODULE_KEY }).sort({ createdAt: -1 }).select("-snapshotData");
    res.json({ data });
  } catch (err) {
    console.error("[stockImportController.getImportHistory]", err);
    res.status(500).json({ message: "Internal server error while fetching import history." });
  }
}

async function viewImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOne({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });

    const currentActive = await Stock.find({}).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: currentActive,
      fileName: `Snapshot before restoring ${entry.batchId}`,
      importType: "RESTORE",
      importedBy: req.user.username,
      totalRows: currentActive.length,
    });

    await Stock.deleteMany({});
    if (entry.snapshotData.length > 0) {
      await Stock.insertMany(entry.snapshotData);
    }

    res.json({ message: `Restored ${entry.batchId} as the active Stock Master.`, restoredCount: entry.snapshotData.length });
  } catch (err) {
    console.error("[stockImportController.viewImportHistory]", err);
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
    console.error("[stockImportController.removeImportHistory]", err);
    res.status(500).json({ message: "Internal server error while removing this import history entry." });
  }
}

module.exports = { importStock, getImportHistory, viewImportHistory, removeImportHistory };
