const { MATCH_FIELDS } = require("../models/Stock");

/**
 * Determines whether an imported Stock row matches an existing Stock
 * record. Deliberately isolated in its own function (Section 9's explicit
 * requirement) so the matching criteria can be changed in one place later
 * without touching the import controller.
 *
 * Current rule: PlantName + MatNo + StockDate + StorageLocation, all
 * exact matches. StockDate is compared by calendar day (not exact
 * timestamp) since Excel dates and typed dates can differ in time-of-day
 * precision even when they represent "the same day."
 */
function buildMatchQuery(row) {
  const query = {};
  MATCH_FIELDS.forEach((field) => {
    if (field === "StockDate") {
      const day = toDayBounds(row.StockDate);
      if (day) query.StockDate = { $gte: day.start, $lte: day.end };
      else query.StockDate = row.StockDate;
    } else {
      query[field] = row[field];
    }
  });
  return query;
}

function toDayBounds(dateValue) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

module.exports = { buildMatchQuery, MATCH_FIELDS };
