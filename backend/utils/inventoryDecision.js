/**
 * Phase 7 — Inventory Decision Engine.
 *
 * A pure, backend calculation layer that turns the Planning Engine's
 * existing outputs — current stock, quarterly forecast demand, safety stock
 * — into an actionable inventory decision for each forecast quarter. It
 * creates no new collections and makes no writes: everything derives from
 * data the Planning view already loads, so Planning Master's read path is
 * untouched and this can never make it depend on the ML service.
 *
 * Grain: Planning operates at material level (forecast quantities are
 * already summed across plants by planningService's buildForecastFromML /
 * the Sales rollup), reusing the same material-level stock representation
 * the Planning Master table already shows. Each decision is per forecast
 * quarter and uses that quarter's forecast demand only — monthly and
 * quarterly quantities are never mixed.
 *
 * Reuse over duplication (Part 2): `safetyStock` is the existing computed
 * heuristic from utils/safetyStock.js (half of average quarterly demand —
 * Stock Master has no dedicated safety-stock field, per that file's note)
 * and `currentStock` is the exact value planningService.js already derives
 * from Stock Master. This module only adds the projection/replenishment
 * layer on top; it does not re-derive either input.
 *
 * Formulas (documented):
 *   projectedStock     = currentStock - forecastDemand
 *   replenishmentQty   = max(0, safetyStock - projectedStock)
 *   stockStatus        = CRITICAL | LOW | HEALTHY | SURPLUS (see classify)
 *
 * Data safety (Part 6): every input is coerced via Number() and sanity-
 * checked. Missing/unavailable inputs yield `null` for that field rather
 * than a fabricated value, and any phase of the calculation that depends on
 * a `null` input propagates null (nothing crashes, nothing invents a number).
 * `currentStock` is never converted to a fake zero here — it is the value
 * the rest of the Planning view already presents (planningService.js treats
 * a material with no Stock row as 0, matching the table's display), and we
 * inherit that convention rather than inventing one.
 */
const STOCK_STATUSES = ["CRITICAL", "LOW", "HEALTHY", "SURPLUS"];

/** Action text per stock status — generated from the classified status, never per material. */
const ACTION_BY_STATUS = {
  CRITICAL: "Urgent replenishment",
  LOW: "Plan replenishment",
  HEALTHY: "No action required",
  SURPLUS: "Monitor stock",
};

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Stock expected to remain on hand after covering the quarter's forecast demand. */
function computeProjectedStock(currentStock, forecastDemand) {
  const stock = toFiniteOrNull(currentStock);
  const demand = toFiniteOrNull(forecastDemand);
  if (stock === null || demand === null) return null;
  return stock - demand;
}

/** Quantity needed to bring projected stock back up to safety-stock level; never negative, never below zero orders. */
function computeReplenishmentQty(safetyStock, projectedStock) {
  const safety = toFiniteOrNull(safetyStock);
  if (safety === null) return null;
  if (projectedStock === null) return null;
  return Math.max(0, safety - projectedStock);
}

/**
 * Classifies stock health for one quarter.
 *
 *   CRITICAL  — current stock is already below the safety buffer today
 *               (no further demand assumed; the buffer is already breached).
 *   LOW       — current stock is fine today but the quarter's forecast
 *               demand will push projected stock below the safety buffer.
 *   SURPLUS   — projected stock sits comfortably above the buffer (more
 *               than 1.5x it); only meaningful when a buffer exists.
 *   HEALTHY   — projected stock remains at or above the safety buffer and
 *               below the surplus threshold.
 *
 * When safetyStock is 0 (no sales history to derive a buffer from) CRITICAL
 * can never trigger (currentStock is non-negative) and SURPLUS has no basis
 * (guarded by `safetyStock > 0`), so the classification falls back to LOW
 * if demand will outstrip stock and HEALTHY otherwise — never a fabricated
 * CRITICAL/SURPLUS assertion from a nonexistent buffer.
 */
function classifyStockStatus({ currentStock, safetyStock, projectedStock }) {
  if (currentStock === null || safetyStock === null || projectedStock === null) return null;
  if (currentStock < safetyStock) return "CRITICAL";
  if (projectedStock < safetyStock) return "LOW";
  if (safetyStock > 0 && projectedStock > safetyStock * 1.5) return "SURPLUS";
  return "HEALTHY";
}

function recommendedActionFor(status) {
  return status ? ACTION_BY_STATUS[status] || null : null;
}

/**
 * Builds the full inventory decision for one forecast quarter.
 *
 * @param {object} opts
 * @param {number|string} opts.currentStock  The Planning view's material-level current stock.
 * @param {number|string} opts.safetyStock   The existing computed safety stock (utils/safetyStock.js).
 * @param {{qty: number}} opts.quarterForecast The forecast quarter object (uses only its `qty`).
 * @returns {object} decision with forecastDemand, currentStock, safetyStock, projectedStock,
 *                   replenishmentQty, stockStatus, recommendedAction — each null when unavailable.
 */
function buildInventoryDecision({ currentStock, safetyStock, quarterForecast } = {}) {
  const current = toFiniteOrNull(currentStock);
  const safety = toFiniteOrNull(safetyStock);
  const forecastDemand =
    quarterForecast && Number.isFinite(Number(quarterForecast.qty)) ? Number(quarterForecast.qty) : null;

  const projectedStock = computeProjectedStock(current, forecastDemand);
  const replenishmentQty = computeReplenishmentQty(safety, projectedStock);
  const stockStatus = classifyStockStatus({
    currentStock: current,
    safetyStock: safety,
    projectedStock,
  });
  const recommendedAction = recommendedActionFor(stockStatus);

  return {
    forecastDemand,
    currentStock: current,
    safetyStock: safety,
    projectedStock,
    replenishmentQty,
    stockStatus,
    recommendedAction,
  };
}

module.exports = {
  STOCK_STATUSES,
  computeProjectedStock,
  computeReplenishmentQty,
  classifyStockStatus,
  recommendedActionFor,
  buildInventoryDecision,
};
