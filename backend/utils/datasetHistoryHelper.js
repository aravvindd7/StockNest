const DatasetHistory = require("../models/DatasetHistory");

const MODULE_PREFIX = { material: "MAT", depot: "DEP", stock: "STK", sales: "SAL" };

/** Strips Mongo/Mongoose bookkeeping fields so a snapshot holds only business data. */
function stripInternalFields(doc) {
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

async function nextBatchId(moduleKey) {
  const prefix = MODULE_PREFIX[moduleKey];
  const count = await DatasetHistory.countDocuments({ module: moduleKey });
  return `${prefix}-IMP-${String(count + 1).padStart(4, "0")}`;
}

/**
 * Snapshots the given active records and saves them as a new history
 * entry BEFORE an operation changes the live collection. This is the one
 * function every Append/Replace/Restore flow calls first.
 */
async function archiveSnapshot({
  moduleKey,
  activeRecords,
  fileName,
  importType,
  importedBy,
  totalRows = 0,
  addedCount = 0,
  updatedCount = 0,
  failedCount = 0,
}) {
  const batchId = await nextBatchId(moduleKey);
  const snapshotData = activeRecords.map(stripInternalFields);
  return DatasetHistory.create({
    module: moduleKey,
    batchId,
    fileName,
    importType,
    importedBy,
    snapshotData,
    recordCount: snapshotData.length,
    totalRows,
    addedCount,
    updatedCount,
    failedCount,
  });
}

module.exports = { stripInternalFields, nextBatchId, archiveSnapshot };
