const mongoose = require("mongoose");

const MODULES = ["material", "depot", "stock", "sales"];
const IMPORT_TYPES = ["INITIAL", "APPEND", "REPLACE", "RESTORE"];

/**
 * Shared, reusable Import History / snapshot store for Material, Depot,
 * and Stock Master (distinguished by `module`). One document = one
 * archived snapshot of that module's ENTIRE active dataset, taken
 * immediately before an operation changed it.
 *
 * Design: the live collection (Material/Depot/Stock) is always the single
 * source of truth for "what's active" — history entries are just archived
 * copies, never the live data itself. That's what makes "Remove" safe by
 * construction: deleting a history entry only removes a recoverable past
 * copy, it can never delete the currently-active dataset, because the
 * active dataset was never represented as a history entry to begin with.
 *
 * Every Append/Replace/Restore operation follows the same shape:
 *   1. Snapshot the current active set -> new DatasetHistory doc (this).
 *   2. Apply the change to the live collection.
 * "View" (restore) on an old entry does the same in reverse: snapshot the
 * current active set as a new RESTORE entry, then copy the target entry's
 * snapshotData back into the live collection.
 */
const datasetHistorySchema = new mongoose.Schema(
  {
    module: { type: String, enum: MODULES, required: true },
    batchId: { type: String, required: true, unique: true }, // e.g. "MAT-IMP-0001", "DEP-IMP-0002", "STK-IMP-0003"
    fileName: { type: String, required: true },
    importType: { type: String, enum: IMPORT_TYPES, required: true },
    importedBy: { type: String, required: true },
    snapshotData: { type: [mongoose.Schema.Types.Mixed], default: [] },
    recordCount: { type: Number, default: 0 }, // size of the snapshot (the active set just before this op)
    totalRows: { type: Number, default: 0 }, // rows in the uploaded file (APPEND/REPLACE); records restored (RESTORE)
    addedCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
  },
  { timestamps: true } // createdAt doubles as "Import Date"
);

datasetHistorySchema.index({ module: 1, createdAt: -1 });

module.exports = mongoose.model("DatasetHistory", datasetHistorySchema);
module.exports.MODULES = MODULES;
module.exports.IMPORT_TYPES = IMPORT_TYPES;
