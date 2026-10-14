import { ErrorBanner, StatTile, dateTime, forecastPeriodLabel, num } from "./shared";
import { shortageRows, shortageTotals } from "./DistributionShortages";

/**
 * "What is happening with inventory distribution right now?" — counts come
 * from the list endpoints' totals, transferable units from the pending
 * recommendations themselves, shortage figures from the live dry-run
 * analysis. Nothing is estimated client-side.
 */
export default function DistributionOverview({ stats, statsError, onRetry, analysis, analysisLoading, onNavigate }) {
  const rows = shortageRows(analysis);
  const totals = shortageTotals(rows);
  const planningCount = rows.filter((r) => r.uncovered > 0).length;
  const s = stats || {};

  return (
    <div className="flex flex-col gap-5">
      <ErrorBanner error={statsError} onRetry={onRetry} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Pending Recommendations" value={num(s.pendingRecommendations)} tone="info" hint="awaiting review" onClick={() => onNavigate("recommendations")} />
        <StatTile label="Approved Recommendations" value={num(s.approvedRecommendations)} hint="converted to transfers" />
        <StatTile label="Active Transfers" value={num(s.activeTransfers)} hint="requested → in transit" onClick={() => onNavigate("transfers", "active")} />
        <StatTile label="In Transit" value={num(s.inMotion)} tone="amber" hint={`${num(s.dispatched)} dispatched · ${num(s.inTransit)} in transit`} onClick={() => onNavigate("transfers", "moving")} />
        <StatTile label="Completed Transfers" value={num(s.received)} tone="good" hint="received" onClick={() => onNavigate("transfers", "received")} />
        <StatTile
          label="Transferable Units"
          value={num(s.pendingUnits)}
          hint={s.pendingUnitsPartial ? "first 500 pending only" : "in pending recommendations"}
        />
        <StatTile
          label="Unfulfilled Shortages"
          value={analysis ? num(planningCount) : analysisLoading ? "…" : "—"}
          tone="warn"
          hint={analysis ? `${num(totals.uncovered)} units need Planning` : "run the network analysis"}
          onClick={() => onNavigate("shortages")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="sn-card p-4">
          <h4 className="font-display text-sm font-bold">Transfer Action Queue</h4>
          <p className="mb-3 text-xs text-gray-500">Transfers waiting on the next lifecycle step.</p>
          {[
            ["Needs approval", s.requested, "approval", "REQUESTED"],
            ["Ready to dispatch", s.approvedTransfers, "dispatch", "APPROVED"],
            ["Dispatched — confirm in transit", s.dispatched, "moving", "DISPATCHED"],
            ["Awaiting receipt", s.inTransit, "moving", "IN_TRANSIT"],
          ].map(([label, value, queue]) => (
            <button key={label} onClick={() => onNavigate("transfers", queue)} className="flex w-full items-center justify-between border-b border-gray-100 py-2 text-sm last:border-b-0 hover:text-primary">
              <span className="text-gray-600">{label}</span>
              <span className={`font-display text-base font-bold ${value ? "text-[#1B2338]" : "text-gray-300"}`}>{num(value)}</span>
            </button>
          ))}
        </div>

        <div className="sn-card p-4">
          <h4 className="font-display text-sm font-bold">Latest Recommendation Run</h4>
          {s.latestRun ? (
            <div className="mt-2 flex flex-col gap-1.5 text-sm">
              <div className="font-mono text-xs text-gray-500">{s.latestRun.generationRunId}</div>
              <Row label="Generated" value={dateTime(s.latestRun.generatedAt)} />
              {s.latestRun.generatedBy && <Row label="By" value={s.latestRun.generatedBy} />}
              <Row label="Forecast period" value={forecastPeriodLabel(s.latestRun.forecastPeriod)} />
              <Row label="Recommendations in run" value={num(s.latestRun.count)} />
              <Row label="Still pending" value={num(s.latestRun.pending)} />
              <button onClick={() => onNavigate("recommendations")} className="mt-1 self-start text-xs font-semibold text-primary hover:underline">Review recommendations →</button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-500">No recommendation runs yet. Use <b>Generate Recommendations</b> to run the engine.</p>
          )}
        </div>

        <div className="sn-card p-4">
          <h4 className="font-display text-sm font-bold">Network Position</h4>
          {analysis ? (
            <div className="mt-2 flex flex-col gap-1.5 text-sm">
              <div className="text-xs text-gray-500">Live analysis · {forecastPeriodLabel(analysis.forecastPeriod)}</div>
              <Row label="Total shortage" value={`${num(totals.shortage)} units`} />
              <Row label="Solvable by Distribution" value={`${num(totals.covered)} units`} cls="text-healthy" />
              <Row label="Network shortage (Planning)" value={`${num(totals.uncovered)} units`} cls="text-out" />
              <Row label="Surplus sources" value={num(analysis.sourcePositions.length)} />
              <button onClick={() => onNavigate("shortages")} className="mt-1 self-start text-xs font-semibold text-primary hover:underline">Open network shortages →</button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-500">{analysisLoading ? "Analysing the network…" : "Network analysis not available yet."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, cls }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-gray-500">{label}</span>
      <span className={`font-semibold ${cls || "text-[#1B2338]"}`}>{value}</span>
    </div>
  );
}
