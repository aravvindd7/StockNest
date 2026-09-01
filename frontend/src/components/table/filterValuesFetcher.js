import api from "../../services/api";

/**
 * Creates a getFilterOptions(field, search) function bound to one
 * module's API base path — the live-search backing every ColumnFilter
 * multiselect popup. Same shape reused by Material/Depot/Stock/Sales.
 */
export function createFilterValuesFetcher(basePath) {
  return async function getFilterOptions(field, search) {
    const { data } = await api.get(`${basePath}/filter-values`, { params: { field, search: search || undefined } });
    return data.values;
  };
}
