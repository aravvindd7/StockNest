import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DataTable from "../DataTable";
import FilterManager from "../table/FilterManager";
import BulkApproveDialog from "./BulkApproveDialog";
import { useTableFilters } from "../table/useTableFilters";
import { DISTRIBUTION_OPTIONS, createDistributionFilterOptions, fetchRecommendations } from "../../services/distributionService";
import {
  DepotIdentity, ErrorBanner, MaterialIdentity, PRIMARY_FILTER_KEYS, PriorityBadge, StatusBadge, TO_COLUMN, dateTime, describeError, forecastPeriodLabel, nameOr,
  num, readSessionPreference, writeSessionPreference,
} from "./shared";

const getFilterOptions = createDistributionFilterOptions("recommendationStatus");

const FILTER_CONFIG = [
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "materialNo", label: "Material" },
  { key: "sourceDepotId", label: "Source Depot" },
  { key: "destinationDepotId", label: "Destination Depot" },
  { key: "generationRunId", label: "Generation Run" },
  { key: "recommendedQuantity", label: "Recommended Qty" },
];

const ADVANCED_FIELDS = [
  { key: "status", label: "Status", type: "text", staticOptions: DISTRIBUTION_OPTIONS.recommendationStatus },
  { key: "priority", label: "Priority", type: "text", staticOptions: DISTRIBUTION_OPTIONS.priority },
  { key: "materialNo", label: "Material", type: "text", fetchOptions: (s) => getFilterOptions("materialNo", s) },
  { key: "sourceDepotId", label: "Source Depot", type: "text", fetchOptions: (s) => getFilterOptions("sourceDepotId", s) },
  { key: "destinationDepotId", label: "Destination Depot", type: "text", fetchOptions: (s) => getFilterOptions("destinationDepotId", s) },
  { key: "recommendedQuantity", label: "Recommended Qty", type: "number" },
];

const QUICK = [
  [null, "All"],
  ["PENDING", "Pending"],
  ["APPROVED", "Approved"],
  ["REJECTED", "Rejected"],
];

// Statuses shown to users. "All" means these; internal lifecycle states
// (SUPERSEDED) stay in the backend for history but are not listed.
const VISIBLE_STATUSES = QUICK.filter(([v]) => v).map(([v]) => v).join(",");

const PAGE_SIZE = 50;

// Primary filter preference (sessionStorage): "ALL" or one of the quick statuses.
const PRIMARY_VALUES = ["ALL", ...QUICK.filter(([v]) => v).map(([v]) => v)];
const statusFilterFor = (primary) => (primary === "ALL" ? null : { mode: "values", values: [primary] });
/** The quick selection a status filter corresponds to — "ALL", a status, or null for a custom (column/advanced) filter. */
function primaryOf(statusFilter) {
  if (!statusFilter) return "ALL";
  return statusFilter.mode === "values" && statusFilter.values.length === 1 && PRIMARY_VALUES.includes(statusFilter.values[0]) ? statusFilter.values[0] : null;
}

/**
 * Recommendations list — server-side search / filters / sort / pagination on
 * GET /distribution/recommendations. Opens on the primary filter remembered for
 * this browser session (ALL by default); rows from the most recent generation
 * run are tagged so new work stands out.
 */
