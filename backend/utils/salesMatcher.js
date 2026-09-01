const { MATCH_FIELDS } = require("../models/Sales");

/**
 * Determines whether an imported Sales row matches an existing Sales
 * record. Mirrors utils/stockMatcher.js's pattern — isolated in its own
 * function so the matching criteria can be changed in one place later.
 *
 * PHASE 1 UPDATE: the matching key changed from the old 6-field
 * (MatNo+Plant+Period+Qtr+Year+PC) to Material + Financial Year + Month +
 * Plant, since Sales Master is now monthly-grain — a record is now
 * uniquely identified by which calendar month it represents, not which
 * quarter (Quarter is derived from Month, never part of the identity).
 */
function buildMatchQuery(row) {
  const query = {};
  MATCH_FIELDS.forEach((field) => {
    query[field] = row[field];
  });
  return query;
}

module.exports = { buildMatchQuery, MATCH_FIELDS };
