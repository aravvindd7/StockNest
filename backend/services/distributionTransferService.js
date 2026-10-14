/**
 * Distribution Stage 4 — recommendation review and transfer lifecycle.
 *
 * Every action runs inside the caller's MongoDB transaction (see
 * middleware/idempotency.js → utils/transactions.runInTransaction) and
 * re-reads everything it relies on, so a retried transaction never acts on
 * stale data and any failure rolls back every write.
 *
 *   approveRecommendation  PENDING → APPROVED, creates a REQUESTED transfer   (no stock movement)
 *   rejectRecommendation   PENDING → REJECTED                                  (no stock movement)
 *   createManualTransfer   → REQUESTED, no recommendation needed               (no stock movement)
 *   approveTransfer        REQUESTED → APPROVED                                 (no stock movement)
 *   dispatchTransfer       APPROVED → DISPATCHED      source SIH −q, destination SIT +q
 *   markInTransit          DISPATCHED → IN_TRANSIT                              (no stock movement)
 *   receiveTransfer        IN_TRANSIT → RECEIVED      destination SIT −dispatched, SIH +received, loss written off
 *   cancelTransfer         REQUESTED | APPROVED → CANCELLED                     (no stock movement)
 *
 * Commitments: stock promised to open REQUESTED/APPROVED transfers is not
 * available again. Every action that changes commitments against a source
 * touches a per material + source lock document in its transaction, so two
 * concurrent commitments against the same stock conflict and are serialized.
 */
const mongoose = require("mongoose");
const DistributionTransfer = require("../models/DistributionTransfer");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DistributionCounter = require("../models/DistributionCounter");
const Material = require("../models/Material");
const Depot = require("../models/Depot");
const StockMovement = require("../models/StockMovement");
const stockMovementService = require("./stockMovementService");
const { DistributionError } = require("../utils/transactions");

const OPEN_STATUSES = ["REQUESTED", "APPROVED"];
const norm = (v) => String(v || "").trim().toUpperCase();

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function nextTransferId(session) {
  const counter = await DistributionCounter.findOneAndUpdate(
    { _id: "transferId" }, { $inc: { seq: 1 } }, { upsert: true, new: true, session }
  );
  return `TRF-${String(counter.seq).padStart(6, "0")}`;
}

/** Serializes concurrent commitment changes against one material at one source depot. */
async function touchCommitmentLock(materialNo, depotId, session) {
  await DistributionCounter.updateOne({ _id: `commit:${materialNo}|${depotId}` }, { $inc: { seq: 1 } }, { upsert: true, session });
}

/** Quantity already promised from a source to open (not yet dispatched) transfers. */
async function openCommitments({ materialNo, sourceDepotId, excludeTransferId }, session) {
  const filter = { materialNo, sourceDepotId, status: { $in: OPEN_STATUSES } };
  if (excludeTransferId) filter._id = { $ne: excludeTransferId };
  const open = await DistributionTransfer.find(filter).select("status requestedQuantity approvedQuantity").session(session).lean();
  return open.reduce((s, t) => s + (t.status === "APPROVED" ? t.approvedQuantity : t.requestedQuantity), 0);
}

/** Live availability at the source: stock in hand minus open commitments. */
async function sourceAvailability({ materialNo, sourceDepotId, excludeTransferId }, session) {
  const { row, plantName } = await stockMovementService.resolveStockRow({ materialNo, depotId: sourceDepotId, role: "source" }, session);
  const committed = await openCommitments({ materialNo, sourceDepotId, excludeTransferId }, session);
  return { stockInHand: row.SIHQty, openCommitments: committed, available: Math.max(0, row.SIHQty - committed), plantName, stockId: row._id };
}

async function requireOperationalMaterial(materialNo, session) {
  const material = await Material.findOne({ materialNo, isActive: true }).session(session).lean();
  if (!material) throw new DistributionError(422, "MATERIAL_NOT_FOUND", `Material ${materialNo} does not exist in Material Master (or is inactive).`);
  if (material.status === "Discontinued") throw new DistributionError(422, "MATERIAL_DISCONTINUED", `Material ${materialNo} is discontinued.`);
  return material;
}

async function requireDepots(sourceDepotId, destinationDepotId, session) {
  if (sourceDepotId === destinationDepotId) throw new DistributionError(422, "SAME_DEPOT", "Source and destination depot must be different.");
  const found = new Set((await Depot.find({ depotId: { $in: [sourceDepotId, destinationDepotId] } }).session(session).lean()).map((d) => d.depotId));
  [sourceDepotId, destinationDepotId].forEach((d) => {
    if (!found.has(d)) throw new DistributionError(422, "DEPOT_NOT_FOUND", `Depot ${d} does not exist in Depot Master.`);
  });
}

