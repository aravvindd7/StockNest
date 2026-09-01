import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataTable from "../components/DataTable";
import StockForm from "../components/StockForm";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { createFilterValuesFetcher } from "../components/table/filterValuesFetcher";
import { fetchStock, exportStockXlsx } from "../services/stockService";
import { STOCK_COLUMNS } from "../constants/stockColumns";

const dateStr = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

const getFilterOptions = createFilterValuesFetcher("/stock");

// Every visible Stock Master column is filterable, derived from
// STOCK_COLUMNS so it can never drift out of sync with the table/model —
// mirrors STOCK_FILTER_CONFIG on the backend. Date-type columns
// (StockDate, createdOn) are excluded: the spec's Filter Types only
// define Text/Dropdown/Numeric behavior, no Date filter. Safety Stock and
// Stock Status aren't columns here at all (see stockController.js) so
// there's nothing to add for them.
const FILTER_CONFIG = STOCK_COLUMNS.filter((c) => c.type !== "Date").map((c) => ({
  key: c.key,
  label: c.key === "PlantName" ? "Depot" : c.label,
  type: c.type === "Number" ? "number" : "text",
}));
const FILTER_TYPE_BY_KEY = Object.fromEntries(FILTER_CONFIG.map((f) => [f.key, f.type]));

export default function StockMaster() {
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG });
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 50 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStock({ ...filterState.queryParams, page, limit: pagination.limit });
      setRows(result.data);
      setPagination(result.pagination);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load stock records. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(t);
  }, [successMessage]);

  // First three columns (PlantName, MatNo, Material) frozen while
  // horizontally scrolling — 43 columns need this to stay usable
  // (Section 16: "keep the table usable and readable").
  const STICKY_KEYS = ["PlantName", "MatNo", "Material"];
  let stickyOffset = 0;
  const MULTI_KEYS = ["MatNo", "Material", "PlantName"];
  const COLUMNS = STOCK_COLUMNS.map((col) => {
    const sticky = STICKY_KEYS.includes(col.key);
    const column = {
      key: col.key,
      label: col.label,
      sortable: false,
      sticky,
      multiselect: MULTI_KEYS.includes(col.key),
      width: sticky ? 140 : undefined,
      stickyOffset: sticky ? stickyOffset : undefined,
      filterType: FILTER_TYPE_BY_KEY[col.key],
      render: (r) => {
        const v = r[col.key];
        if (col.type === "Date") return <span className="font-mono">{dateStr(v)}</span>;
        if (col.type === "Number") return <span className="font-mono">{num(v)}</span>;
        return v || "—";
      },
    };
    if (sticky) stickyOffset += 140;
    return column;
  });

  // The Advanced Filter drawer surfaces the fields the module spec calls
  // out explicitly (Material Number/Name, Depot, Current Stock); every
  // other Stock Master column is still filterable via its own column
  // icon (see FILTER_CONFIG above) — the drawer isn't meant to duplicate
  // all 40+ columns, just the ones worth promoting.
  const advancedFields = [
    { key: "MatNo", label: "Material Number", type: "text", fetchOptions: (s) => getFilterOptions("MatNo", s) },
    { key: "Material", label: "Material Name", type: "text", fetchOptions: (s) => getFilterOptions("Material", s) },
    { key: "PlantName", label: "Depot", type: "text", fetchOptions: (s) => getFilterOptions("PlantName", s) },
    { key: "TotalStockQty", label: "Current Stock", type: "number" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Stock Master</h2>
          <p className="text-sm text-gray-500">Admin-only. 43 fields — scroll horizontally to see all columns.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setFormOpen(true)} className="sn-btn-primary">
            <PlusIcon /> Add Stock
          </button>
          <Link to="/stock-master/import" className="sn-btn-ghost">
            <UploadIcon /> Import Excel
          </Link>
          <button onClick={() => exportStockXlsx()} className="sn-btn-ghost">
            <DownloadIcon /> Export
          </button>
          <Link to="/stock-master/import-history" className="sn-btn-ghost">
            <HistoryIcon /> Import History
          </Link>
        </div>
      </div>

      {successMessage && (
        <div className="rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm text-healthy">{successMessage}</div>
      )}
      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card p-4">
        <div className="flex max-w-sm items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search Plant, MatNo, or Material…"
            value={filterState.search}
            onChange={(e) => { filterState.setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={advancedFields} />

      <DataTable
        columns={COLUMNS}
        rows={rows}
        loading={loading}
        filterState={filterState}
        getFilterOptions={getFilterOptions}
        pagination={pagination}
        onPageChange={setPage}
      />

      <StockForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); setSuccessMessage("Stock record added successfully."); load(); }}
      />
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5 5 5M12 4v12" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
