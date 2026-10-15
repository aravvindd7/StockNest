import { useEffect, useState } from "react";
import { approveRecommendationsBulk, fetchPendingRecommendationSummary } from "../../services/distributionService";
import { ErrorBanner, PriorityBadge, describeError, num, useSubmission } from "./shared";

const PRIORITY_LABEL = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

/**
 * Approve Pending — bulk approval of PENDING recommendations by priority.
 *
 * Step 1 selects priority levels (counts/units are ALL current PENDING
 * recommendations from the server — never the table's page or filters).
 * Step 2 confirms. Every reviewed recommendation of the chosen priorities is
 * approved at its recommended quantity (no editing here — individual approval
 * is where quantities are changed). The server re-checks each one exactly as
 * an individual approval does and reports any it could not approve.
 */
export default function BulkApproveDialog({ open, onClose, onDone }) {
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [step, setStep] = useState("select"); // "select" | "confirm"
  const submission = useSubmission();

  async function load() {
    setLoadError(null);
    setSummary(null);
    try {
      setSummary(await fetchPendingRecommendationSummary());
    } catch (err) {
      setLoadError(describeError(err, "Could not load pending recommendations."));
    }
  }

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setStep("select");
    submission.reset();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const rows = summary?.priorities || [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.priority));
  const chosen = rows.filter((r) => selected.includes(r.priority));
  const chosenCount = chosen.reduce((s, r) => s + r.count, 0);
  const chosenUnits = chosen.reduce((s, r) => s + r.units, 0);

  const toggle = (priority) => setSelected((prev) => (prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority]));
  const toggleAll = () => setSelected(allSelected ? [] : rows.map((r) => r.priority));

  async function approve() {
    const body = {
      priorities: chosen.map((r) => r.priority),
      recommendations: chosen.flatMap((r) => r.recommendations),
    };
    const result = await submission.submit((key) => approveRecommendationsBulk(body, key));
    if (result) onDone(result);
  }

  const busy = submission.pending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 py-8" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="bulk-approve-title">
        <div className="border-b border-gray-200 px-6 py-4">
          <h3 id="bulk-approve-title" className="font-display text-base font-bold">
            {step === "select" ? "Approve Pending Recommendations" : `Approve ${plural(chosenCount, "Recommendation")}?`}
          </h3>
          {step === "select" && <p className="text-xs text-gray-500">Select the priority levels you want to approve.</p>}
        </div>

        <div className="px-6 py-5">
          {step === "select" && (
            <>
              {!summary && !loadError && <div className="py-6 text-center text-sm text-gray-400">Loading pending recommendations…</div>}
              <ErrorBanner error={loadError} onRetry={load} />
              {summary && (
                <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                  <label className="flex cursor-pointer items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5 font-semibold">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                    All priorities
                    <span className="ml-auto text-xs font-normal text-gray-500">{plural(summary.total.count, "recommendation")}</span>
                  </label>
                  {rows.map((r) => (
                    <label key={r.priority} className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-4 py-2.5 last:border-b-0">
                      <input type="checkbox" checked={selected.includes(r.priority)} onChange={() => toggle(r.priority)} aria-label={PRIORITY_LABEL[r.priority]} />
                      <PriorityBadge priority={r.priority} />
                      <span className={`ml-auto text-right text-xs ${r.count ? "text-gray-600" : "text-gray-400"}`}>
                        {plural(r.count, "recommendation")} · {num(r.units)} units
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {summary && (
                <div className="mt-4 flex items-baseline justify-between rounded-lg bg-primary/5 px-4 py-2.5 text-sm">
                  <span className="text-gray-500">Selected</span>
                  <span className="font-semibold text-[#1B2338]">{plural(chosenCount, "recommendation")} · {num(chosenUnits)} units</span>
                </div>
              )}
            </>
          )}

          {step === "confirm" && (
            <>
              <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                {chosen.map((r) => (
                  <div key={r.priority} className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                    <PriorityBadge priority={r.priority} />
                    <span className="text-gray-700">{plural(r.count, "recommendation")}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between bg-gray-50 px-4 py-2 font-semibold">
                  <span>Total</span>
                  <span>{plural(chosenCount, "recommendation")}</span>
                </div>
              </div>
              <div className="mt-3 flex items-baseline justify-between px-1 text-sm">
                <span className="text-gray-500">Recommended quantity</span>
                <span className="font-display text-lg font-bold text-primary">{num(chosenUnits)} units</span>
              </div>
              <p className="mt-3 text-sm text-gray-600">
                The recommended quantities will be approved without modification and transfer requests will be created for these recommendations.
              </p>
              <p className="mt-1.5 text-xs text-gray-400">
                No stock moves until each transfer is approved and dispatched. Each recommendation is re-checked against live stock; any that changed are reported, not approved.
              </p>
              {submission.error && <div className="mt-3"><ErrorBanner error={submission.error} /></div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-4">
          {step === "select" ? (
            <>
              <button onClick={onClose} className="sn-btn-ghost">Cancel</button>
              <button onClick={() => setStep("confirm")} disabled={chosenCount === 0} className="sn-btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                Continue
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep("select")} disabled={busy} className="sn-btn-ghost mr-auto disabled:opacity-50">Back</button>
              <button onClick={onClose} disabled={busy} className="sn-btn-ghost disabled:opacity-50">Cancel</button>
              <button onClick={approve} disabled={busy} className="sn-btn-primary disabled:opacity-60">
                {busy ? "Approving…" : `Approve ${plural(chosenCount, "Recommendation")}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