async function loadTransfer(id, session) {
  const filter = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { transferId: norm(id) };
  const transfer = await DistributionTransfer.findOne(filter).session(session);
  if (!transfer) throw new DistributionError(404, "TRANSFER_NOT_FOUND", "Distribution transfer not found.");
  return transfer;
}

async function loadRecommendation(id, session) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new DistributionError(400, "INVALID_ID", "Invalid recommendation id.");
  const rec = await DistributionRecommendation.findById(id).session(session);
  if (!rec) throw new DistributionError(404, "RECOMMENDATION_NOT_FOUND", "Distribution recommendation not found.");
  return rec;
}

function requireStatus(doc, allowed, action) {
  if (!allowed.includes(doc.status)) {
    throw new DistributionError(409, "INVALID_STATUS_TRANSITION",
      `Cannot ${action}: it is ${doc.status} (allowed from ${allowed.join(" or ")}).`, { currentStatus: doc.status });
  }
}

function requireVersion(doc, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== doc.__v) {
    throw new DistributionError(409, "STALE_VERSION", `The record was changed by someone else (version ${doc.__v}, expected ${expectedVersion}). Reload and retry.`, { currentVersion: doc.__v });
  }
}

/** Saves a lifecycle change; the model's own rules (transitions, stage data, quantity chain) validate it. */
async function saveTransfer(transfer, { actor, notes }) {
  transfer.$locals.changedBy = actor;
  if (notes) transfer.$locals.statusNote = notes;
  await transfer.save();
  return transfer;
}

const plain = (doc) => JSON.parse(JSON.stringify(doc.toObject ? doc.toObject() : doc));

/** Validates destination resolution exists (a transfer must be receivable). */
async function requireDestinationRow(materialNo, destinationDepotId, session) {
  return stockMovementService.resolveStockRow({ materialNo, depotId: destinationDepotId, role: "destination" }, session);
}

// ─── Recommendation review ───────────────────────────────────────────────────

async function approveRecommendation(id, { approvedQuantity, reviewNotes, expectedVersion }, { actor }, session) {
  const rec = await loadRecommendation(id, session);
  requireVersion(rec, expectedVersion);
  requireStatus(rec, ["PENDING"], "approve this recommendation");
  const quantity = approvedQuantity === undefined ? rec.recommendedQuantity : approvedQuantity;

  // The snapshot bounds the quantity (the engine's evidence)…
  const limit = Math.min(rec.sourceSurplus, rec.destinationShortage);
  if (quantity > limit) {
    throw new DistributionError(422, "QUANTITY_EXCEEDS_RECOMMENDATION",
      `Approved quantity ${quantity} exceeds what the recommendation supports (min of source surplus ${rec.sourceSurplus} and destination shortage ${rec.destinationShortage}).`,
      { sourceSurplus: rec.sourceSurplus, destinationShortage: rec.destinationShortage });
  }
  // …and live stock decides whether it is still physically possible.
  await requireOperationalMaterial(rec.materialNo, session);
  await requireDepots(rec.sourceDepotId, rec.destinationDepotId, session);
  await touchCommitmentLock(rec.materialNo, rec.sourceDepotId, session);
  const live = await sourceAvailability({ materialNo: rec.materialNo, sourceDepotId: rec.sourceDepotId }, session);
  await requireDestinationRow(rec.materialNo, rec.destinationDepotId, session);
  if (quantity > live.available) {
    throw new DistributionError(409, "STALE_RECOMMENDATION",
      `Only ${live.available} of ${rec.materialNo} is still available at ${rec.sourceDepotId} (stock in hand ${live.stockInHand} − open commitments ${live.openCommitments}); cannot approve ${quantity}.`,
      { approvedQuantity: quantity, current: { stockInHand: live.stockInHand, openCommitments: live.openCommitments, available: live.available },
        snapshot: { sourceStockInHand: rec.sourceStockInHand, sourceSurplus: rec.sourceSurplus } });
  }

  const now = new Date();
  const transferId = await nextTransferId(session);
  const [transfer] = await DistributionTransfer.create([{
    transferId,
    materialNo: rec.materialNo,
    sourceDepotId: rec.sourceDepotId,
    destinationDepotId: rec.destinationDepotId,
    recommendationId: rec._id,
    reason: `Approved recommendation (${rec.generationRunId || "manual run"}): ${rec.reason}`,
    notes: reviewNotes,
    requestedQuantity: quantity,
    requestedBy: actor,
    requestedAt: now,
  }], { session });

  Object.assign(rec, { status: "APPROVED", approvedQuantity: quantity, reviewedBy: actor, reviewedAt: now, reviewNotes, transferId });
  await rec.save();
  return { recommendation: plain(rec), transfer: plain(transfer) };
}

