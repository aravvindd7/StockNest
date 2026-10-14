/**
 * Stock movement service — Distribution Stage 4.
 *
 * The ONLY code path through which Distribution changes Stock Master. Every
 * function takes the caller's MongoDB session: callers run inside
 * utils/transactions.runInTransaction, so a failure anywhere rolls back the
 * transfer, both Stock rows and the ledger together.
 *
 * Stock row resolution (never guessed):
 *   depot → active DepotPlantMapping plants → Stock rows for material + plant(s)
 *   exactly one row is required: none → 422, several → 409.
 *
 * Every row touched must satisfy, before and after:
 *   SIHQty + SITQTY = TotalStockQty, all whole numbers ≥ 0,
 *   mirrors equal (SIH = SIHQty, SIT = SITQTY, TotalStock = TotalStockQty),
 *   SIHCV + SITCV = TotalStockCV, StockVal = TotalStockCV.
 * Values move by quantity × unit cost (Material.invCost, frozen on the
 * transfer at dispatch so receipt reverses the in-transit value exactly).
 *
 * Updates are conditional on the exact quantities read (and SIHQty ≥ q for a
 * dispatch), so a concurrent change can never be overwritten.
 */
const DepotPlantMapping = require("../models/DepotPlantMapping");
const Stock = require("../models/Stock");
const StockMovement = require("../models/StockMovement");
const { DistributionError } = require("../utils/transactions");

const CV_TOLERANCE = 0.02;
const round2 = (x) => Math.round(x * 100) / 100;
const isWhole = (v) => Number.isInteger(v) && v >= 0;

function snapshotOf(row) {
  return {
    SIHQty: row.SIHQty, SITQTY: row.SITQTY, TotalStockQty: row.TotalStockQty,
    SIHCV: row.SIHCV, SITCV: row.SITCV, TotalStockCV: row.TotalStockCV,
  };
}

/** Problems with a Stock row's quantity/value invariants (empty = consistent). */
function invariantProblems(row) {
  const problems = [];
  ["SIHQty", "SITQTY", "TotalStockQty"].forEach((f) => { if (!isWhole(row[f])) problems.push(`${f} must be a whole number ≥ 0 (is ${row[f]})`); });
  if (row.SIHQty + row.SITQTY !== row.TotalStockQty) problems.push(`SIHQty + SITQTY (${row.SIHQty} + ${row.SITQTY}) ≠ TotalStockQty (${row.TotalStockQty})`);
  if (row.SIH !== row.SIHQty) problems.push(`SIH (${row.SIH}) ≠ SIHQty (${row.SIHQty})`);
  if (row.SIT !== row.SITQTY) problems.push(`SIT (${row.SIT}) ≠ SITQTY (${row.SITQTY})`);
  if (row.TotalStock !== row.TotalStockQty) problems.push(`TotalStock (${row.TotalStock}) ≠ TotalStockQty (${row.TotalStockQty})`);
  if (Math.abs(row.SIHCV + row.SITCV - row.TotalStockCV) > CV_TOLERANCE) problems.push(`SIHCV + SITCV ≠ TotalStockCV`);
  if (Math.abs(row.StockVal - row.TotalStockCV) > CV_TOLERANCE) problems.push(`StockVal ≠ TotalStockCV`);
  return problems;
}

/**
 * Resolves the single Stock Master row for material + depot.
 * @param {"source"|"destination"} role  used only for clearer errors
 */
