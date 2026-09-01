const mongoose = require("mongoose");
const Sales = require("../models/Sales");
const { SALES_COLUMNS, USER_EDITABLE_KEYS } = require("../models/Sales");
const Material = require("../models/Material");
const DatasetHistory = require("../models/DatasetHistory");
const { parseWorkbook, validateHeaders, normalizeRow } = require("../utils/excelParser");
const { archiveSnapshot } = require("../utils/datasetHistoryHelper");
const { buildMatchQuery } = require("../utils/salesMatcher");
const { deriveQuarter, derivePeriod, isValidMonth, isValidFinancialYear } = require("../utils/financialYear");

const MODULE_KEY = "sales";
const IMPORT_MODES = ["APPEND", "REPLACE"];

// Quarter and Period are excluded from the expected headers — neither is
// ever read from the file, both derived (Quarter from Month, Period from
// Financial Year + Month). An uploaded file may contain those columns; if
// so they're simply ignored, since headerToKey only maps columns we ask for.
const REQUIRED_HEADERS = SALES_COLUMNS.filter((c) => USER_EDITABLE_KEYS.includes(c.key)).map((c) => ({
  header: c.label,
  key: c.key,
}));

/**
 * Validates one raw row (Phase 1 Section 2's rules):
 *   - Material Number must exist in Material Master
 *   - Financial Year must match "YYYY-YY"
 *   - Month must be a recognized month name
 *   - Quarter is derived automatically — never read from the file
 *   - Numeric fields (Sales EA/Qty/CV, Net Sales) must be numeric
 *   - Duplicate Material + Financial Year + Month + Plant within the same
 *     file is rejected (ambiguous which row should win)
 */
function validateSalesRow(rawRow, headerToKey, validMaterialNos, seenInFile) {
  const normalized = normalizeRow(rawRow, headerToKey);
  const errors = [];

  const matNo = String(normalized.MatNo || "").trim().toUpperCase();
  const materialName = String(normalized.Material || "").trim();
  const plant = String(normalized.Plant || "").trim();
  const financialYear = String(normalized.FinancialYear || "").trim();
  const month = String(normalized.Month || "").trim();

  if (!matNo) errors.push("Material Number is required.");
  else if (!validMaterialNos.has(matNo)) errors.push(`Material Number "${matNo}" does not exist in Material Master.`);

  if (!materialName) errors.push("Material Name is required.");
  if (!plant) errors.push("Plant is required.");

  if (!isValidFinancialYear(financialYear)) errors.push('Financial Year must be in "YYYY-YY" format, e.g. "2025-26".');

  if (!month) errors.push("Month is required.");
  else if (!isValidMonth(month)) errors.push(`"${month}" is not a recognized month name.`);

  ["SalesEA", "SalesQty", "SalesCV", "NetSales"].forEach((field) => {
    const raw = normalized[field];
    if (raw !== undefined && raw !== "" && Number.isNaN(Number(raw))) {
      errors.push(`${field} must be numeric.`);
    }
  });

  const matchKey = `${matNo} / ${financialYear} / ${month} / ${plant}`;
  if (matNo && financialYear && month && plant) {
    if (seenInFile.has(matchKey)) errors.push("Duplicate Material + Financial Year + Month + Plant within this file.");
    seenInFile.add(matchKey);
  }

  const cleaned = {};
  SALES_COLUMNS.forEach(({ key, type }) => {
    if (key === "MatNo") {
      cleaned[key] = matNo;
      return;
    }
    if (key === "Quarter") {
      cleaned[key] = deriveQuarter(month);
      return;
    }
    if (key === "Period") {
      cleaned[key] = derivePeriod(financialYear, month);
      return;
    }
    const raw = normalized[key];
    if (type === "Number") cleaned[key] = raw === undefined || raw === "" ? 0 : Number(raw) || 0;
    else cleaned[key] = raw === undefined || raw === null ? "" : String(raw).trim();
  });

  return { valid: errors.length === 0, errors, matchKey, cleaned };
}

/**
 * POST /api/sales/import — Admin only, multipart 'file' + 'mode'.
 * Same Append/Replace/snapshot pattern as Material/Depot/Stock, untouched
 * by the Phase 1 schema upgrade — only row validation and the matching
 * key changed (see utils/salesMatcher.js).
 */
async function importSales(req, res) {
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
    const seenInFile = new Set();

    rows.forEach((rawRow, idx) => {
      const result = validateSalesRow(rawRow, headerToKey, validMaterialNos, seenInFile);
      const rowNumber = idx + 2;
      if (result.valid) validRows.push(result.cleaned);
      else errors.push({ row: rowNumber, materialNo: result.matchKey, error: result.errors.join(" ") });
    });

    let addedCount = 0;
    let updatedCount = 0;

    if (mode === "APPEND") {
      const currentActive = await Sales.find({}).lean();
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
        const existing = await Sales.findOne(buildMatchQuery(row));
        if (!existing) {
          // eslint-disable-next-line no-await-in-loop
          await Sales.create(row);
          addedCount += 1;
        } else {
          Object.assign(existing, row);
          // eslint-disable-next-line no-await-in-loop
          await existing.save();
          updatedCount += 1;
        }
      }
    } else {
      const currentActive = await Sales.find({}).lean();
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

      await Sales.deleteMany({});
      if (validRows.length > 0) {
        await Sales.insertMany(validRows);
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
    console.error("[salesImportController.importSales]", err);
    res.status(500).json({ message: "Internal server error while importing sales records." });
  }
}

async function getImportHistory(req, res) {
  try {
    const data = await DatasetHistory.find({ module: MODULE_KEY }).sort({ createdAt: -1 }).select("-snapshotData");
    res.json({ data });
  } catch (err) {
    console.error("[salesImportController.getImportHistory]", err);
    res.status(500).json({ message: "Internal server error while fetching import history." });
  }
}

async function viewImportHistory(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid history id." });
    const entry = await DatasetHistory.findOne({ _id: req.params.id, module: MODULE_KEY });
    if (!entry) return res.status(404).json({ message: "Import history entry not found." });

    const currentActive = await Sales.find({}).lean();
    await archiveSnapshot({
      moduleKey: MODULE_KEY,
      activeRecords: currentActive,
      fileName: `Snapshot before restoring ${entry.batchId}`,
      importType: "RESTORE",
      importedBy: req.user.username,
      totalRows: currentActive.length,
    });

    await Sales.deleteMany({});
    if (entry.snapshotData.length > 0) {
      await Sales.insertMany(entry.snapshotData);
    }

    res.json({ message: `Restored ${entry.batchId} as the active Sales Master.`, restoredCount: entry.snapshotData.length });
  } catch (err) {
    console.error("[salesImportController.viewImportHistory]", err);
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
    console.error("[salesImportController.removeImportHistory]", err);
    res.status(500).json({ message: "Internal server error while removing this import history entry." });
  }
}

module.exports = { importSales, getImportHistory, viewImportHistory, removeImportHistory };
