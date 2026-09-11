/**
 * PlanDetailsDrawer — slide-out sidebar opened from a PLAN cell in Planning
 * Master. Read-only general planning overview for the working quarter: the
 * demand (actuals for months that have started, forecast for future months),
 * the required stock (the immediate demand gap, excluding safety stock), the
 * monthly demand distribution, and the Phase 7 inventory/replenishment
 * decision (shown separately, never merged into Required Stock).
 *
 * THIS DRAWER IS READ-ONLY. Monthly Replenishment Allocation editing lives
 * EXCLUSIVELY in the ReplenishmentDetailsDrawer — from the PLAN drawer the
 * planner can view but never edit allocation (no percentage inputs, no
 * Generate / Reset / Save Allocation / Apply to All). Monthly Demand
 * Distribution is rendered here and in the Replenishment drawer via the
 * shared MonthlyDemandDistribution component — one implementation, reused.
 */
import MonthlyDemandDistribution from "./MonthlyDemandDistribution";

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

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
  const requiredStock = row?.requiredStock ?? 0;

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
                <StatBlock label="Required Stock" value={`${num(requiredStock)} Units`} warn={requiredStock > 0} />
              </div>

              <MonthlyDemandDistribution monthly={monthly} quarterDemand={quarterDemand} workingQuarter={workingQuarter} />

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