const mongoose = require("mongoose");

/**
 * Read-only access to the derived-data bookkeeping for request handlers
 * (Planning). Returns null when there is no database connection or no record
 * yet, so callers degrade to "unknown" instead of failing.
 */
async function readForecastState() {
  if (mongoose.connection.readyState !== 1) return null;
  const DerivedDataState = require("../models/DerivedDataState");
  return DerivedDataState.findById("forecast").select("version lastSuccessAt").lean();
}

module.exports = { readForecastState };
