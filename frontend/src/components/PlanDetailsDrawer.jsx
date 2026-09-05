/**
 * PlanDetailsDrawer — slide-out sidebar opened only from a PLAN cell in
 * Planning Master. Shows the working quarter's plan: the demand (actuals for
 * months that have started, forecast for future months), the required stock
 * (the immediate demand gap, excluding safety stock), and a monthly demand
 * distribution for the working quarter. The Phase 7 inventory/replenishment
 * decision is shown separately (labeled on its own) and is never merged into
 * Required Stock.
 *
 * Percentages are monthly/quarter × 100, computed client-side with the last
 * row set as the remainder so the three always sum to exactly 100% (0% each
 * when the quarter total is 0) — never an arbitrary equal split.
 */
const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

function SourceTag({ source }) {
  if (source === "actual") {
    return <span className="rounded bg-healthy/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-healthy">Actual</span>;
  }
  if (source === "forecast") {
    return <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">Forecast</span>;
  }
  return null;
}

const DECISION_STATUS_COLOR = {
  CRITICAL: "text-out",
  LOW: "text-accent",
  HEALTHY: "text-healthy",
  SURPLUS: "text-primary",
};

export default function PlanDetailsDrawer({ open, onClose, row, activeFY, workingQuarter, activeMonth }) {
  const fyValue = activeFY?.value;
  const quarterBlock = row?.years?.[fyValue]?.quarters?.[workingQuarter];
  const monthly = quarterBlock?.monthly || [];
  const quarterDemand = row?.planDemand ?? 0;

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

  const decision = row?.inventoryDecision?.[workingQuarter];

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-md transform bg-white shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {row && activeFY && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <div>
                <h3 className="font-display text-base font-bold">Plan Details</h3>
                <p className="text-xs text-gray-500">
                  {row.materialNo} · {row.materialName}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                  Plan
                </span>
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-4">
                <StatBlock label="Active FY" value={activeFY.label} />
                <StatBlock label="Working Quarter" value={workingQuarter} />
                <StatBlock label="Current Month" value={activeMonth} />
                <StatBlock label="Material Number" value={row.materialNo} mono />
                <StatBlock label="Material Name" value={row.materialName} />
                <StatBlock label="Current Stock" value={`${num(row.currentStock)} Units`} />
                <StatBlock label="Quarter Demand / Forecast" value={`${num(quarterDemand)} Units`} accent />
                <StatBlock label="Required Stock" value={`${num(row.requiredStock)} Units`} warn={row.requiredStock > 0} />
              </div>

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

              {decision && (
                <div className="mt-6">
                  <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    Inventory Decision · {workingQuarter}
                  </h4>
                  <p className="mb-2 text-xs text-gray-400">
                    Phase 7 replenishment view — separate from Required Stock above.
                  </p>
                  <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                    <IntelRow label="Current Stock" value={num(decision.currentStock)} />
                    <IntelRow label="Safety Stock" value={num(decision.safetyStock)} />
                    <IntelRow label="Forecast Demand" value={num(decision.forecastDemand)} />
                    <IntelRow label="Projected Stock" value={num(decision.projectedStock)} />
                    <IntelRow label="Replenishment Required" value={num(decision.replenishmentQty)} />
                    {decision.stockStatus && (
                      <IntelRow label="Stock Status" value={decision.stockStatus} valueClass={DECISION_STATUS_COLOR[decision.stockStatus]} />
                    )}
                    {decision.recommendedAction && (
                      <IntelRow label="Recommended Action" value={decision.recommendedAction} valueClass="font-semibold" />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function IntelRow({ label, value, valueClass }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 last:border-b-0">
      <span className="text-gray-500">{label}</span>
      <span className={`font-semibold ${valueClass || "text-[#1B2338]"}`}>{value}</span>
    </div>
  );
}

function StatBlock({ label, value, accent, warn, mono }) {
  const toneColor = warn ? "text-out" : accent ? "text-primary" : "text-[#1B2338]";
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 truncate font-display text-lg font-bold ${mono ? "font-mono" : ""} ${toneColor}`}>{value}</div>
    </div>
  );
}
