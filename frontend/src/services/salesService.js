import api from "./api";

export async function fetchSales(params = {}) {
  const cleaned = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) cleaned[k] = v;
  });
  const { data } = await api.get("/sales", { params: cleaned });
  return data; // { data, pagination }
}

/** The Sales Master main table's data source (Phase 1) — one row per Material + Financial Year, with Q1-Q4 sums. */
export async function fetchSalesSummary(params = {}) {
  const cleaned = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) cleaned[k] = v;
  });
  const { data } = await api.get("/sales/summary", { params: cleaned });
  return data.data;
}

/** The expandable-quarter-detail data source — fetched only when a quarter cell is clicked. */
export async function fetchSalesMonthlyBreakdown(materialNo, financialYear, quarter) {
  const { data } = await api.get("/sales/monthly", { params: { materialNo, financialYear, quarter } });
  return data; // { materialNo, financialYear, quarter, months, total }
}

export async function createSales(payload) {
  const { data } = await api.post("/sales", payload);
  return data.sales;
}

/** Triggers a browser download of the raw monthly Sales Master dataset as a real .xlsx file (12 columns). */
export async function exportSalesXlsx() {
  const response = await api.get("/sales/export", { responseType: "blob" });
  const url = URL.createObjectURL(
    new Blob([response.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "sales_master.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
