const mongoose = require("mongoose");

/**
 * DerivedDataState — the small bookkeeping store that keeps StockNest's derived
 * intelligence (forecast → recommendations) traceable to the source data it
 * was computed from. A handful of documents, keyed by _id:
 *
 *   "sources"       versions.<source> — a counter bumped once per successful
 *                   source-data operation (one import = one bump), and
 *                   changedAt.<source>.
 *   "forecast"      version (one per successful forecast generation) and
 *                   basedOn { sales, window } — the Sales version and rolling
 *                   window it was generated from; status / failure bookkeeping.
 *   "distribution"  version (one per successful recommendation run) and
 *                   basedOn { stock, materials, depots, depotPlantMapping,
 *                   depotSafetyStock, transfers, forecast }; generationRunId.
 *   "lease"         { owner, until } — one pipeline runner at a time.
 *
 * Derived data is "stale" when its basedOn differs from the current versions.
 * Nothing here is business data; deleting the collection only makes the next
 * start re-adopt the current results as the baseline.
 */
const derivedDataStateSchema = new mongoose.Schema({ _id: { type: String, required: true } }, { strict: false, timestamps: true, minimize: false });

module.exports = mongoose.model("DerivedDataState", derivedDataStateSchema, "deriveddatastates");
