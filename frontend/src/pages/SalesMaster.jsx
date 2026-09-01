import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataTable from "../components/DataTable";
import SalesForm from "../components/SalesForm";
import MonthlyBreakdownDrawer from "../components/MonthlyBreakdownDrawer";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { createFilterValuesFetcher } from "../components/table/filterValuesFetcher";
import { fetchSales, fetchSalesSummary, exportSalesXlsx } from "../services/salesService";
import { SALES_COLUMNS } from "../constants/salesColumns";

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const getFilterOptions = createFilterValuesFetcher("/sales");

/**
 * Sales Master is a full operational ERP data management module (answers
 * "what happened") — it is NOT the same thing as Planning Master (answers
 * "what should we do"). This page has two views over the same underlying
 * monthly record collection, never two different datasets:
 *
 * - Detailed Records (default): every restored ERP field, every column
 *   filterable, sortable, paginated — this is Sales Master's primary,
 *   operational view. Filters here use Apply/Cancel (instant={false},
 *   Phase 5's explicit requirement) rather than the instant-filter
 *   behavior used everywhere else in the app.
 * - Quarterly Summary: Material + Financial Year rows with Q1-Q4 sums,
 *   click a quarter to expand its monthly breakdown — the
 *   forecasting-prep / at-a-glance view, kept from the earlier upgrade.
 *
 * Add Sales / Import / Export / Import History all operate on the same
 * underlying collection regardless of which tab is showing.
 */

// Every visible Sales Master column is filterable, derived from
// SALES_COLUMNS so it can never drift out of sync with the table/model —
// mirrors SALES_FILTER_CONFIG on the backend.
const DETAILED_FILTER_CONFIG = SALES_COLUMNS.map((c) => ({
  key: c.key,
  label: c.label,
  type: c.type === "Number" ? "number" : "text",
}));

const SUMMARY_FILTER_CONFIG = [
  { key: "FinancialYear", label: "Financial Year" },
  { key: "Plant", label: "Plant" },
  { key: "MaterialGroup", label: "Material Group" },
  { key: "ProductionCycle", label: "Production Cycle" },
];

export default function SalesMaster() {
  const [tab, setTab] = useState("detailed"); // "detailed" | "summary"
  const [formOpen, setFormOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);

  const detailedFilters = useTableFilters({ filterConfig: DETAILED_FILTER_CONFIG });
  const summaryFilters = useTableFilters({ filterConfig: SUMMARY_FILTER_CONFIG });

  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(t);
  }, [successMessage]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Sales Master</h2>
          <p className="text-sm text-gray-500">
            Admin-only. Historical sales data management — what happened, in full ERP detail.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setFormOpen(true)} className="sn-btn-primary">
            <PlusIcon /> Add Sales
          </button>
          <Link to="/sales-master/import" className="sn-btn-ghost">
            <UploadIcon /> Import Excel
          </Link>
          <button onClick={() => exportSalesXlsx()} className="sn-btn-ghost">
            <DownloadIcon /> Export
          </button>
          <Link to="/sales-master/import-history" className="sn-btn-ghost">
            <HistoryIcon /> Import History
          </Link>
        </div>
      </div>

      {successMessage && (
        <div className="rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm text-healthy">{successMessage}</div>
      )}

      <div className="flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <TabButton active={tab === "detailed"} onClick={() => setTab("detailed")}>
          Detailed Records
        </TabButton>
        <TabButton active={tab === "summary"} onClick={() => setTab("summary")}>
          Quarterly Summary
        </TabButton>
      </div>

      {tab === "detailed" ? (
        <DetailedRecordsTab filterState={detailedFilters} />
      ) : (
        <QuarterlySummaryTab filterState={summaryFilters} />
      )}

      <SalesForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); setSuccessMessage("Sales record added successfully."); window.dispatchEvent(new Event("sales-updated")); }}
      />
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-4 py-1.5 text-sm font-semibold transition ${
        active ? "bg-white text-primary shadow-sm" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {children}
    </button>
  );
}

