import { useCallback, useEffect, useMemo, useState } from "react";
import DataTable from "../DataTable";
import FilterManager from "../table/FilterManager";
import { useTableFilters } from "../table/useTableFilters";
import { DISTRIBUTION_OPTIONS, createDistributionFilterOptions, fetchTransfers } from "../../services/distributionService";
import { SearchIcon } from "./DistributionRecommendations";
import { ErrorBanner, StatusBadge, dateTime, describeError, num } from "./shared";

const getFilterOptions = createDistributionFilterOptions("transferStatus");

const FILTER_CONFIG = [
  { key: "status", label: "Status" },
  { key: "transferId", label: "Transfer ID" },
  { key: "materialNo", label: "Material" },
  { key: "sourceDepotId", label: "Source Depot" },
  { key: "destinationDepotId", label: "Destination Depot" },
  { key: "requestedQuantity", label: "Requested Qty" },
];

const ADVANCED_FIELDS = [
  { key: "status", label: "Status", type: "text", staticOptions: DISTRIBUTION_OPTIONS.transferStatus },
  { key: "materialNo", label: "Material", type: "text", fetchOptions: (s) => getFilterOptions("materialNo", s) },
  { key: "sourceDepotId", label: "Source Depot", type: "text", fetchOptions: (s) => getFilterOptions("sourceDepotId", s) },
  { key: "destinationDepotId", label: "Destination Depot", type: "text", fetchOptions: (s) => getFilterOptions("destinationDepotId", s) },
  { key: "requestedQuantity", label: "Requested Qty", type: "number" },
];

/** Operational queues — each is just a status filter on the same list. */
export const TRANSFER_QUEUES = [
  ["active", "Active", ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT"]],
  ["approval", "Needs Approval", ["REQUESTED"]],
  ["dispatch", "Ready to Dispatch", ["APPROVED"]],
  ["moving", "In Motion", ["DISPATCHED", "IN_TRANSIT"]],
  ["received", "Received", ["RECEIVED"]],
  ["cancelled", "Cancelled", ["CANCELLED"]],
  ["all", "All", null],
];

const PAGE_SIZE = 50;

/**
 * Transfers list — server-side search / filters / sort / pagination on
 * GET /distribution/transfers. Lifecycle actions live in the transfer drawer.
 */
export default function DistributionTransfers({ depotNames, reloadToken, initialQueue = "active", onOpen }) {
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ data: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const applyQueue = useCallback((key) => {
    const statuses = TRANSFER_QUEUES.find((q) => q[0] === key)?.[2];
    filterState.setFilterValue("status", statuses ? { mode: "values", values: statuses } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => applyQueue(initialQueue), [initialQueue, applyQueue]);
  useEffect(() => setPage(1), [filterState.queryParams]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchTransfers({ ...filterState.queryParams, page, limit: PAGE_SIZE }));
    } catch (err) {
      setError(describeError(err, "Could not load transfers."));
    } finally {
      setLoading(false);
    }
  }, [filterState.queryParams, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load, reloadToken]);

  const current = filterState.filters.status;
  const currentKey = (() => {
    if (!current) return "all";
    const vals = [...(current.values || [])].sort().join();
    return TRANSFER_QUEUES.find((q) => q[2] && [...q[2]].sort().join() === vals)?.[0] || "custom";
  })();

  const depotCell = (id) => (
    <div className="leading-tight">
      <div className="font-mono text-[#3B4666]">{id}</div>
      {depotNames?.[id] && <div className="text-[11px] text-gray-400">{depotNames[id]}</div>}
    </div>
  );
  const qty = (v) => <span className={v === undefined || v === null ? "text-gray-300" : "font-semibold"}>{num(v)}</span>;

  const columns = useMemo(() => [
    { key: "transferId", label: "Transfer ID", sticky: true, stickyOffset: 0, width: 116, filterType: "text", render: (r) => <span className="font-mono font-semibold text-primary">{r.transferId}</span> },
    { key: "materialNo", label: "Material", filterType: "text", multiselect: true, render: (r) => <span className="font-mono font-semibold">{r.materialNo}</span> },
    { key: "sourceDepotId", label: "Source", filterType: "text", multiselect: true, render: (r) => depotCell(r.sourceDepotId) },
    { key: "destinationDepotId", label: "Destination", filterType: "text", multiselect: true, render: (r) => depotCell(r.destinationDepotId) },
    { key: "requestedQuantity", label: "Requested", filterType: "number", className: "text-right", render: (r) => qty(r.requestedQuantity) },
    { key: "approvedQuantity", label: "Approved", sortable: false, className: "text-right", render: (r) => qty(r.approvedQuantity) },
    { key: "dispatchedQuantity", label: "Dispatched", sortable: false, className: "text-right", render: (r) => qty(r.dispatchedQuantity) },
    {
      key: "receivedQuantity",
      label: "Received",
      sortable: false,
      className: "text-right",
      render: (r) => (
        <span>
          {qty(r.receivedQuantity)}
          {r.transitLossQuantity > 0 && <span className="ml-1 text-[11px] font-semibold text-out">(−{num(r.transitLossQuantity)})</span>}
        </span>
      ),
    },
    { key: "status", label: "Status", filterType: "text", multiselect: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: "requestedAt", label: "Requested At", render: (r) => <span className="font-mono text-gray-600">{dateTime(r.requestedAt)}</span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [depotNames]);

  return (
    <div className="flex flex-col gap-4">
      <div className="sn-card flex flex-wrap items-center gap-3 p-4">
        <div className="flex w-72 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <SearchIcon />
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search transfer ID, material or depot…"
            value={filterState.search}
            onChange={(e) => filterState.setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
          {TRANSFER_QUEUES.map(([key, label]) => (
            <button
              key={key}
              onClick={() => applyQueue(key)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition ${currentKey === key ? "bg-white text-primary shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={ADVANCED_FIELDS} />
      <ErrorBanner error={error} onRetry={load} />

      {!error && (
        <DataTable
          columns={columns}
          rows={result.data}
          loading={loading && result.data.length === 0}
          filterState={filterState}
          getFilterOptions={getFilterOptions}
          pagination={result.pagination}
          onPageChange={setPage}
          onRowClick={(r) => onOpen(r._id)}
          emptyMessage={
            filterState.hasActiveFilters
              ? "No transfers in this view. Transfers are created when a recommendation is approved."
              : "No transfers yet. Approve a recommendation to create one."
          }
        />
      )}
      {loading && result.data.length > 0 && <div className="-mt-2 text-right text-xs text-gray-400">Refreshing…</div>}
    </div>
  );
}
