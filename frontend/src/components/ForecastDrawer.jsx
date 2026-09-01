/**
 * Slide-out drawer for a clicked forecast quarter cell — Section
 * "Forecast Details Drawer". Never a new page, never a popup/modal;
 * this slides in from the right, matching the rest of the app's drawer
 * pattern (see components/Sidebar.jsx-adjacent detail panels elsewhere).
 *
 * The "Forecast Intelligence" section below is new: every field there is
 * conditionally rendered — if a value isn't present on `cell` (e.g. the
 * WMA path, which has no per-quarter segment WMAPE/trend/seasonality
 * concept, or an older stored prediction from before this phase), that
 * line is simply omitted rather than showing a blank or fabricated value.
 */
const MODEL_LABELS = { XGBoost: "XGBoost", WMA_FALLBACK: "WMA Fallback", WMA: "WMA (seasonal average)" };
const TIER_COLOR = { HIGH: "text-healthy", MEDIUM: "text-accent", LOW: "text-out" };

export default function ForecastDrawer({ open, row, quarter, forecastYear, onClose }) {
  const cell = row?.forecast?.quarters?.[quarter];
  const modelLabel = row?.forecast?.source ? MODEL_LABELS[row.forecast.source] || row.forecast.source : null;

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
                <h3 className="font-display text-base font-bold">Forecast Details</h3>
                <p className="text-xs text-gray-500">
                  {row.materialNo} · {row.materialName}
                </p>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-4">
                <StatBlock label="Forecast Quantity" value={`${cell.qty.toLocaleString("en-IN")} Units`} accent />
                <StatBlock label="Forecast Confidence" value={`${cell.confidence}%`} />
                <StatBlock label="Growth" value={`${cell.growthPct >= 0 ? "+" : ""}${cell.growthPct}%`} tone={cell.growthPct >= 0 ? "up" : "down"} />
                <StatBlock label="Quarter" value={`${quarter} · ${forecastYear}`} />
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

              <div className="mt-6">
                <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monthly Breakdown</h4>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  {cell.monthly.map((m, i) => (
                    <div
                      key={m.month}
                      className={`flex items-center justify-between px-4 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
                    >
                      <span className="text-gray-600">{m.month}</span>
                      <span className="font-mono font-semibold">{m.qty.toLocaleString("en-IN")}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reason</h4>
                <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-600">{cell.reason}</p>
              </div>
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
