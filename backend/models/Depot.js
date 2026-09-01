const mongoose = require("mongoose");

/**
 * Depot Master — intentionally limited to exactly two user-facing fields
 * (depotId, depotName), matching the scope of this initial implementation.
 * Do not add address/city/state/manager/capacity/status/region/etc. back
 * onto this model; that's a deliberate future decision, not something to
 * slip back in incrementally.
 *
 * depotId follows the same trim+uppercase convention as Material.materialNo
 * for consistency with the rest of the project, and is enforced unique at
 * the MongoDB level (not just in application code or the frontend).
 *
 * This model has NO relationship to Material or Inventory yet — that
 * integration is deliberately deferred to a future change.
 */
const depotSchema = new mongoose.Schema(
  {
    depotId: { type: String, required: true, unique: true, trim: true, uppercase: true },
    depotName: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Depot", depotSchema);
