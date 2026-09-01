import api from "./api";

export async function fetchStock(params = {}) {
  const cleaned = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) cleaned[k] = v;
  });
  const { data } = await api.get("/stock", { params: cleaned });
  return data; // { data, pagination }
}

export async function createStock(payload) {
  const { data } = await api.post("/stock", payload);
  return data.stock;
}

/** Triggers a browser download of the active Stock Master dataset as a real .xlsx file (43 columns). */
export async function exportStockXlsx() {
  const response = await api.get("/stock/export", { responseType: "blob" });
  const url = URL.createObjectURL(
    new Blob([response.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "stock_master.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
