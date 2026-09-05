/**
 * Slide-out drawer for a clicked quarter cell — Section "Forecast Details
 * Drawer". Never a new page, never a popup/modal; this slides in from the
 * right, matching the rest of the app's drawer pattern.
 *
 * Two modes:
 *   mode="forecast"   — a clicked FORECAST quarter. Forecast Quantity,
 *                       Confidence, Historical WMAPE, Forecast Horizon,
 *                       Demand Trend, Seasonality, Data History, Inventory
 *                       Decision, monthly forecast breakdown and reason.
 *   mode="historical" — a clicked ACTUAL/HISTORICAL quarter. Real monthly
 *                       sales from Sales Master (Month 1/2/3), quarter
 *                       total and monthly average. Deliberately lightweight:
 *                       NO forecast confidence, NO model, NO inventory
 *                       decision — those only ever apply to a forecast.
 *
 * Every forecast-intelligence field is conditionally rendered — if a value
 * isn't present on `cell` (e.g. the WMA path, or an older stored
 * prediction), that line is omitted rather than showing a blank or
 * fabricated value.
 */
const MODEL_LABELS = { XGBoost: "XGBoost", WMA_FALLBACK: "WMA Fallback", WMA: "WMA (seasonal average)" };
const TIER_COLOR = { HIGH: "text-healthy", MEDIUM: "text-accent", LOW: "text-out" };

const DECISION_STATUS_COLOR = {
  CRITICAL: "text-out",
  LOW: "text-accent",
  HEALTHY: "text-healthy",
  SURPLUS: "text-primary",
};

// Small Actual/Forecast tag next to a month — only rendered when the monthly
// item carries a `source` (visible for the Active FY's mixed quarters).
function SourceTag({ source }) {
  if (source === "actual") {
    return <span className="rounded bg-healthy/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-healthy">Actual</span>;
  }
  if (source === "forecast") {
    return <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">Forecast</span>;
  }
  return null;
}

