/**
 * Distribution integrity guards used by existing master modules (Stage 4).
 *
 * 1. Stock Master import/restore vs active movements. Once Distribution has
 *    moved stock (DISPATCHED / IN_TRANSIT), Stock Master holds that movement:
 *    the source's SIH was reduced and the destination's SIT increased. A Stock
 *    REPLACE or Import-History restore would silently undo it, and an APPEND
 *    of a row for the same material + plant would overwrite it — so those are
 *    refused with 409 until the transfers are received. (Planned REQUESTED /
 *    APPROVED transfers have moved nothing and do not block.)
 *
 * 2. Depot ID integrity. Depot Master has no deactivation flag (it is locked
 *    to depotId + depotName), so following its own documented convention
 *    ("add a check here that blocks deletion of a depot still in use") a
 *    depot referenced by Distribution can be renamed but its depotId can no
 *    longer change and it cannot be deleted or dropped by a REPLACE import.
 */
const DistributionTransfer = require("../models/DistributionTransfer");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DepotPlantMapping = require("../models/DepotPlantMapping");

const ACTIVE_MOVEMENT_STATUSES = ["DISPATCHED", "IN_TRANSIT"];
const norm = (v) => String(v || "").trim().toUpperCase();

async function activeMovementTransfers() {
  return DistributionTransfer.find({ status: { $in: ACTIVE_MOVEMENT_STATUSES } })
    .select("transferId status materialNo sourceDepotId destinationDepotId sourcePlantName destinationPlantName")
    .lean();
}

/**
 * Active transfers a Stock write would conflict with.
 * @param {"REPLACE"|"RESTORE"|"APPEND"} mode
 * @param {Array<{MatNo, PlantName}>} rows  rows the operation would write (APPEND only)
 */
async function findStockImportConflicts(mode, rows = []) {
  const active = await activeMovementTransfers();
  if (!active.length || mode !== "APPEND") return active;
  const touched = new Set(rows.map((r) => `${norm(r.MatNo)}|${String(r.PlantName || "").trim()}`));
  return active.filter((t) => touched.has(`${t.materialNo}|${t.sourcePlantName}`) || touched.has(`${t.materialNo}|${t.destinationPlantName}`));
}

function stockImportBlockedBody(conflicts, operation) {
  return {
    message: `${operation} is blocked: ${conflicts.length} Distribution transfer(s) have stock in motion (DISPATCHED / IN_TRANSIT). `
      + "Stock Master currently holds those movements, and this operation would overwrite or undo them. Receive the transfers first, then retry.",
    code: "ACTIVE_DISTRIBUTION_MOVEMENTS",
    activeTransfers: conflicts.map((t) => ({
      transferId: t.transferId, status: t.status, materialNo: t.materialNo,
      sourceDepotId: t.sourceDepotId, sourcePlantName: t.sourcePlantName,
      destinationDepotId: t.destinationDepotId, destinationPlantName: t.destinationPlantName,
    })),
  };
}

/** depotId → { mappings, recommendations, transfers } for every referenced depot among depotIds. */
async function findDepotReferences(depotIds) {
  const ids = [...new Set(depotIds.map(norm).filter(Boolean))];
  if (!ids.length) return {};
  const [mappings, recs, transfers] = await Promise.all([
    DepotPlantMapping.aggregate([{ $match: { depotId: { $in: ids } } }, { $group: { _id: "$depotId", n: { $sum: 1 } } }]),
    DistributionRecommendation.aggregate([
      { $match: { $or: [{ sourceDepotId: { $in: ids } }, { destinationDepotId: { $in: ids } }] } },
      { $project: { d: ["$sourceDepotId", "$destinationDepotId"] } }, { $unwind: "$d" }, { $match: { d: { $in: ids } } },
      { $group: { _id: "$d", n: { $sum: 1 } } },
    ]),
    DistributionTransfer.aggregate([
      { $match: { $or: [{ sourceDepotId: { $in: ids } }, { destinationDepotId: { $in: ids } }] } },
      { $project: { d: ["$sourceDepotId", "$destinationDepotId"] } }, { $unwind: "$d" }, { $match: { d: { $in: ids } } },
      { $group: { _id: "$d", n: { $sum: 1 } } },
    ]),
  ]);
  const out = {};
  const add = (rows, field) => rows.forEach(({ _id, n }) => { out[_id] = out[_id] || { mappings: 0, recommendations: 0, transfers: 0 }; out[_id][field] = n; });
  add(mappings, "mappings");
  add(recs, "recommendations");
  add(transfers, "transfers");
  return out;
}

function depotReferencedBody(references, action) {
  return {
    message: `${action} is blocked: the depot ID is referenced by Distribution (plant mappings, recommendations or transfers). `
      + "Referenced depot IDs are permanent so history stays intact; the depot name can still be edited.",
    code: "DEPOT_REFERENCED",
    references,
  };
}

module.exports = {
  ACTIVE_MOVEMENT_STATUSES,
  activeMovementTransfers,
  findStockImportConflicts,
  stockImportBlockedBody,
  findDepotReferences,
  depotReferencedBody,
};
