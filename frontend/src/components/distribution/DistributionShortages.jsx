import { useMemo, useState } from "react";
import DataTable from "../DataTable";
import { SearchIcon } from "./DistributionRecommendations";
import { ErrorBanner, StatTile, dateTime, forecastPeriodLabel, num } from "./shared";

/**
 * Network Shortages — built from a live DRY-RUN analysis (POST
 * /distribution/recommendations/generate { dryRun: true }): the engine's full
 * current computation, nothing saved. There is no persisted shortages
 * endpoint, so this view always reflects the moment the analysis ran.
 *
 * For every destination short of stock it separates:
 *   covered    — shortage the engine can fill by moving surplus between depots
 *   uncovered  — network-wide shortage no depot can spare → Planning / procurement
 * Both figures come straight from the engine (unfulfilledShortages carries
 * covered/uncovered; a destination absent from it was fully covered).
 */
const CLASS = {
  solvable: { label: "Solvable by Distribution", cls: "bg-healthy/10 text-healthy" },
  partial: { label: "Partly solvable", cls: "bg-low/15 text-[#B45309]" },
  planning: { label: "Requires Planning / procurement", cls: "bg-out/10 text-out" },
};

export function shortageRows(analysis) {
  if (!analysis) return [];
  const unfulfilled = new Map(analysis.unfulfilledShortages.map((u) => [`${u.materialNo}|${u.depotId}`, u]));
  return analysis.destinationPositions.map((d) => {
    const u = unfulfilled.get(`${d.materialNo}|${d.depotId}`);
    const covered = u ? u.covered : d.shortage;
    const uncovered = u ? u.uncovered : 0;
    const klass = uncovered === 0 ? "solvable" : covered > 0 ? "partial" : "planning";
    return { ...d, _id: `${d.materialNo}|${d.depotId}`, covered, uncovered, klass };
  });
}

export function shortageTotals(rows) {
  return rows.reduce(
    (t, r) => ({ shortage: t.shortage + r.shortage, covered: t.covered + r.covered, uncovered: t.uncovered + r.uncovered }),
    { shortage: 0, covered: 0, uncovered: 0 }
  );
}

/** Groups filtered opportunities by material + source + remaining surplus, so a shared surplus is shown once. */
function groupFiltered(filtered) {
  const groups = new Map();
  filtered.forEach((f) => {
    const key = `${f.materialNo}|${f.sourceDepotId}|${f.sourceRemainingSurplus}`;
    if (!groups.has(key)) groups.set(key, { ...f, destinations: [] });
    groups.get(key).destinations.push({ depotId: f.destinationDepotId, quantity: f.quantity });
  });
  return [...groups.values()];
}