export default function ForecastDrawer({ open, onClose, mode = "forecast", row, quarter, yearLabel, cell, decision, source }) {
  const isHistorical = mode === "historical";
  const modelLabel = source ? MODEL_LABELS[source] || source : null;
  const months = cell?.monthly || [];
  const quarterTotal = months.reduce((s, m) => s + (m.qty || 0), 0);
  const monthlyAverage = months.length ? Math.round(quarterTotal / months.length) : 0;

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
        {row && cell && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <div>
                <h3 className="font-display text-base font-bold">
                  {isHistorical ? "Actual Sales" : "Forecast Details"}
                </h3>
                <p className="text-xs text-gray-500">
                  {row.materialNo} · {row.materialName}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {isHistorical ? (
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                    Actual / Historical
                  </span>
                ) : (
                  <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                    Forecast
                  </span>
                )}
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {isHistorical ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <StatBlock label="Quarter Total" value={`${quarterTotal.toLocaleString("en-IN")} Units`} accent />
                    <StatBlock label="Monthly Average" value={`${monthlyAverage.toLocaleString("en-IN")} Units`} />
                    <StatBlock label="Quarter" value={`${quarter} · ${yearLabel}`} />
                  </div>

                  <div className="mt-6">
                    <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Actual Monthly Sales</h4>
                    <div className="overflow-hidden rounded-lg border border-gray-200">
                      {months.length === 0 ? (
                        <div className="px-4 py-4 text-sm text-gray-400">No sales recorded for this quarter.</div>
                      ) : (
                        months.map((m, i) => (
                          <div
                            key={m.month}
                            className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
                          >
                            <span className="flex items-center gap-2 text-gray-600">
                              {m.month}
                              <SourceTag source={m.source} />
                            </span>
                            <span className="font-mono font-semibold">{m.qty.toLocaleString("en-IN")}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="mt-6">
                    <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Context</h4>
                    <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-600">
                      Actual sales recorded in Sales Master for {quarter} {yearLabel}. This is historical demand data — no
                      forecast confidence or inventory decision applies to it.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <StatBlock label="Forecast Quantity" value={`${cell.qty.toLocaleString("en-IN")} Units`} accent />
                    {Number.isFinite(cell.confidence) && <StatBlock label="Forecast Confidence" value={`${cell.confidence}%`} />}
                    {Number.isFinite(cell.growthPct) && <StatBlock label="Growth" value={`${cell.growthPct >= 0 ? "+" : ""}${cell.growthPct}%`} tone={cell.growthPct >= 0 ? "up" : "down"} />}
                    <StatBlock label="Quarter" value={`${quarter} · ${yearLabel}`} />
                  </div>

                  {(modelLabel || cell.confidenceTier || cell.segmentWmape != null || cell.forecastHorizon || cell.trend || cell.seasonality || cell.historyMonths != null) && (
                    <div className="mt-6">
                      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Forecast Intelligence</h4>
                      <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                        {modelLabel && <IntelRow label="Model" value={modelLabel} />}
                        {cell.confidenceTier && (
                          <IntelRow label="Confidence" value={cell.confidenceTier[0] + cell.confidenceTier.slice(1).toLowerCase()} valueClass={TIER_COLOR[cell.confidenceTier]} />
                        )}
                        {cell.segmentWmape != null && <IntelRow label="Historical WMAPE" value={`${cell.segmentWmape}%`} />}
                        {cell.forecastHorizon && <IntelRow label="Forecast Horizon" value={cell.forecastHorizon} />}
                        {cell.trend && <IntelRow label="Demand Trend" value={cell.trend[0].toUpperCase() + cell.trend.slice(1)} />}
                        {cell.seasonality && (
                          <IntelRow
                            label="Seasonality"
                            value={cell.seasonality === "insufficient_history" ? "Not enough history" : `${cell.seasonality[0].toUpperCase() + cell.seasonality.slice(1)}${cell.seasonalityPeakQuarter ? ` — ${cell.seasonalityPeakQuarter}` : ""}`}
                          />
                        )}
                        {cell.historyMonths != null && <IntelRow label="Data History" value={`${cell.historyMonths} months`} />}
                      </div>
                    </div>
                  )}

                  {decision && (
                    <div className="mt-6">
                      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Inventory Decision</h4>
                      <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                        {decision.currentStock != null && <IntelRow label="Current Stock" value={decision.currentStock.toLocaleString("en-IN")} />}
                        {decision.safetyStock != null && <IntelRow label="Safety Stock" value={decision.safetyStock.toLocaleString("en-IN")} />}
                        {decision.forecastDemand != null && <IntelRow label="Forecast Demand" value={decision.forecastDemand.toLocaleString("en-IN")} />}
                        {decision.projectedStock != null && <IntelRow label="Projected Stock" value={decision.projectedStock.toLocaleString("en-IN")} />}
                        {decision.replenishmentQty != null && <IntelRow label="Replenishment Required" value={decision.replenishmentQty.toLocaleString("en-IN")} />}
                        {decision.stockStatus && (
                          <IntelRow label="Stock Status" value={decision.stockStatus} valueClass={DECISION_STATUS_COLOR[decision.stockStatus]} />
                        )}
                        {decision.recommendedAction && (
                          <IntelRow label="Recommended Action" value={decision.recommendedAction} valueClass="font-semibold" />
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-6">
                    <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monthly Breakdown</h4>
                    <div className="overflow-hidden rounded-lg border border-gray-200">
                      {months.map((m, i) => (
                        <div
                          key={m.month}
                          className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
                        >
                          <span className="flex items-center gap-2 text-gray-600">
                            {m.month}
                            <SourceTag source={m.source} />
                          </span>
                          <span className="font-mono font-semibold">{m.qty.toLocaleString("en-IN")}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {cell.reason && (
                    <div className="mt-6">
                      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reason</h4>
                      <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-600">{cell.reason}</p>
                    </div>
                  )}
                </>
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

function StatBlock({ label, value, accent, tone }) {
  const toneColor = tone === "up" ? "text-healthy" : tone === "down" ? "text-out" : accent ? "text-primary" : "text-[#1B2338]";
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 font-display text-lg font-bold ${toneColor}`}>{value}</div>
    </div>
  );
}
