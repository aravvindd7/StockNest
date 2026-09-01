const mongoose = require("mongoose");

const STATUS_VALUES = ["STD", "Discontinued"];
const TYPE_VALUES = ["FG", "RM"];

/**
 * Material Master schema — intentionally limited to exactly the seven
 * business fields the spec calls for. Do not add category, brand,
 * supplier, unit of measure, reorder level, etc. back onto this model;
 * if a future requirement needs them, that's a deliberate schema change,
 * not something to slip back in incrementally.
 *
 * `isActive` is not a user-entered field — it backs the existing soft-delete
 * behavior (Section 16) and is never shown on the Add/Edit forms. It also
 * backs the Import "REPLACE" mode: replacing the active dataset soft-
 * deactivates the previous set (isActive:false) rather than deleting it,
 * which is how that dataset stays available as a historical record.
 *
 * materialNo is unique only among ACTIVE materials (a partial index, not a
 * plain unique index) — otherwise a soft-deleted/replaced material would
 * permanently block ever reusing its Material No, which defeats the point
 * of soft-deleting instead of hard-deleting.
 */
const materialSchema = new mongoose.Schema(
  {
    materialNo: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, required: true, trim: true },
    model: { type: String, trim: true },
    status: { type: String, enum: STATUS_VALUES, required: true, default: "STD" },
    invCost: { type: Number, required: true, min: 0 },
    moq: { type: Number, required: true, min: 1 },
    type: { type: String, enum: TYPE_VALUES, required: true },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

materialSchema.index({ materialNo: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
materialSchema.index({ materialNo: "text", description: "text", model: "text" });
materialSchema.index({ status: 1 });
materialSchema.index({ type: 1 });

module.exports = mongoose.model("Material", materialSchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
module.exports.TYPE_VALUES = TYPE_VALUES;