export default function DistributionShortages({ analysis, loading, error, onRun, depotNames, stale }) {
  const [search, setSearch] = useState("");
  const [klass, setKlass] = useState("all");

  const rows = useMemo(() => shortageRows(analysis), [analysis]);
  const totals = useMemo(() => shortageTotals(rows), [rows]);
  const visible = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows
      .filter((r) => klass === "all" || r.klass === klass)
      .filter((r) => !q || r.materialNo.includes(q) || r.depotId.includes(q) || (depotNames?.[r.depotId] || "").toUpperCase().includes(q))
      .sort((a, b) => b.uncovered - a.uncovered || b.shortage - a.shortage || a.materialNo.localeCompare(b.materialNo) || a.depotId.localeCompare(b.depotId));
  }, [rows, klass, search, depotNames]);
  const filteredGroups = useMemo(() => groupFiltered(analysis?.filteredRecommendations || []), [analysis]);

  const columns = [
    { key: "materialNo", label: "Material", sortable: false, sticky: true, stickyOffset: 0, width: 104, render: (r) => <span className="font-mono font-semibold">{r.materialNo}</span> },
    { key: "depotId", label: "Depot", sortable: false, render: (r) => <span>{r.depotId}{depotNames?.[r.depotId] && <span className="ml-1 text-gray-400">· {depotNames[r.depotId]}</span>}</span> },
    { key: "currentStock", label: "Current Stock", sortable: false, className: "text-right", render: (r) => num(r.currentStock) },
    { key: "safetyStock", label: "Safety Stock", sortable: false, className: "text-right", render: (r) => num(r.safetyStock) },
    { key: "forecastDemand", label: "Forecast Demand", sortable: false, className: "text-right", render: (r) => num(r.forecastDemand) },
    { key: "openInbound", label: "Open Inbound", sortable: false, className: "text-right", render: (r) => num(r.openInbound) },
    { key: "shortage", label: "Shortage", sortable: false, className: "text-right", render: (r) => <span className="font-semibold">{num(r.shortage)}</span> },
    { key: "covered", label: "Covered by Transfers", sortable: false, className: "text-right", render: (r) => <span className={r.covered ? "font-semibold text-healthy" : "text-gray-300"}>{num(r.covered)}</span> },
    { key: "uncovered", label: "Network Shortage", sortable: false, className: "text-right", render: (r) => <span className={r.uncovered ? "font-semibold text-out" : "text-gray-300"}>{num(r.uncovered)}</span> },
    { key: "klass", label: "Resolution", sortable: false, render: (r) => <span className={`rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${CLASS[r.klass].cls}`}>{CLASS[r.klass].label}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="sn-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="text-sm text-gray-600">
          {analysis ? (
            <>
              <b>Live analysis</b> for {forecastPeriodLabel(analysis.forecastPeriod)} · computed {dateTime(analysis.generatedAt)} ·{" "}
              <span className="text-gray-400">dry run — nothing saved, no recommendations created</span>
            </>
          ) : (
            "Run the analysis to see the current network position."
          )}
          {stale && analysis && <span className="ml-2 font-semibold text-[#B45309]">Data changed since — re-run for current figures.</span>}
        </div>
        <button onClick={onRun} disabled={loading} className="sn-btn-ghost disabled:opacity-60">{loading ? "Analysing…" : analysis ? "Re-run Analysis" : "Run Analysis"}</button>
      </div>

      <ErrorBanner error={error} onRetry={onRun} />
      {loading && !analysis && <div className="sn-card p-10 text-center text-sm text-gray-400">Analysing the network…</div>}

      {analysis && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Depots Short" value={num(rows.length)} hint="material × depot positions" />
            <StatTile label="Total Shortage" value={num(totals.shortage)} hint="units over the forecast period" />
            <StatTile label="Solvable by Distribution" value={num(totals.covered)} tone="good" hint="by moving surplus between depots" />
            <StatTile label="Network Shortage" value={num(totals.uncovered)} tone="warn" hint="needs Planning / procurement" />
            <StatTile label="Surplus Sources" value={num(analysis.sourcePositions.length)} hint="positions with transferable SIH" />
          </div>
          <p className="-mt-1 text-xs text-gray-500">
            Network shortage cannot be met by redistribution — no depot holds enough transferable stock in hand. It is not transferable inventory; it is demand Planning must
            cover through replenishment.
          </p>

          <div className="sn-card flex flex-wrap items-center gap-3 p-4">
            <div className="flex w-64 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <SearchIcon />
              <input className="w-full border-none bg-transparent text-sm outline-none" placeholder="Search material or depot…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
              {[["all", "All"], ["solvable", CLASS.solvable.label], ["partial", CLASS.partial.label], ["planning", CLASS.planning.label]].map(([k, label]) => (
                <button key={k} onClick={() => setKlass(k)} className={`rounded-md px-3 py-1 text-xs font-semibold transition ${klass === k ? "bg-white text-primary shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                  {label}
                </button>
              ))}
            </div>
            <span className="text-xs text-gray-400">{num(visible.length)} of {num(rows.length)} positions · sorted by network shortage</span>
          </div>

          <DataTable columns={columns} rows={visible} loading={false} emptyMessage="No shortages in this view." />

          {filteredGroups.length > 0 && (
            <div className="sn-card p-4">
              <h4 className="font-display text-sm font-bold">Below Minimum Transfer Quantity</h4>
              <p className="mt-0.5 text-xs text-gray-500">
                Opportunities the engine did not recommend because the quantity was under the minimum ({num(analysis.filteredRecommendations[0]?.minTransferQuantity)} units).
                Each source's <b>remaining surplus is shown once</b>: it was considered for every destination listed, so the destination quantities overlap and must not be added together.
              </p>
              <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-left text-[12.5px]">
                  <thead className="bg-gray-50 text-[10.5px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Material</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2 text-right">Remaining Surplus at Source</th>
                      <th className="px-3 py-2">Considered For (quantity each)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGroups.map((g) => (
                      <tr key={`${g.materialNo}|${g.sourceDepotId}|${g.sourceRemainingSurplus}`} className="border-t border-gray-100 align-top">
                        <td className="px-3 py-2 font-mono font-semibold">{g.materialNo}</td>
                        <td className="px-3 py-2">{g.sourceDepotId}{depotNames?.[g.sourceDepotId] && <span className="text-gray-400"> · {depotNames[g.sourceDepotId]}</span>}</td>
                        <td className="px-3 py-2 text-right font-semibold">{num(g.sourceRemainingSurplus)} units</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {g.destinations.map((d) => (
                              <span key={d.depotId} className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px]">{d.depotId}: {num(d.quantity)}</span>
                            ))}
                          </div>
                          {g.destinations.length > 1 && <div className="mt-1 text-[11px] text-gray-400">Same {num(g.sourceRemainingSurplus)} units considered for {g.destinations.length} destinations — not additive.</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(analysis.skipped.length > 0 || Object.keys(analysis.dataQualityWarnings || {}).length > 0) && (
            <div className="sn-card border-low/40 p-4 text-sm">
              <h4 className="font-display text-sm font-bold text-[#92400E]">Data Quality</h4>
              {analysis.skipped.length > 0 && <p className="mt-1 text-gray-600">{num(analysis.skipped.length)} material/depot positions were excluded (e.g. missing forecast, stock or safety stock) and are not reflected above.</p>}
              {Object.keys(analysis.dataQualityWarnings || {}).length > 0 && (
                <p className="mt-1 text-gray-600">Warnings: {Object.keys(analysis.dataQualityWarnings).join(", ")}.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