function DetailedRecordsTab({ filterState }) {
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 50 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSales({ ...filterState.queryParams, page, limit: pagination.limit });
      setRows(result.data);
      setPagination(result.pagination);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load sales records. Is the backend running?");
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
    window.addEventListener("sales-updated", load);
    return () => window.removeEventListener("sales-updated", load);
  }, [load]);

  // First three columns frozen while horizontally scrolling — 19 columns
  // need this to stay usable, same pattern as Stock/Material Master.
  const STICKY_KEYS = ["MatNo", "Material", "Plant"];
  const MULTI_KEYS = ["MatNo", "Material", "Plant", "FinancialYear", "Month", "Quarter", "Status"];
  let stickyOffset = 0;
  const COLUMNS = SALES_COLUMNS.map((col) => {
    const sticky = STICKY_KEYS.includes(col.key);
    const column = {
      key: col.key,
      label: col.label,
      sortable: false,
      sticky,
      multiselect: MULTI_KEYS.includes(col.key),
      width: sticky ? 140 : undefined,
      stickyOffset: sticky ? stickyOffset : undefined,
      filterType: col.type === "Number" ? "number" : "text",
      render: (r) => {
        const v = r[col.key];
        if (col.type === "Number") return <span className="font-mono">{num(v)}</span>;
        return v || "—";
      },
    };
    if (sticky) stickyOffset += 140;
    return column;
  });

  // The Advanced Filter drawer surfaces the fields worth promoting;
  // every other column is still filterable via its own column icon.
  const advancedFields = [
    { key: "MatNo", label: "Material Number", type: "text", fetchOptions: (s) => getFilterOptions("MatNo", s) },
    { key: "Material", label: "Material Description", type: "text", fetchOptions: (s) => getFilterOptions("Material", s) },
    { key: "MatGroupName", label: "Material Group", type: "text", fetchOptions: (s) => getFilterOptions("MatGroupName", s) },
    { key: "Plant", label: "Plant", type: "text", fetchOptions: (s) => getFilterOptions("Plant", s) },
    { key: "FinancialYear", label: "Financial Year", type: "text", fetchOptions: (s) => getFilterOptions("FinancialYear", s) },
    { key: "Month", label: "Month", type: "text", fetchOptions: (s) => getFilterOptions("Month", s) },
    { key: "Quarter", label: "Quarter", type: "text", staticOptions: QUARTERS },
    { key: "ProductionCycle", label: "Production Cycle", type: "text", fetchOptions: (s) => getFilterOptions("ProductionCycle", s) },
    { key: "Status", label: "Status", type: "text", staticOptions: ["Active", "Hold"] },
  ];

  return (
    <div className="flex flex-col gap-6">
      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card p-4">
        <div className="flex max-w-sm items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search Material Number, Description, or Plant…"
            value={filterState.search}
            onChange={(e) => { filterState.setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={advancedFields} instant={false} />

      <DataTable
        columns={COLUMNS}
        rows={rows}
        loading={loading}
        filterState={filterState}
        getFilterOptions={getFilterOptions}
        instant={false}
        pagination={pagination}
        onPageChange={setPage}
      />
    </div>
  );
}

function QuarterlySummaryTab({ filterState }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawerTarget, setDrawerTarget] = useState(null); // { materialNo, materialName, financialYear, quarter } | null

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSalesSummary(filterState.queryParams);
      setRows(data);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load sales data. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    window.addEventListener("sales-updated", load);
    return () => window.removeEventListener("sales-updated", load);
  }, [load]);

  const advancedFields = [
    { key: "FinancialYear", label: "Financial Year", type: "text", fetchOptions: (s) => getFilterOptions("FinancialYear", s) },
    { key: "Plant", label: "Plant", type: "text", fetchOptions: (s) => getFilterOptions("Plant", s) },
    { key: "MaterialGroup", label: "Material Group", type: "text", fetchOptions: (s) => getFilterOptions("MaterialGroup", s) },
    { key: "ProductionCycle", label: "Production Cycle", type: "text", fetchOptions: (s) => getFilterOptions("ProductionCycle", s) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-gray-500">
        Quarterly view of the same monthly records — click any quarter to see the month-by-month breakdown.
      </p>

      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card p-4">
        <div className="flex max-w-sm items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search Material Number or Name…"
            value={filterState.search}
            onChange={(e) => filterState.setSearch(e.target.value)}
          />
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={advancedFields} />

      <div className="sn-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max whitespace-nowrap text-left text-[12.5px]">
            <thead>
              <tr className="bg-navy text-[11px] font-semibold uppercase tracking-wide text-[#C9D3EA]">
                <th className="px-3.5 py-2.5">Material Number</th>
                <th className="px-3.5 py-2.5">Material Name</th>
                <th className="px-3.5 py-2.5">Financial Year</th>
                {QUARTERS.map((q) => (
                  <th key={q} className="border-l border-white/10 px-3.5 py-2.5 text-right">
                    {q}
                  </th>
                ))}
                <th className="border-l border-white/10 bg-navy-2 px-3.5 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    No sales data match your search or filters.
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((row, i) => (
                  <tr
                    key={`${row.materialNo}-${row.financialYear}`}
                    className={`border-b border-gray-100 ${i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white"}`}
                  >
                    <td className="px-3.5 py-2.5 font-mono text-[#3B4666]">{row.materialNo}</td>
                    <td className="px-3.5 py-2.5">{row.materialName}</td>
                    <td className="px-3.5 py-2.5 font-mono">{row.financialYear}</td>
                    {QUARTERS.map((q) => (
                      <td
                        key={q}
                        onClick={() =>
                          setDrawerTarget({
                            materialNo: row.materialNo,
                            materialName: row.materialName,
                            financialYear: row.financialYear,
                            quarter: q,
                          })
                        }
                        className="cursor-pointer border-l border-gray-100 px-3.5 py-2.5 text-right font-mono transition hover:bg-primary/5 hover:text-primary"
                        title={`Click for ${q} monthly breakdown`}
                      >
                        {num(row[q])}
                      </td>
                    ))}
                    <td className="border-l border-gray-100 bg-primary/5 px-3.5 py-2.5 text-right font-mono font-bold text-primary">
                      {num(row.total)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <MonthlyBreakdownDrawer
        open={Boolean(drawerTarget)}
        materialNo={drawerTarget?.materialNo}
        materialName={drawerTarget?.materialName}
        financialYear={drawerTarget?.financialYear}
        quarter={drawerTarget?.quarter}
        onClose={() => setDrawerTarget(null)}
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