async function resolveStockRow({ materialNo, depotId, role }, session) {
  const mappings = await DepotPlantMapping.find({ depotId, isActive: true }).session(session).lean();
  if (!mappings.length) {
    throw new DistributionError(422, "DEPOT_NOT_MAPPED", `${role === "source" ? "Source" : "Destination"} depot ${depotId} has no active plant mapping, so its Stock Master row cannot be resolved.`);
  }
  const plants = mappings.map((m) => m.plantName);
  const rows = await Stock.find({ MatNo: materialNo, PlantName: { $in: plants } }).session(session).lean();

  if (rows.length === 0) {
    if (role === "destination") {
      throw new DistributionError(422, "DESTINATION_STOCK_ROW_MISSING",
        `No Stock Master record exists for ${materialNo} at destination depot ${depotId} (plant ${plants.join(", ")}). The destination Stock Master record must exist first — Distribution never creates Stock rows.`);
    }
    throw new DistributionError(422, "SOURCE_STOCK_ROW_MISSING", `No Stock Master record exists for ${materialNo} at source depot ${depotId} (plant ${plants.join(", ")}).`);
  }
  if (rows.length > 1) {
    throw new DistributionError(409, "AMBIGUOUS_STOCK_ROWS",
      `${rows.length} Stock Master rows match ${materialNo} at ${role} depot ${depotId}; exactly one is required. Resolve the duplicate Stock rows first.`,
      { rows: rows.map((r) => ({ stockId: r._id, plantName: r.PlantName, storageLocation: r.StorageLocation, stockDate: r.StockDate })) });
  }
  const row = rows[0];
  const problems = invariantProblems(row);
  if (problems.length) {
    throw new DistributionError(409, "STOCK_ROW_INCONSISTENT",
      `The ${role} Stock Master row for ${materialNo} at ${depotId} is internally inconsistent; no movement was applied.`, { stockId: row._id, problems });
  }
  return { row, plantName: row.PlantName };
}

/**
 * Applies one signed quantity change to a Stock row (all mirrors + values),
 * conditional on the exact quantities in `row`. Returns the updated row image.
 */
async function applyStockChange(row, change, unitCost, session, guard = {}) {
  const after = {
    SIHQty: row.SIHQty + (change.SIHQty || 0),
    SITQTY: row.SITQTY + (change.SITQTY || 0),
    TotalStockQty: row.TotalStockQty + (change.TotalStockQty || 0),
  };
  after.SIHCV = round2(row.SIHCV + (change.SIHQty || 0) * unitCost);
  after.SITCV = round2(row.SITCV + (change.SITQTY || 0) * unitCost);
  after.TotalStockCV = round2(row.TotalStockCV + (change.TotalStockQty || 0) * unitCost);

  const next = { ...row, ...after, SIH: after.SIHQty, SIT: after.SITQTY, TotalStock: after.TotalStockQty, StockVal: after.TotalStockCV };
  const problems = invariantProblems(next);
  if (problems.length) {
    throw new DistributionError(409, "STOCK_INVARIANT_VIOLATION", "This movement would leave the Stock Master row inconsistent; nothing was applied.", { stockId: row._id, problems });
  }

  const filter = { _id: row._id, SIHQty: row.SIHQty, SITQTY: row.SITQTY, TotalStockQty: row.TotalStockQty, ...guard };
  const result = await Stock.updateOne(filter, {
    $set: {
      SIHQty: next.SIHQty, SIH: next.SIH, SITQTY: next.SITQTY, SIT: next.SIT, TotalStockQty: next.TotalStockQty, TotalStock: next.TotalStock,
      SIHCV: next.SIHCV, SITCV: next.SITCV, TotalStockCV: next.TotalStockCV, StockVal: next.StockVal,
    },
  }, { session });
  if (result.matchedCount !== 1) {
    throw new DistributionError(409, "STOCK_CHANGED_CONCURRENTLY", "The Stock Master row changed (or no longer has enough stock in hand) while this movement was being applied; nothing was applied.", { stockId: row._id });
  }
  return next;
}

function ledgerEntry({ transfer, movementType, side, depotId, row, quantity, change, unitCost, before, after, actor, idempotencyKey }) {
  return {
    transferId: transfer.transferId, movementType, side, materialNo: transfer.materialNo, depotId,
    plantName: row.PlantName, stockId: row._id, storageLocation: row.StorageLocation,
    quantity, change, unitCost, before: snapshotOf(before), after: snapshotOf(after), actor, idempotencyKey,
  };
}

async function writeLedger(entries, session) {
  try {
    return await StockMovement.create(entries, { session, ordered: true });
  } catch (err) {
    if (err.code === 11000) {
      throw new DistributionError(409, "DUPLICATE_MOVEMENT", "This stock movement has already been applied for the transfer; nothing was applied again.");
    }
    throw err;
  }
}