export default function DistributionRecommendations({ depotNames, materialNames, latestRunId, latestRunAt, reloadToken, retryTick, onOpen, onChanged }) {
  // Resolved once, before the first render: stored value if valid, otherwise ALL.
  const [initialPrimary] = useState(() => readSessionPreference(PRIMARY_FILTER_KEYS.recommendations, PRIMARY_VALUES, "ALL"));
  const [initialFilters] = useState(() => {
    const status = statusFilterFor(initialPrimary);
    return status ? { status } : {};
  });
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG, initialFilters });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ data: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  // Remember the primary selection for this session only when the user changes it:
  // compared with the value resolved at mount, so mounting (incl. StrictMode's dev
  // re-run) never writes. Custom column/advanced status filters are not a primary selection.
  const primary = primaryOf(filterState.filters.status);
  const savedPrimary = useRef(initialPrimary);
  useEffect(() => {
    if (primary && primary !== savedPrimary.current) {
      savedPrimary.current = primary;
      writeSessionPreference(PRIMARY_FILTER_KEYS.recommendations, primary);
    }
  }, [primary]);

  useEffect(() => setPage(1), [filterState.queryParams]);

  // Only the newest request may update the list (an older response arriving
  // late — e.g. after a filter change — is ignored). A failed load is retried
  // at the next automatic status check (retryTick), keeping the rows shown.
  const loadSeq = useRef(0);
  const loadFailed = useRef(false);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRecommendations({ status: VISIBLE_STATUSES, ...filterState.queryParams, page, limit: PAGE_SIZE });
      if (seq !== loadSeq.current) return;
      setResult(data);
      loadFailed.current = false;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      loadFailed.current = true;
      setError(describeError(err, "Could not load recommendations."));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filterState.queryParams, page]);

  useEffect(() => {
    if (loadFailed.current) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load, reloadToken]);

  const statusFilter = filterState.filters.status;
  const activeQuick = statusFilter?.mode === "values" && statusFilter.values.length === 1 ? statusFilter.values[0] : statusFilter ? "custom" : null;
  const runFilter = filterState.filters.generationRunId;
  const latestOnly = Boolean(latestRunId && runFilter?.mode === "values" && runFilter.values[0] === latestRunId);

  const depotCell = (id) => <DepotIdentity depotId={id} depotName={depotNames?.[id]} />;

  const columns = useMemo(() => [
    { key: "priority", label: "Priority", sticky: true, stickyOffset: 0, width: 116, filterType: "text", multiselect: true, render: (r) => <PriorityBadge priority={r.priority} /> },
    { key: "materialNo", label: "Material", sticky: true, stickyOffset: 116, width: 232, filterType: "text", multiselect: true, render: (r) => <MaterialIdentity materialNo={r.materialNo} materialName={materialNames?.[r.materialNo]} maxWidth={200} /> },
    { key: "sourceDepotId", label: "Source", filterType: "text", multiselect: true, render: (r) => depotCell(r.sourceDepotId) },
    TO_COLUMN,
    { key: "destinationDepotId", label: "Destination", filterType: "text", multiselect: true, render: (r) => depotCell(r.destinationDepotId) },
    { key: "recommendedQuantity", label: "Recommended Qty", filterType: "number", className: "text-right", render: (r) => <span className="font-display text-[14px] font-bold">{num(r.recommendedQuantity)}</span> },
    { key: "forecastPeriod", label: "Forecast Period", sortable: false, render: (r) => <span className="text-gray-600">{forecastPeriodLabel(r.forecastPeriod)}</span> },
    { key: "status", label: "Status", filterType: "text", multiselect: true, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "generatedAt",
      label: "Created",
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-gray-600">{dateTime(r.generatedAt)}</span>
          {latestRunId && r.generationRunId === latestRunId && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[#0369A1]">Latest run</span>
          )}
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [depotNames, materialNames, latestRunId]);

  const pagination = result.pagination;

  return (
    <div className="flex flex-col gap-4">
      <div className="sn-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex w-72 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <SearchIcon />
            <input
              className="w-full border-none bg-transparent text-sm outline-none"
              placeholder="Search material, depot or reason…"
              value={filterState.search}
              onChange={(e) => filterState.setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            {QUICK.map(([value, label]) => (
              <button
                key={label}
                onClick={() => filterState.setFilterValue("status", value ? { mode: "values", values: [value] } : null)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition ${activeQuick === value ? "bg-white text-primary shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {latestRunId && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={latestOnly}
              onChange={(e) => filterState.setFilterValue("generationRunId", e.target.checked ? { mode: "values", values: [latestRunId] } : null)}
            />
            Latest run only <span className="font-mono text-[11px] text-gray-400">{latestRunId}</span>
            {latestRunAt && <span className="text-[11px] text-gray-400">· generated {dateTime(latestRunAt)}</span>}
          </label>
        )}
      </div>

      {/* Advanced Filter controls what is SEEN; Approve Pending controls what is APPROVED —
          separate controls, and bulk approval never inherits the table's filters. */}
      <div className="flex flex-wrap items-start gap-2">
        <FilterManager filterState={filterState} advancedFields={ADVANCED_FIELDS} />
        <button onClick={() => setBulkOpen(true)} className="sn-btn-ghost sm !border-primary/40 !text-primary hover:!bg-primary/5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Approve Pending
        </button>
      </div>
      {bulkResult && (
        <BulkResult result={bulkResult} depotNames={depotNames} materialNames={materialNames} onDismiss={() => setBulkResult(null)} />
      )}
      <ErrorBanner error={error} onRetry={load} />

      {(!error || result.data.length > 0) && ( // a failed refresh keeps the rows already shown
        <DataTable
          columns={columns}
          rows={result.data}
          loading={loading && result.data.length === 0}
          filterState={filterState}
          getFilterOptions={getFilterOptions}
          pagination={pagination}
          onPageChange={setPage}
          onRowClick={(r) => onOpen(r._id)}
          emptyMessage={
            filterState.hasActiveFilters
              ? "No recommendations match these filters. Pending recommendations appear after a generation run."
              : "No recommendations yet — use Generate Recommendations to run the engine."
          }
        />
      )}
      {loading && result.data.length > 0 && <div className="-mt-2 text-right text-xs text-gray-400">Refreshing…</div>}

      <BulkApproveDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={(res) => {
          setBulkOpen(false);
          setBulkResult(res);
          onChanged?.(); // reload this list, Overview KPIs and Transfers — the user stays on Recommendations
        }}
      />
    </div>
  );
}

// Plain wording for the "changed since review" codes; other reasons (e.g. live stock) use the server's message.
const FAILURE_TEXT = {
  STALE_VERSION: "changed since you reviewed it (approved, rejected or replaced by a newer run).",
  INVALID_STATUS_TRANSITION: "is no longer pending.",
  RECOMMENDATION_NOT_FOUND: "no longer exists.",
};

/** Outcome of a bulk approval, worded from the server's actual result. */
function BulkResult({ result, depotNames, materialNames, onDismiss }) {
  const { approved, failed, transfersCreated, notIncluded } = result;
  const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
  const failures = result.results.filter((r) => r.status === "FAILED");
  const tone = failed === 0 ? "border-healthy/30 bg-healthy/5" : approved > 0 ? "border-[#B45309]/30 bg-[#B45309]/5" : "border-out/30 bg-out/5";
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${tone}`} role="status">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-[#1B2338]">
            {plural(approved, "recommendation")} approved. {plural(transfersCreated, "transfer request")} created.
          </div>
          {failed > 0 && <div className="mt-0.5 text-gray-700">{plural(failed, "recommendation")} could not be approved because {failed === 1 ? "it" : "they"} changed or {failed === 1 ? "is" : "are"} no longer eligible.</div>}
          {notIncluded > 0 && <div className="mt-0.5 text-gray-600">{plural(notIncluded, "new pending recommendation")} appeared after you reviewed the list and {notIncluded === 1 ? "was" : "were"} not approved.</div>}
          {failures.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
              {failures.slice(0, 5).map((f) => (
                <li key={f.recommendationId}>
                  <span className="font-semibold">{f.materialNo ? nameOr(materialNames, f.materialNo) : f.recommendationId}</span>
                  {f.sourceDepotId && <> · {nameOr(depotNames, f.sourceDepotId)} to {nameOr(depotNames, f.destinationDepotId)}</>} — {FAILURE_TEXT[f.code] || f.message}
                </li>
              ))}
              {failures.length > 5 && <li>…and {num(failures.length - 5)} more.</li>}
            </ul>
          )}
        </div>
        <button onClick={onDismiss} className="shrink-0 text-xs font-semibold text-gray-500 hover:underline">Dismiss</button>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 shrink-0 text-gray-400">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
    </svg>
  );
}

export { SearchIcon };
