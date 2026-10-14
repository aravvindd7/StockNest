/**
 * Depot Safety Stock — Distribution Stage 2.
 *
 * Same evidence and rule as ForecastErrorStats (services/safetyStockService.js):
 * the ML service's leakage-safe walk-forward backtest rows, and the 90th
 * percentile of positive underforecast errors (actual − xgb_pred > 0),
 * computed by the SAME calculateSafetyStockForMaterial function — so the
 * percentile, minimum-history rule and statuses cannot drift between the two.
 *
 * The difference is scale. Each backtest row is a Material × Plant × Month
 * observation; plants are translated to depots through the active
 * DepotPlantMapping, and for each Material × Depot × Month the actuals and
 * predictions of all that depot's plants are summed first. The depot's error
 * is therefore measured on the depot's own demand (with one plant per depot,
 * exactly that plant's error) — the scale its stock is compared against.
 *
 * Writes ONLY to the depotsafetystocks collection; ForecastErrorStats,
 * Planning Safety Stock and every master are untouched. Runs only when an
 * admin calls the refresh endpoint — never automatically.
 */
const DepotSafetyStock = require("../models/DepotSafetyStock");
const mlServiceClient = require("./mlServiceClient");
const { calculateSafetyStockForMaterial } = require("./safetyStockService");
const { resolveActivePlantMapping } = require("./depotPlantMappingService");

const norm = (v) => String(v || "").trim().toUpperCase();

/**
 * Pure aggregation: backtest rows + plant→depot map → per Material × Depot
 * stats documents, plus what was skipped and why.
 */
function computeDepotSafetyStock(rows, plantToDepot, calculatedAt = new Date()) {
  const unmappedPlants = new Map();
  let invalidRows = 0;

  // De-duplicate Material × Plant × Month observations first (same rule as ForecastErrorStats).
  const plantObs = new Map();
  rows.forEach((row) => {
    const materialNo = norm(row.MatNo);
    if (!materialNo || !Number.isFinite(row.actual) || !Number.isFinite(row.xgb_pred)) {
      invalidRows += 1;
      return;
    }
    plantObs.set(`${materialNo}|${row.Plant}|${row.FinancialYear}|${row.Month}`, { ...row, materialNo });
  });

  // Sum each depot's plants per Material × Month.
  const depotObs = new Map();
  plantObs.forEach((row) => {
    const depotId = plantToDepot.get(row.Plant);
    if (!depotId) {
      unmappedPlants.set(row.Plant, (unmappedPlants.get(row.Plant) || 0) + 1);
      return;
    }
    const key = `${row.materialNo}|${depotId}|${row.FinancialYear}|${row.Month}`;
    const obs = depotObs.get(key) || {
      materialNo: row.materialNo, depotId, actual: 0, xgb_pred: 0,
      month_index: row.month_index, FinancialYear: row.FinancialYear, Month: row.Month, plants: new Set(),
    };
    obs.actual += row.actual;
    obs.xgb_pred += row.xgb_pred;
    obs.plants.add(row.Plant);
    depotObs.set(key, obs);
  });

  const byMaterialDepot = new Map();
  depotObs.forEach((obs) => {
    const key = `${obs.materialNo}|${obs.depotId}`;
    if (!byMaterialDepot.has(key)) byMaterialDepot.set(key, []);
    byMaterialDepot.get(key).push(obs);
  });

  const docs = [...byMaterialDepot.values()].map((observations) => {
    const { materialNo, depotId } = observations[0];
    const stats = calculateSafetyStockForMaterial(materialNo, observations);
    const plants = new Set();
    observations.forEach((o) => o.plants.forEach((p) => plants.add(p)));
    return { ...stats, depotId, plants: [...plants].sort(), calculatedAt };
  });

  return {
    docs: docs.sort((a, b) => a.materialNo.localeCompare(b.materialNo) || a.depotId.localeCompare(b.depotId)),
    unmappedPlants: [...unmappedPlants].map(([plantName, observationCount]) => ({ plantName, observationCount })),
    invalidRows,
  };
}

/** Refreshes depotsafetystocks from a fresh backtest. Returns a summary (nothing else is written). */
async function refreshDepotSafetyStock() {
  const { plantToDepot, mappingsToUnknownDepots } = await resolveActivePlantMapping();
  if (plantToDepot.size === 0) {
    const err = new Error("No active depot-plant mappings — import the Depot ↔ Plant mapping before calculating depot safety stock.");
    err.status = 422;
    throw err;
  }

  const backtest = await mlServiceClient.requestBacktestRows();
  if (!backtest || !Array.isArray(backtest.rows)) throw new Error("Invalid backtest response: missing or invalid rows array");

  const runAt = new Date();
  const { docs, unmappedPlants, invalidRows } = computeDepotSafetyStock(backtest.rows, plantToDepot, runAt);

  const validationErrors = [];
  const ops = [];
  docs.forEach((doc) => {
    const err = new DepotSafetyStock(doc).validateSync();
    if (err) {
      validationErrors.push({ materialNo: doc.materialNo, depotId: doc.depotId, error: err.message });
      return;
    }
    ops.push({ updateOne: { filter: { materialNo: doc.materialNo, depotId: doc.depotId }, update: { $set: doc }, upsert: true } });
  });
  if (ops.length) await DepotSafetyStock.bulkWrite(ops);
  // Combinations not produced by this run (e.g. a plant re-mapped elsewhere) are stale.
  const removed = await DepotSafetyStock.deleteMany({ calculatedAt: { $lt: runAt } });

  const byStatus = docs.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});
  return {
    calculatedAt: runAt,
    dataSource: backtest.dataSource,
    processed: ops.length,
    byStatus,
    removedStale: removed.deletedCount || 0,
    unmappedPlants,
    mappingsToUnknownDepots,
    invalidRows,
    validationErrors,
  };
}

module.exports = { computeDepotSafetyStock, refreshDepotSafetyStock };