/** DISPATCH: source SIH −q / Total −q; destination SIT +q / Total +q; two ledger entries. */
async function applyDispatch({ transfer, sourceRow, destinationRow, quantity, unitCost, actor, idempotencyKey }, session) {
  if (sourceRow.SIHQty < quantity) {
    throw new DistributionError(409, "INSUFFICIENT_STOCK_IN_HAND",
      `Source depot ${transfer.sourceDepotId} has ${sourceRow.SIHQty} of ${transfer.materialNo} in hand; cannot dispatch ${quantity}. Stock in transit is not dispatchable.`,
      { stockInHand: sourceRow.SIHQty, requested: quantity });
  }
  const srcChange = { SIHQty: -quantity, SITQTY: 0, TotalStockQty: -quantity };
  const dstChange = { SIHQty: 0, SITQTY: quantity, TotalStockQty: quantity };
  const srcAfter = await applyStockChange(sourceRow, srcChange, unitCost, session, { SIHQty: { $eq: sourceRow.SIHQty, $gte: quantity } });
  const dstAfter = await applyStockChange(destinationRow, dstChange, unitCost, session);
  const movements = await writeLedger([
    ledgerEntry({ transfer, movementType: "DISPATCH", side: "SOURCE", depotId: transfer.sourceDepotId, row: sourceRow, quantity, change: srcChange, unitCost, before: sourceRow, after: srcAfter, actor, idempotencyKey }),
    ledgerEntry({ transfer, movementType: "DISPATCH", side: "DESTINATION", depotId: transfer.destinationDepotId, row: destinationRow, quantity, change: dstChange, unitCost, before: destinationRow, after: dstAfter, actor, idempotencyKey }),
  ], session);
  return { source: srcAfter, destination: dstAfter, movements };
}

/**
 * RECEIPT: destination SIT −dispatched, SIH +received, Total −(dispatched − received).
 * Ledger: RECEIPT (SIT −received, SIH +received) and, if short, TRANSIT_LOSS (SIT −loss, Total −loss).
 */
async function applyReceipt({ transfer, destinationRow, receivedQuantity, actor, idempotencyKey }, session) {
  const dispatched = transfer.dispatchedQuantity;
  const loss = dispatched - receivedQuantity;
  const unitCost = transfer.unitCost;
  if (destinationRow.SITQTY < dispatched) {
    throw new DistributionError(409, "IN_TRANSIT_STOCK_MISMATCH",
      `Destination Stock row shows ${destinationRow.SITQTY} in transit but this transfer dispatched ${dispatched}; the in-transit stock was changed outside Distribution. Nothing was applied.`,
      { stockId: destinationRow._id, stockInTransit: destinationRow.SITQTY, dispatched });
  }
  const entries = [];
  let current = destinationRow;
  {
    // Always recorded (even a 0-unit receipt), so every receipt is auditable.
    const change = { SIHQty: receivedQuantity, SITQTY: -receivedQuantity, TotalStockQty: 0 };
    const after = await applyStockChange(current, change, unitCost, session);
    entries.push(ledgerEntry({ transfer, movementType: "RECEIPT", side: "DESTINATION", depotId: transfer.destinationDepotId, row: destinationRow, quantity: receivedQuantity, change, unitCost, before: current, after, actor, idempotencyKey }));
    current = after;
  }
  if (loss > 0) {
    const change = { SIHQty: 0, SITQTY: -loss, TotalStockQty: -loss };
    const after = await applyStockChange(current, change, unitCost, session);
    entries.push(ledgerEntry({ transfer, movementType: "TRANSIT_LOSS", side: "DESTINATION", depotId: transfer.destinationDepotId, row: destinationRow, quantity: loss, change, unitCost, before: current, after, actor, idempotencyKey }));
    current = after;
  }
  const movements = await writeLedger(entries, session);
  return { destination: current, movements, transitLoss: loss };
}

module.exports = { resolveStockRow, applyStockChange, applyDispatch, applyReceipt, invariantProblems, snapshotOf };
