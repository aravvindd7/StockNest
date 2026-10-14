const mongoose = require("mongoose");

/**
 * Atomic counters for Distribution (Stage 4).
 *
 *   _id "transferId"            → sequence behind TRF-000001, TRF-000002, …
 *                                 ($inc in the same transaction as the transfer
 *                                 insert, so an aborted transfer never burns an ID
 *                                 and two requests can never get the same one —
 *                                 never derived from countDocuments()).
 *   _id "commit:<MAT>|<DEPOT>"  → per material + source depot lock. Every action
 *                                 that changes what is committed against a
 *                                 source's stock touches it inside its
 *                                 transaction, so concurrent commitments for the
 *                                 same stock conflict and are serialized instead
 *                                 of both passing the availability check.
 */
const distributionCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, collection: "distributioncounters" }
);

module.exports = mongoose.model("DistributionCounter", distributionCounterSchema);