async function rejectRecommendation(id, { reviewNotes, expectedVersion }, { actor }, session) {
  const rec = await loadRecommendation(id, session);
  requireVersion(rec, expectedVersion);
  requireStatus(rec, ["PENDING"], "reject this recommendation");
  Object.assign(rec, { status: "REJECTED", reviewedBy: actor, reviewedAt: new Date(), reviewNotes });
  await rec.save();
  return { recommendation: plain(rec) };
}

// ─── Transfers ───────────────────────────────────────────────────────────────

async function createManualTransfer({ materialNo, sourceDepotId, destinationDepotId, requestedQuantity, reason, notes }, { actor }, session) {
  const mat = norm(materialNo);
  const src = norm(sourceDepotId);
  const dst = norm(destinationDepotId);
  await requireOperationalMaterial(mat, session);
  await requireDepots(src, dst, session);
  await touchCommitmentLock(mat, src, session);
  const live = await sourceAvailability({ materialNo: mat, sourceDepotId: src }, session);
  await requireDestinationRow(mat, dst, session);
  if (requestedQuantity > live.available) {
    throw new DistributionError(409, "INSUFFICIENT_AVAILABLE_STOCK",
      `Only ${live.available} of ${mat} is available at ${src} (stock in hand ${live.stockInHand} − open commitments ${live.openCommitments}).`,
      { requestedQuantity, current: { stockInHand: live.stockInHand, openCommitments: live.openCommitments, available: live.available } });
  }
  const [transfer] = await DistributionTransfer.create([{
    transferId: await nextTransferId(session),
    materialNo: mat, sourceDepotId: src, destinationDepotId: dst,
    reason, notes, requestedQuantity, requestedBy: actor, requestedAt: new Date(),
  }], { session });
  return { transfer: plain(transfer) };
}

async function approveTransfer(id, { approvedQuantity, notes, expectedVersion }, { actor }, session) {
  const transfer = await loadTransfer(id, session);
  requireVersion(transfer, expectedVersion);
  requireStatus(transfer, ["REQUESTED"], "approve this transfer");
  const quantity = approvedQuantity === undefined ? transfer.requestedQuantity : approvedQuantity;
  if (quantity > transfer.requestedQuantity) {
    throw new DistributionError(422, "QUANTITY_EXCEEDS_REQUEST", `Approved quantity ${quantity} exceeds the requested ${transfer.requestedQuantity}.`);
  }
  await touchCommitmentLock(transfer.materialNo, transfer.sourceDepotId, session);
  const live = await sourceAvailability({ materialNo: transfer.materialNo, sourceDepotId: transfer.sourceDepotId, excludeTransferId: transfer._id }, session);
  await requireDestinationRow(transfer.materialNo, transfer.destinationDepotId, session);
  if (quantity > live.available) {
    throw new DistributionError(409, "INSUFFICIENT_AVAILABLE_STOCK",
      `Only ${live.available} of ${transfer.materialNo} is available at ${transfer.sourceDepotId} (stock in hand ${live.stockInHand} − other open commitments ${live.openCommitments}).`,
      { approvedQuantity: quantity, current: { stockInHand: live.stockInHand, openCommitments: live.openCommitments, available: live.available } });
  }
  Object.assign(transfer, { status: "APPROVED", approvedQuantity: quantity, approvedBy: actor, approvedAt: new Date() });
  await saveTransfer(transfer, { actor, notes });
  return { transfer: plain(transfer) };
}

async function dispatchTransfer(id, { dispatchedQuantity, notes, expectedVersion }, { actor, idempotencyKey }, session) {
  const transfer = await loadTransfer(id, session);
  requireVersion(transfer, expectedVersion);
  requireStatus(transfer, ["APPROVED"], "dispatch this transfer");
  const quantity = dispatchedQuantity === undefined ? transfer.approvedQuantity : dispatchedQuantity;
  if (quantity > transfer.approvedQuantity) {
    throw new DistributionError(422, "QUANTITY_EXCEEDS_APPROVAL", `Dispatched quantity ${quantity} exceeds the approved ${transfer.approvedQuantity}.`);
  }
  await touchCommitmentLock(transfer.materialNo, transfer.sourceDepotId, session);
  const material = await Material.findOne({ materialNo: transfer.materialNo }).session(session).lean();
  if (!material || !Number.isFinite(material.invCost) || material.invCost < 0) {
    throw new DistributionError(422, "MATERIAL_COST_UNAVAILABLE", `Material ${transfer.materialNo} has no valid Inv Cost to value the movement.`);
  }
  const source = await stockMovementService.resolveStockRow({ materialNo: transfer.materialNo, depotId: transfer.sourceDepotId, role: "source" }, session);
  const destination = await requireDestinationRow(transfer.materialNo, transfer.destinationDepotId, session);

  const result = await stockMovementService.applyDispatch({
    transfer, sourceRow: source.row, destinationRow: destination.row, quantity, unitCost: material.invCost, actor, idempotencyKey,
  }, session);

  Object.assign(transfer, {
    status: "DISPATCHED", dispatchedQuantity: quantity, dispatchedBy: actor, dispatchedAt: new Date(),
    sourcePlantName: source.plantName, sourceStockId: source.row._id,
    destinationPlantName: destination.plantName, destinationStockId: destination.row._id,
    unitCost: material.invCost,
  });
  await saveTransfer(transfer, { actor, notes });
  return { transfer: plain(transfer), movements: result.movements.map(plain) };
}

