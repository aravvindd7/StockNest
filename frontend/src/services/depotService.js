import api from "./api";

export async function fetchDepots(params = {}) {
  const cleaned = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) cleaned[k] = v;
  });
  const { data } = await api.get("/depots", { params: cleaned });
  return data; // { data }
}

export async function createDepot(payload) {
  const { data } = await api.post("/depots", payload);
  return data.depot;
}

export async function updateDepot(id, payload) {
  const { data } = await api.put(`/depots/${id}`, payload);
  return data.depot;
}

export async function deleteDepot(id) {
  const { data } = await api.delete(`/depots/${id}`);
  return data;
}

/** Triggers a browser download of the active Depot Master dataset as a real .xlsx file. */
export async function exportDepotsXlsx() {
  const response = await api.get("/depots/export", { responseType: "blob" });
  const url = URL.createObjectURL(
    new Blob([response.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "depot_master.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
