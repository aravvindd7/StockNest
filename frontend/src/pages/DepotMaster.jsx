import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataTable from "../components/DataTable";
import DepotForm from "../components/DepotForm";
import ConfirmDialog from "../components/ConfirmDialog";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { createFilterValuesFetcher } from "../components/table/filterValuesFetcher";
import { fetchDepots, deleteDepot, exportDepotsXlsx } from "../services/depotService";

const dateStr = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const getFilterOptions = createFilterValuesFetcher("/depots");

const FILTER_CONFIG = [
  { key: "depotId", label: "Depot ID" },
  { key: "depotName", label: "Depot Name" },
];

export default function DepotMaster() {
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG, defaultSort: "depotId" });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingDepot, setEditingDepot] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDepots(filterState.queryParams);
      setRows(result.data);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load depots. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams]);

  useEffect(() => {
    const t = setTimeout(load, 250); // light debounce on the search box
    return () => clearTimeout(t);
  }, [load]);

  // Auto-clear the success banner after a few seconds.
  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(t);
  }, [successMessage]);

  function handleSaved() {
    setFormOpen(false);
    setSuccessMessage(editingDepot ? "Depot updated successfully." : "Depot created successfully.");
    setEditingDepot(null);
    load();
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    try {
      await deleteDepot(deleteTarget._id);
      setDeleteTarget(null);
      setSuccessMessage("Depot deleted successfully.");
      load();
    } catch (err) {
      setError(err.response?.data?.message || "Could not delete this depot.");
      setDeleteTarget(null);
    }
  }

  const COLUMNS = [
    { key: "depotId", label: "Depot ID", filterType: "text", multiselect: true, render: (r) => <span className="font-mono text-[#3B4666]">{r.depotId}</span> },
    { key: "depotName", label: "Depot Name", filterType: "text", multiselect: true },
    { key: "createdAt", label: "Created", render: (r) => <span className="font-mono">{dateStr(r.createdAt)}</span> },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <IconButton title="Edit" onClick={() => { setEditingDepot(r); setFormOpen(true); }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </IconButton>
          <IconButton title="Delete" danger onClick={() => setDeleteTarget(r)}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
          </IconButton>
        </div>
      ),
    },
  ];

  // No static-option fields make sense for Depot (both filterable fields
  // are free-text with unbounded cardinality) — the drawer still works,
  // it just uses the same live-search list as the column icons.
  const advancedFields = [
    { key: "depotId", label: "Depot ID", type: "text", fetchOptions: (s) => getFilterOptions("depotId", s) },
    { key: "depotName", label: "Depot Name", type: "text", fetchOptions: (s) => getFilterOptions("depotName", s) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Depot Master</h2>
          <p className="text-sm text-gray-500">Admin-only. Manage depot records — Depot ID and Depot Name.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => { setEditingDepot(null); setFormOpen(true); }} className="sn-btn-primary">
            <PlusIcon /> Add Depot
          </button>
          <Link to="/depot-master/import" className="sn-btn-ghost">
            <UploadIcon /> Import Excel
          </Link>
          <button onClick={() => exportDepotsXlsx()} className="sn-btn-ghost">
            <DownloadIcon /> Export
          </button>
          <Link to="/depot-master/import-history" className="sn-btn-ghost">
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
            placeholder="Search Depot ID or Depot Name…"
            value={filterState.search}
            onChange={(e) => filterState.setSearch(e.target.value)}
          />
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={advancedFields} />

      {loading && <div className="sn-card p-10 text-center text-sm text-gray-400">Loading depots…</div>}

      {!loading && rows.length === 0 && !error && (
        <div className="sn-card flex flex-col items-center gap-2 p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 9.75L12 4l9 5.75V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.75z" />
            </svg>
          </div>
          <h3 className="font-display text-base font-bold">No depots found</h3>
          <p className="text-sm text-gray-500">
            {filterState.hasActiveFilters ? "No depots match your search or filters." : 'Click "Add Depot" to create your first depot.'}
          </p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <DataTable columns={COLUMNS} rows={rows} loading={false} filterState={filterState} getFilterOptions={getFilterOptions} />
      )}

      <DepotForm
        open={formOpen}
        depot={editingDepot}
        onClose={() => setFormOpen(false)}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Are you sure you want to delete this depot?"
        message={deleteTarget ? `Depot ID: ${deleteTarget.depotId}\nDepot Name: ${deleteTarget.depotName}\nThis action cannot be undone.` : ""}
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
