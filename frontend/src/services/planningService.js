import api from "./api";

/** Distinct financial years available as a starting point for the 3-year window. */
export async function fetchPlanningYears() {
  const { data } = await api.get("/planning/years");
  return data.years; // [{ value, label }]
}

/** The consolidated planning view — read-only, assembled fresh from Material/Stock/Sales. */
export async function fetchPlanningData({ search, startYear, ...filterParams } = {}) {
  const params = { ...filterParams };
  if (search) params.search = search;
  if (startYear) params.startYear = startYear;
  const { data } = await api.get("/planning", { params });
  return data; // { years, forecastYear, startYear, data }
}
