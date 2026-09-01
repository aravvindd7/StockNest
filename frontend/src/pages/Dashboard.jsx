import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { fetchDashboardSummary } from "../services/dashboardService";

function KpiCard({ label, value, color }) {
  return (
    <div className="sn-card relative overflow-hidden p-4">
      <div className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
      <div className="font-display text-2xl font-bold text-[#1B2338]">{value}</div>
      <div className="mt-1 text-xs text-gray-500">{label}</div>
    </div>
  );
}

const fmtNum = (n) => Number(n).toLocaleString("en-IN");
const fmtMoney = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDashboardSummary()
      .then(setSummary)
      .catch(() => setError("Could not load dashboard data. Is the backend running?"));
  }, []);

  const k = summary?.kpis;

  const commonCards = k
    ? [
        { label: "Total Products", value: fmtNum(k.totalProducts), color: "#1B5FBF" },
        { label: "Total Available Stock", value: fmtNum(k.totalAvailableStock), color: "#16A34A" },
        { label: "Low Stock Items", value: fmtNum(k.lowStockItems), color: "#F59E0B" },
        { label: "Out of Stock Items", value: fmtNum(k.outOfStockItems), color: "#DC2626" },
        { label: "Total Branches", value: fmtNum(k.totalBranches), color: "#0EA5E9" },
        { label: "Total Warehouses", value: fmtNum(k.totalWarehouses), color: "#0EA5E9" },
        { label: "Inventory Value", value: fmtMoney(k.inventoryValue), color: "#1B5FBF" },
      ]
    : [];

  const adminCards = k
    ? [
        { label: "Total Materials", value: fmtNum(k.totalMaterials), color: "#1B5FBF" },
        { label: "Active Materials", value: fmtNum(k.activeMaterials), color: "#16A34A" },
        { label: "Discontinued Materials", value: fmtNum(k.discontinuedMaterials), color: "#7F1D1D" },
        { label: "Import Batches Recorded", value: fmtNum(k.totalImportBatches), color: "#EAB308" },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-bold">Welcome back, {user?.username}</h2>
        <p className="text-sm text-gray-500">
          Here's what's happening across your {user?.role === "ADMIN" ? "organization" : "branch network"} today.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>
      )}

      {!summary && !error && (
        <div className="text-sm text-gray-500">Loading dashboard…</div>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {commonCards.map((c) => (
              <KpiCard key={c.label} {...c} />
            ))}
          </div>

          {user?.role === "ADMIN" && adminCards.length > 0 && (
            <div>
              <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-gray-500">
                Material Master Overview
              </h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {adminCards.map((c) => (
                  <KpiCard key={c.label} {...c} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="sn-card p-5">
        <h3 className="mb-2 font-display text-sm font-bold uppercase tracking-wide text-gray-500">
          Recent Activity
        </h3>
        <p className="text-sm text-gray-500">
          Activity feed and charts arrive with the Inventory and Reports modules (Steps 12+).
        </p>
      </div>
    </div>
  );
}
