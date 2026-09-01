import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataTable from "../components/DataTable";
import MaterialForm from "../components/MaterialForm";
import ConfirmDialog from "../components/ConfirmDialog";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { createFilterValuesFetcher } from "../components/table/filterValuesFetcher";
import {
  fetchMaterials,
  fetchMaterialFilterOptions,
  deleteMaterial,
  exportMaterialsCsv,
} from "../services/materialService";

const money = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const num = (n) => Number(n).toLocaleString("en-IN");
const dateStr = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const getFilterOptions = createFilterValuesFetcher("/materials");

function StatusBadge({ value }) {
  const cls = value === "STD" ? "bg-healthy/10 text-healthy" : "bg-out/10 text-out";
  return (
    <span className={`sn-badge ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {value}
    </span>
  );
}

const FILTER_CONFIG = [
  { key: "materialNo", label: "Material No" },
  { key: "description", label: "Description" },
  { key: "model", label: "Model" },
  { key: "status", label: "Status" },
  { key: "type", label: "FG/RM" },
  { key: "invCost", label: "Inv Cost" },
  { key: "moq", label: "MOQ" },
];

export default function MaterialMaster() {
  const [options, setOptions] = useState({ statuses: [], types: [] });

  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG, defaultSort: "materialNo" });
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 25 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    fetchMaterialFilterOptions().then(setOptions).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMaterials({ ...filterState.queryParams, page, limit: pagination.limit });
      setRows(result.data);
      setPagination(result.pagination);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load materials. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    try {
      await deleteMaterial(deleteTarget._id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setError(err.response?.data?.message || "Could not delete this material.");
      setDeleteTarget(null);
    }
  }

  const COLUMNS = [
    {
      key: "materialNo",
      label: "Material No",
      sticky: true,
      stickyOffset: 0,
      filterType: "text",
      render: (r) => <span className="font-mono text-[#3B4666]">{r.materialNo}</span>,
    },
    { key: "description", label: "Description", sticky: true, stickyOffset: 140, filterType: "text" },
    { key: "model", label: "Model", sticky: true, stickyOffset: 380, filterType: "text" },
    { key: "status", label: "Status", filterType: "text", multiselect: true, render: (r) => <StatusBadge value={r.status} /> },
    { key: "invCost", label: "Inv Cost", filterType: "number", render: (r) => <span className="font-mono">{money(r.invCost)}</span> },
    { key: "moq", label: "MOQ", filterType: "number", render: (r) => <span className="font-mono">{num(r.moq)}</span> },
    { key: "type", label: "FG/RM", filterType: "text" },
    { key: "updatedAt", label: "Last Updated", render: (r) => <span className="font-mono">{dateStr(r.updatedAt)}</span> },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <IconButton title="Edit" onClick={() => { setEditingMaterial(r); setFormOpen(true); }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </IconButton>
          <IconButton title="Delete" danger onClick={() => setDeleteTarget(r)}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
          </IconButton>
        </div>
      ),
    },
  ];

  const advancedFields = [
    { key: "status", label: "Status", type: "text", staticOptions: options.statuses },
    { key: "type", label: "FG/RM", type: "text", staticOptions: options.types },
    { key: "invCost", label: "Inv Cost", type: "number" },
    { key: "moq", label: "MOQ", type: "number" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Material Master</h2>
          <p className="text-sm text-gray-500">Admin-only. Manage the material catalog and bulk-import new materials.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => { setEditingMaterial(null); setFormOpen(true); }} className="sn-btn-primary">
            <PlusIcon /> Add Material
          </button>
          <Link to="/material-master/import" className="sn-btn-ghost">
            <UploadIcon /> Import Excel
          </Link>
          <button onClick={() => exportMaterialsCsv(filterState.queryParams)} className="sn-btn-ghost">
            <DownloadIcon /> Export
          </button>
          <Link to="/material-master/import-history" className="sn-btn-ghost">
            <HistoryIcon /> Import History
          </Link>
        </div>
      </div>

      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card p-4">
        <div className="flex max-w-md items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search Material No, Description, Model…"
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

      <MaterialForm
        open={formOpen}
        material={editingMaterial}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); load(); }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Are you sure you want to delete this material?"
        message={deleteTarget ? `Material: ${deleteTarget.materialNo} — ${deleteTarget.description}. This action deactivates the material; it will no longer appear in search or Inventory filters.` : ""}
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function IconButton({ title, danger, onClick, children }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white ${danger ? "text-out hover:border-out" : "text-gray-500 hover:border-primary hover:text-primary"}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
        {children}
      </svg>
    </button>
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
