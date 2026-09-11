import api from "./api";

/**
 * The fixed Active-FY operational timeline view — read-only, assembled fresh
 * from Material/Stock/Sales/ForecastPredictions. Returns
 *   { activeFY, activeMonth, activeQuarter, workingQuarter, previousFY,
 *     currentQuarter: { label }, hasForecastData, groups: [{index, viewYear, hasData}], data: [...] }
 * where each data row carries row-level attributes (safetyStock,
 * currentStock, trend, stockRisk, growthPct, confidence, planDemand,
 * requiredStock, currentQuarterSales, currentQuarterSalesToGo,
 * inventoryDecision) plus a per-FY `years` map keyed by FY start calendar
 * year. The three visible FY groups (Previous | Previous | Active) are
 * always derived server-side from the clock — no client-side FY selection.
 *
 * `currentQuarter.label` is the real-world calendar quarter (e.g. "Q2") used
 * to label the two current-quarter Sales columns; it is independent of the
 * FY/quarter timeline.
 */
export async function fetchPlanningComparison(params = {}) {
  const { data } = await api.get("/planning", { params });
  return data;
}

/**
 * Selectable financial years — retained for backward compatibility.
 * Planning Master no longer uses a FY selector: the timeline (Previous |
 * Previous | Active) is fixed and rolls forward from the server clock.
 */
export async function fetchPlanningYears() {
  const { data } = await api.get("/planning/years");
  return data;
}

/**
 * Admin-only: triggers the rolling 6-month forecast regeneration via
 * the ML service. The backend derives the window anchor from the server
 * clock — no client-side params needed.
 */
export async function regenerateForecast() {
  const { data } = await api.post("/forecast/generate", {});
  return data;
}

/**
 * Save a planner-controlled replenishment allocation for a material's
 * working quarter. The backend recalculates quantities from percentages
 * (largest-remainder, sum exactly = requiredStock) and upserts the
 * ReplenishmentPlan document.
 *
 * @param {{materialNo, financialYear, quarter, requiredStock, distribution, depotId?}} payload
 */
export async function saveReplenishmentPlan(payload) {
  const { data } = await api.post("/planning/replenishment", payload);
  return data;
}

/**
 * Load a saved replenishment allocation. Resolves to the saved document,
 * or null when none exists (the drawer then applies the default temporary
 * 33.33/33.33/33.34 split without persisting).
 *
 * @param {{materialNo, financialYear, quarter, depotId?}} params
 */
export async function fetchReplenishmentPlan(params) {
  const { data } = await api.get("/planning/replenishment", { params });
  return data;
}

/**
 * Discard a saved manual replenishment allocation for a material's working
 * quarter. Deletes the persisted ReplenishmentPlan document server-side, so
 * the active plan resolves back to the AUTO_FORECAST prediction across
 * reloads — not just within the current editor.
 *
 * @param {{materialNo, financialYear, quarter, depotId?}} params
 */
export async function resetReplenishmentPlan(params) {
  const { data } = await api.post("/planning/replenishment/reset", params);
  return data;
}

/**
 * Apply the current drawer's percentage distribution to ALL applicable
 * materials for the given financial year and quarter. Backend resolves the
 * scope, computes quantities per-material, validates, and persists each as
 * a MANUAL plan.
 *
 * @param {{financialYear: string, distribution: [{month: string, percentage: number, source?: string}]}} payload
 * @returns {{saved: number, affected: number, results: [{materialNo: string, status: string, error?: string}]}}
 */
export async function applyToAllReplenishmentPlan(payload) {
  const { data } = await api.post("/planning/replenishment/apply-to-all", payload);
  return data;
}