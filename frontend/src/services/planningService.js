import api from "./api";

/**
 * The fixed Active-FY operational timeline view — read-only, assembled fresh
 * from Material/Stock/Sales/ForecastPredictions. Returns
 *   { activeFY, activeMonth, activeQuarter, workingQuarter, previousFY,
 *     hasForecastData, groups: [{index, viewYear, hasData}], data: [...] }
 * where each data row carries row-level attributes (safetyStock,
 * currentStock, trend, stockRisk, growthPct, confidence, planDemand,
 * requiredStock, inventoryDecision) plus a per-FY `years` map keyed by FY
 * start calendar year. The three visible FY groups (Previous | Previous |
 * Active) are always derived server-side from the clock — no client-side
 * FY selection.
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