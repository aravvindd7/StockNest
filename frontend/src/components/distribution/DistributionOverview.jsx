import { ErrorBanner, StatTile, num } from "./shared";
import { shortageRows, shortageTotals } from "./DistributionNetworkAnalysis";

/**
 * Permanent Overview — "What is the current state of Distribution?"
 * Seven summary KPIs, always visible above the workspace. They are read-only
 * figures, not navigation. Counts come from the list endpoints' totals,
 * transferable units from the pending recommendations themselves, and the
 * unfulfilled-shortage figure from the live dry-run network analysis.
 * Nothing is estimated client-side.
 */
export default function DistributionOverview({ stats, statsError, onRetry, analysis, analysisLoading }) {
  const rows = shortageRows(analysis);
  const totals = shortageTotals(rows);
  const planningCount = rows.filter((r) => r.uncovered > 0).length;
  const s = stats || {};
  const v = (value) => (stats ? num(value) : "…");

  return (
    <section aria-label="Distribution overview" className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Overview</h3>
      <ErrorBanner error={statsError} onRetry={onRetry} />
      {/* Wraps responsively: as many tiles per row as fit at a readable width (7 → 4+3 → 3+3+1 → 2 …). */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        <StatTile label="Pending Recommendations" value={v(s.pendingRecommendations)} tone="info" hint="awaiting review" />
        <StatTile label="Approved Recommendations" value={v(s.approvedRecommendations)} hint="converted to transfers" />
        <StatTile label="Active Transfers" value={v(s.activeTransfers)} hint="requested → in transit" />
        <StatTile label="In Transit" value={v(s.inMotion)} tone="amber" hint={stats ? `${num(s.dispatched)} dispatched · ${num(s.inTransit)} in transit` : undefined} />
        <StatTile label="Completed Transfers" value={v(s.received)} tone="good" hint="received" />
        <StatTile label="Transferable Units" value={v(s.pendingUnits)} hint={s.pendingUnitsPartial ? "first 500 pending only" : "in pending recommendations"} />
        <StatTile
          label="Unfulfilled Shortages"
          value={analysis ? num(planningCount) : analysisLoading ? "…" : "—"}
          tone="warn"
          hint={analysis ? `${num(totals.uncovered)} units need Planning` : "network analysis pending"}
        />
      </div>
    </section>
  );
}
