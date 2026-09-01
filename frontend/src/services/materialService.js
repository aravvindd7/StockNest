import api from "./api";

function cleanParams(params) {
  const out = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) out[k] = v;
  });
  return out;
}

export async function fetchMaterials(params = {}) {
  const { data } = await api.get("/materials", { params: cleanParams(params) });
  return data; // { data, pagination }
}

export async function fetchMaterialFilterOptions() {
  const { data } = await api.get("/materials/filters");
  return data; // { statuses, types, models }
}

export async function fetchMaterialById(id) {
  const { data } = await api.get(`/materials/${id}`);
  return data.material;
}

export async function createMaterial(payload) {
  const { data } = await api.post("/materials", payload);
  return data.material;
}

export async function updateMaterial(id, payload) {
  const { data } = await api.put(`/materials/${id}`, payload);
  return data.material;
}

export async function deleteMaterial(id) {
  const { data } = await api.delete(`/materials/${id}`);
  return data;
}

/** Triggers a browser download of the active Material Master dataset as a real .xlsx file. */
export async function exportMaterialsCsv(params = {}) {
  const response = await api.get("/materials/export", {
    params: cleanParams(params),
    responseType: "blob",
  });
  const url = URL.createObjectURL(
    new Blob([response.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "material_master.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
