import { useEffect, useState } from "react";
import { fetchSalesMonthlyBreakdown } from "../services/salesService";

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

/**
 * Slide-out drawer for a clicked quarter cell on the Sales Master summary
 * table (Phase 1 Section 3) — same right-side drawer pattern as Planning
 * Master's ForecastDrawer, for a consistent, non-Excel-feeling UX. Never a
 * new page, never a popup.
 */
export default function MonthlyBreakdownDrawer({ open, materialNo, materialName, financialYear, quarter, onClose }) {
  const [breakdown, setBreakdown] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !materialNo || !financialYear || !quarter) return;
    setLoading(true);
    setError(null);
    fetchSalesMonthlyBreakdown(materialNo, financialYear, quarter)
      .then(setBreakdown)
      .catch((err) => setError(err.response?.data?.message || "Could not load the monthly breakdown."))
      .finally(() => setLoading(false));
  }, [open, materialNo, financialYear, quarter]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-sm transform bg-white shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <div>
              <h3 className="font-display text-base font-bold">
                {quarter} {financialYear}
              </h3>
              <p className="text-xs text-gray-500">
                {materialNo} · {materialName}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {loading && <p className="text-sm text-gray-400">Loading…</p>}
            {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

            {breakdown && (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                {breakdown.months.map((m, i) => (
                  <div
                    key={m.month}
                    className={`flex items-center justify-between px-4 py-3 text-sm ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
                  >
                    <span className="text-gray-600">{m.month}</span>
                    <span className="font-mono font-semibold">{num(m.qty)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-gray-200 bg-primary/5 px-4 py-3 text-sm">
                  <span className="font-display font-bold text-primary">{quarter} Total</span>
                  <span className="font-mono font-bold text-primary">{num(breakdown.total)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
