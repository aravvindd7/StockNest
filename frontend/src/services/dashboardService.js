import api from "./api";

export async function fetchDashboardSummary() {
  const { data } = await api.get("/dashboard/summary");
  return data; // { role, kpis }
}
