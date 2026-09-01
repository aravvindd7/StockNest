import api from "./api";

/**
 * filters: plain object of query params, e.g.
 *   { materialNo, description, model, branch,
 *     warehouse, stockStatus, minQty, maxQty, search, page, limit, sortBy, sortDir }
 * Empty/undefined values are stripped before the request is sent.
 */
export async function fetchInventory(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) params[key] = value;
  });
  const { data } = await api.get("/inventory", { params });
  return data; // { data, pagination, summary }
}

export async function fetchInventoryFilterOptions() {
  const { data } = await api.get("/inventory/filters");
  return data; // { categories, branches, warehouses, stockStatuses }
}

export async function fetchInventoryRecord(id) {
  const { data } = await api.get(`/inventory/${id}`);
  return data.record;
}
