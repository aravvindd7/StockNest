import api from "./api";

/** GET /derived-status → { sources, forecast: { version, status, updatedAt }, distribution: { … } } */
export async function fetchDerivedStatus() {
  const { data } = await api.get("/derived-status");
  return data;
}