async function markInTransit(id, { notes, expectedVersion }, { actor }, session) {
  const transfer = await loadTransfer(id, session);
  requireVersion(transfer, expectedVersion);
  requireStatus(transfer, ["DISPATCHED"], "mark this transfer in transit");
  Object.assign(transfer, { status: "IN_TRANSIT", inTransitBy: actor, inTransitAt: new Date() });
  await saveTransfer(transfer, { actor, notes });
  return { transfer: plain(transfer) };
}

async function receiveTransfer(id, { receivedQuantity, discrepancyReason, notes, expectedVersion }, { actor, idempotencyKey }, session) {
  const transfer = await loadTransfer(id, session);
  requireVersion(transfer, expectedVersion);
  requireStatus(transfer, ["IN_TRANSIT"], "receive this transfer");
  if (receivedQuantity > transfer.dispatchedQuantity) {
    throw new DistributionError(422, "RECEIVED_EXCEEDS_DISPATCHED", `Received quantity ${receivedQuantity} exceeds the dispatched ${transfer.dispatchedQuantity}.`);
  }
  const loss = transfer.dispatchedQuantity - receivedQuantity;
  if (loss > 0 && !discrepancyReason) {
    throw new DistributionError(422, "DISCREPANCY_REASON_REQUIRED", `Received ${receivedQuantity} of ${transfer.dispatchedQuantity} dispatched — a discrepancy reason is required for the ${loss} unit transit loss.`);
  }
  // The receipt must land on the exact row that holds this transfer's in-transit stock.
  const destination = await requireDestinationRow(transfer.materialNo, transfer.destinationDepotId, session);
  if (String(destination.row._id) !== String(transfer.destinationStockId)) {
    throw new DistributionError(409, "DESTINATION_STOCK_ROW_CHANGED",
      "The destination Stock Master row resolved now is not the row that received this transfer's in-transit stock at dispatch.",
      { dispatchedTo: transfer.destinationStockId, resolvedNow: destination.row._id });
  }
  const result = await stockMovementService.applyReceipt({ transfer, destinationRow: destination.row, receivedQuantity, actor, idempotencyKey }, session);

  Object.assign(transfer, {
    status: "RECEIVED", receivedQuantity, receivedBy: actor, receivedAt: new Date(),
    transitLossQuantity: loss, ...(loss > 0 ? { discrepancyReason } : {}),
  });
  await saveTransfer(transfer, { actor, notes: notes || (loss > 0 ? `Transit loss ${loss}: ${discrepancyReason}` : undefined) });
  return { transfer: plain(transfer), movements: result.movements.map(plain), transitLoss: loss };
}

async function cancelTransfer(id, { cancellationReason, expectedVersion }, { actor }, session) {
  const transfer = await loadTransfer(id, session);
  requireVersion(transfer, expectedVersion);
  requireStatus(transfer, ["REQUESTED", "APPROVED"], "cancel this transfer (stock has already left the source once dispatched)");
  await touchCommitmentLock(transfer.materialNo, transfer.sourceDepotId, session);
  Object.assign(transfer, { status: "CANCELLED", cancelledBy: actor, cancelledAt: new Date(), cancellationReason });
  await saveTransfer(transfer, { actor, notes: cancellationReason });
  return { transfer: plain(transfer) };
}

/** Read-only: the ledger entries for one transfer. */
async function listMovements(id) {
  const filter = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { transferId: norm(id) };
  const transfer = await DistributionTransfer.findOne(filter).select("transferId").lean();
  if (!transfer) throw new DistributionError(404, "TRANSFER_NOT_FOUND", "Distribution transfer not found.");
  return StockMovement.find({ transferId: transfer.transferId }).sort({ createdAt: 1, movementType: 1, side: -1 }).lean();
}

module.exports = {
  OPEN_STATUSES,
  nextTransferId,
  openCommitments,
  sourceAvailability,
  approveRecommendation,
  rejectRecommendation,
  createManualTransfer,
  approveTransfer,
  dispatchTransfer,
  markInTransit,
  receiveTransfer,
  cancelTransfer,
  listMovements,
};
