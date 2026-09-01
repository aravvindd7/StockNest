import { useEffect, useState, useCallback } from "react";
import { fetchInventory, fetchInventoryFilterOptions } from "../services/inventoryService";
import DataTable from "../components/DataTable";

const money = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const num = (n) => Number(n).toLocaleString("en-IN");
const dateStr = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const STATUS_STYLES = {
  "IN STOCK": "bg-healthy/10 text-healthy",
  "LOW STOCK": "bg-low/15 text-low",
  "OUT OF STOCK": "bg-out/10 text-out",
  OVERSTOCK: "bg-accent/10 text-accent",
};

function StatusBadge({ value }) {
  return (
    <span className={`sn-badge ${STATUS_STYLES[value] || "bg-gray-100 text-gray-600"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {value}
    </span>
  );
}

const EMPTY_FILTERS = {
  materialNo: "",
  description: "",
  model: "",
  branch: "",
  warehouse: "",
  stockStatus: "",
  minQty: "",
  maxQty: "",
};

const COLUMNS = [
  { key: "materialNo", label: "Material No", render: (r) => <span className="font-mono text-[#3B4666]">{r.materialNo}</span> },
  { key: "description", label: "Description" },
  { key: "model", label: "Model" },
  { key: "branch", label: "Branch" },
  { key: "warehouse", label: "Warehouse" },
  { key: "currentStock", label: "Current Stock", render: (r) => <span className="font-mono">{num(r.currentStock)}</span> },
  { key: "reservedStock", label: "Reserved", render: (r) => <span className="font-mono">{num(r.reservedStock)}</span> },
  { key: "availableStock", label: "Available", render: (r) => <span className="font-mono">{num(r.availableStock)}</span> },
  { key: "damagedStock", label: "Damaged", render: (r) => <span className="font-mono">{num(r.damagedStock)}</span> },
  { key: "returnedStock", label: "Returned", render: (r) => <span className="font-mono">{num(r.returnedStock)}</span> },
  { key: "reorderLevel", label: "Reorder Level", render: (r) => <span className="font-mono">{num(r.reorderLevel)}</span> },
  { key: "maximumCapacity", label: "Max Capacity", render: (r) => <span className="font-mono">{num(r.maximumCapacity)}</span> },
  { key: "inventoryValue", label: "Inventory Value", render: (r) => <span className="font-mono">{money(r.inventoryValue)}</span> },
  { key: "stockStatus", label: "Stock Status", render: (r) => <StatusBadge value={r.stockStatus} /> },
  { key: "lastRestocked", label: "Last Restocked", render: (r) => <span className="font-mono">{dateStr(r.lastRestocked)}</span> },
  { key: "lastUpdated", label: "Last Updated", render: (r) => <span className="font-mono">{dateStr(r.lastUpdated)}</span> },
];

export default function Inventory() {
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState({ branches: [], warehouses: [], stockStatuses: [] });

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 25 });
  const [sort, setSort] = useState({ sortBy: "materialNo", sortDir: "asc" });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);

  // Filter dropdown options (categories/branches/warehouses) load once.
  useEffect(() => {
    fetchInventoryFilterOptions().then(setOptions).catch(() => {});
  }, []);

  // Debounce the free-text search box so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setPage(1), 350);
    return () => clearTimeout(t);
  }, [search]);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchInventory({
        ...appliedFilters,
        search,
        page,
        limit: pagination.limit,
        sortBy: sort.sortBy,
        sortDir: sort.sortDir,
      });
      setRows(result.data);
      setSummary(result.summary);
      setPagination(result.pagination);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load inventory. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters, search, page, sort]);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  function handleApply() {
    setAppliedFilters(draftFilters);
    setPage(1);
  }
  function handleReset() {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setSearch("");
    setPage(1);
  }
  function handleSortChange(key) {
    setSort((prev) =>
      prev.sortBy === key ? { sortBy: key, sortDir: prev.sortDir === "asc" ? "desc" : "asc" } : { sortBy: key, sortDir: "asc" }
    );
  }

  const kpis = summary
    ? [
        { label: "Records Found", value: num(summary.totalRecords), color: "#1B5FBF" },
        { label: "Distinct Materials", value: num(summary.distinctMaterials), color: "#0EA5E9" },
        { label: "Branches Covered", value: num(summary.distinctBranches), color: "#0EA5E9" },
        { label: "Available Stock", value: num(summary.totalAvailableStock), color: "#16A34A" },
        { label: "Inventory Value", value: money(summary.totalInventoryValue), color: "#1B5FBF" },
        { label: "Low Stock", value: num(summary.lowStockCount), color: "#F59E0B" },
        { label: "Out of Stock", value: num(summary.outOfStockCount), color: "#DC2626" },
        { label: "Overstock", value: num(summary.overstockCount), color: "#EAB308" },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Inventory</h2>
          <p className="text-sm text-gray-500">Branch-wise stock across all locations — read access for every role.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-56 border-none text-sm outline-none"
            placeholder="Search material no, name, branch…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {kpis.map((k) => (
            <div key={k.label} className="sn-card relative overflow-hidden p-3">
              <div className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: k.color }} />
              <div className="font-display text-lg font-bold">{k.value}</div>
              <div className="mt-0.5 text-[11px] text-gray-500">{k.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="sn-card">
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-4 font-display text-sm font-semibold"
        >
          <span className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-primary">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M6 8h12M9 12h6M11 16h2" />
            </svg>
            Filters
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`h-4 w-4 text-gray-400 transition-transform ${panelOpen ? "" : "-rotate-90"}`}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {panelOpen && (
          <div className="border-t border-gray-200 px-5 pb-5 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Material No">
                <input
                  className="sn-input"
                  value={draftFilters.materialNo}
                  onChange={(e) => setDraftFilters({ ...draftFilters, materialNo: e.target.value })}
                  placeholder="MAT0001"
                />
              </Field>
              <Field label="Description">
                <input
                  className="sn-input"
                  value={draftFilters.description}
                  onChange={(e) => setDraftFilters({ ...draftFilters, description: e.target.value })}
                />
              </Field>
              <Field label="Model">
                <input
                  className="sn-input"
                  value={draftFilters.model}
                  onChange={(e) => setDraftFilters({ ...draftFilters, model: e.target.value })}
                />
              </Field>

              <Field label="Branch">
                <select
                  className="sn-input"
                  value={draftFilters.branch}
                  onChange={(e) => setDraftFilters({ ...draftFilters, branch: e.target.value })}
                >
                  <option value="">All Branches</option>
                  {options.branches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </Field>
              <Field label="Warehouse">
                <select
                  className="sn-input"
                  value={draftFilters.warehouse}
                  onChange={(e) => setDraftFilters({ ...draftFilters, warehouse: e.target.value })}
                >
                  <option value="">All Warehouses</option>
                  {options.warehouses.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </select>
              </Field>
              <Field label="Stock Status">
                <select
                  className="sn-input"
                  value={draftFilters.stockStatus}
                  onChange={(e) => setDraftFilters({ ...draftFilters, stockStatus: e.target.value })}
                >
                  <option value="">All</option>
                  {options.stockStatuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>

              <Field label="Min Quantity">
                <input
                  type="number"
                  className="sn-input"
                  value={draftFilters.minQty}
                  onChange={(e) => setDraftFilters({ ...draftFilters, minQty: e.target.value })}
                  placeholder="0"
                />
              </Field>
              <Field label="Max Quantity">
                <input
                  type="number"
                  className="sn-input"
                  value={draftFilters.maxQty}
                  onChange={(e) => setDraftFilters({ ...draftFilters, maxQty: e.target.value })}
                  placeholder="500"
                />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={handleApply} className="sn-btn-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
                </svg>
                Apply Filters
              </button>
              <button onClick={handleReset} className="sn-btn-ghost">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582M20 20v-5h-.581M5.5 9A7.5 7.5 0 0119 12M18.5 15a7.5 7.5 0 01-13.5-3" />
                </svg>
                Reset Filters
              </button>
            </div>
          </div>
        )}
      </div>

      <DataTable
        columns={COLUMNS}
        rows={rows}
        loading={loading}
        sort={sort}
        onSortChange={handleSortChange}
        pagination={pagination}
        onPageChange={setPage}
      />
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</label>
      {children}
    </div>
  );
}
