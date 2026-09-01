const XLSX = require("xlsx");

/**
 * Builds a real .xlsx file buffer (not CSV) from an ordered column list
 * and an array of plain row objects. Shared by Material/Depot/Stock export.
 *
 * columns: [{ key, label }] — controls both column order and header text.
 */
function buildXlsxBuffer(columns, rows) {
  const headerRow = columns.map((c) => c.label);
  const dataRows = rows.map((row) => columns.map((c) => formatCell(row[c.key])));

  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function formatCell(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === undefined || value === null) return "";
  return value;
}

module.exports = { buildXlsxBuffer };
