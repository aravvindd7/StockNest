const XLSX = require("xlsx");

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Reads an uploaded workbook buffer and returns its headers + raw rows. */
function parseWorkbook(buffer) {
  // cellDates:true makes date-formatted cells come back as real JS Date
  // objects (needed for Stock Master's StockDate/createdOn) instead of
  // raw Excel serial numbers. Row values otherwise stay raw/numeric
  // (not `raw:false`), since formatting numbers as display strings would
  // break Number() parsing on numeric columns like Inv Cost/MOQ/TotalStock.
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");

  const sheet = workbook.Sheets[sheetName];
  const headerRow = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })[0] || [];
  const headers = headerRow.map((h) => String(h).trim()).filter(Boolean);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return { headers, rows };
}

/**
 * Generic required-header check, shared by Material/Depot/Stock imports.
 * requiredHeaders: [{ header: "Display Name", key: "internalFieldKey" }]
 * Matches by normalized name (trimmed, case/space-insensitive) so minor
 * formatting differences in the source file don't cause a false failure.
 * Returns { missing: string[], headerToKey: { [originalHeaderText]: key } }.
 */
function validateHeaders(headers, requiredHeaders) {
  const normalizedToOriginal = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const headerToKey = {};
  const missing = [];

  requiredHeaders.forEach(({ header, key }) => {
    const original = normalizedToOriginal.get(normalizeHeader(header));
    if (!original) {
      missing.push(header);
    } else {
      headerToKey[original] = key;
    }
  });

  return { missing, headerToKey };
}

/** Applies a headerToKey map to one raw row, returning { [key]: rawValue }. */
function normalizeRow(rawRow, headerToKey) {
  const normalized = {};
  Object.entries(headerToKey).forEach(([header, key]) => {
    normalized[key] = rawRow[header];
  });
  return normalized;
}

module.exports = { parseWorkbook, validateHeaders, normalizeRow, normalizeHeader };
