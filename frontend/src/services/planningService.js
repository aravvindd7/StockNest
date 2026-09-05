import api from "./api";

/**
 * The consolidated 3-slot FY comparison view — read-only, assembled fresh
 * from Material/Stock/Sales. Returns
 *   { currentFY, groups: [{index, viewYear, isForecastYear, hasData}], data: [...] }
 * where each data row carries row-level attributes (safetyStock,
 * currentStock, trend, stockRisk, growthPct, confidence, inventoryDecision)
 * plus a per-FY `years` map keyed by FY start calendar year.
 *
 * `viewYears` is an array of 3 FY start years — the three independent,
 * user-selectable FY column slots. Omitted → backend defaults to
 * Previous | Current | Next-Forecast FY.
 */
export async function fetchPlanningComparison({ search, viewYears, ...filterParams } = {}) {
  const params = { ...filterParams };
  if (search) params.search = search;
  if (viewYears && viewYears.length) params.viewYears = viewYears.join(",");
  const { data } = await api.get("/planning", { params });
  return data;
}

/**
 * All selectable financial years — historical FYs from Sales Master plus
 * the current FY and the immediate next forecast FY — for the per-column-group
 * FY header filters. Returns { years: [{value, label, current?, forecast?}],
 * currentFY: {value, label} }.
 */
export async function fetchPlanningYears() {
  const { data } = await api.get("/planning/years");
  return data;
}

/**
 * Admin-only: triggers the rolling 36-month forecast regeneration via
 * the ML service. The backend derives the window anchor from the server
 * clock — no client-side params needed.
 */
export async function regenerateForecast() {
  const { data } = await api.post("/forecast/generate", {});
  return data;
}
