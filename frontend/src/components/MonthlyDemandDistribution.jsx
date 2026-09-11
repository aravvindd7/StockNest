/**
 * MonthlyDemandDistribution — the SINGLE shared implementation of the working
 * quarter's monthly demand split. Rendered in both the Plan Details drawer
 * and the Replenishment Details drawer so the two never drift apart.
 *
 * One implementation, two presentations: each drawer mounts THIS component,
 * so there is exactly one calculation/source (extracted verbatim from the
 * former PlanDetailsDrawer). The percentages sum to exactly 100 — the last
 * row is set as the remainder — and 0 each when the quarter total is 0.
 *
 * `SourceTag` is exported from here so the replenishment allocation editor
 * (which tags its months with the same actual/forecast source) reuses it
 * instead of keeping a second copy.
 */
const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

export function SourceTag({ source }) {
  if (source === "actual") {
    return <span className="rounded bg-healthy/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-healthy">Actual</span>;
  }
  if (source === "forecast") {
    return <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">Forecast</span>;
  }
  return null;
}

/**
 * @param {{ monthly: Array<{month, qty, source}>, quarterDemand: number, workingQuarter: string }}
 */
export default function MonthlyDemandDistribution({ monthly = [], quarterDemand = 0, workingQuarter }) {
  // Distribution percentages = monthly/quarter × 100. The last row is set as
  // the remainder so the three always sum to exactly 100 (0 each when the
  // total is 0).
  const distribution = monthly.map((m) => ({
    month: m.month,
    qty: m.qty,
    source: m.source,
  }));
  if (quarterDemand > 0) {
    for (let i = 0; i < distribution.length; i++) {
      distribution[i].pct =
        i === distribution.length - 1
          ? Math.max(0, 100 - distribution.slice(0, i).reduce((s, d) => s + Math.round((d.qty / quarterDemand) * 100), 0))
          : Math.round((distribution[i].qty / quarterDemand) * 100);
    }
  } else {
    distribution.forEach((d) => (d.pct = 0));
  }

  return (
    <div className="mt-6">
      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Monthly Demand Distribution · {workingQuarter}
      </h4>
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          <span>Month</span>
          <span className="text-right">Demand</span>
          <span className="w-14 text-right">%</span>
        </div>
        {distribution.map((d, i) => (
          <div
            key={d.month}
            className={`grid grid-cols-[1fr_auto_auto] items-center gap-2 px-4 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
          >
            <span className="flex items-center gap-2 text-gray-600">
              {d.month}
              <SourceTag source={d.source} />
            </span>
            <span className="font-mono font-semibold">{num(d.qty)}</span>
            <span className="w-14 text-right font-mono font-semibold text-gray-500">{d.pct}%</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-4 py-2.5 text-sm font-semibold">
          <span className="text-gray-600">Quarter Total</span>
          <span className="font-mono font-bold">{num(quarterDemand)} · 100%</span>
        </div>
      </div>
    </div>
  );
}