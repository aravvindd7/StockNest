/**
 * ReplenishmentDetailsDrawer — slide-out sidebar opened from the
 * REPLENISHMENT PLAN cell in Planning Master. This is the ONLY editing
 * surface for Monthly Replenishment Allocation. It contains:
 *
 *   1. Monthly Demand Distribution — the working quarter's demand split
 *      (rendered via the shared MonthlyDemandDistribution component — one
 *      implementation reused by both drawers).
 *   2. Monthly Replenishment Allocation — the planner-controlled editor
 *      for WHEN the already-calculated Required Stock is replenished.
 *
 * Title: "Replenishment Details".
 *
 * Monthly Replenishment Allocation modes (backend is the source of truth for
 * the prediction — no prediction logic runs here):
 *   AUTO · Forecast — the system-generated forecast-driven allocation
 *     (row.autoReplenishmentPlan), computed server-side from the XGBoost
 *     demand forecast + current inventory via a stock-depletion simulation.
 *     It populates the plan by default and is what Reset restores — never
 *     the old 33.33/33.33/33.34 fallback.
 *   MANUAL · Planner Override — a planner-saved (or in-progress) allocation.
 *     Saved via Save; a saved plan is never auto-overwritten.
 *
 * Percentages (0–100, total must equal 100) are converted to integer
 * quantities that sum EXACTLY to Required Stock via the same largest-remainder
 * algorithm the backend uses. Safe N/A states from the backend (missing /
 * invalid forecast) are shown as-is and the editor is disabled — percentages
 * are never invented client-side.
 */
import { useEffect, useRef, useState } from "react";
import { saveReplenishmentPlan, resetReplenishmentPlan, applyToAllReplenishmentPlan } from "../services/planningService";
import MonthlyDemandDistribution, { SourceTag } from "./MonthlyDemandDistribution";

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

/**
 * Largest-remainder integer allocation — mirrors utils/replenishmentAllocation
 * on the server so displayed quantities always sum exactly to requiredStock.
 */
function computeQuantities(requiredStock, percentages) {
  if (!Number.isFinite(requiredStock) || requiredStock <= 0 || percentages.length === 0) {
    return percentages.map(() => 0);
  }
  const n = percentages.length;
  const exact = percentages.map((p) => (requiredStock * p) / 100);
  const floored = exact.map(Math.floor);
  let remaining = requiredStock - floored.reduce((s, v) => s + v, 0);
  const remainders = exact.map((v, i) => ({ i, r: v - Math.floor(v) }));
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < remaining && k < n; k++) floored[remainders[k].i] += 1;
  return floored;
}

export default function ReplenishmentDetailsDrawer({ open, onClose, row, activeFY, workingQuarter, onSave, onApplyAll }) {
  const fyValue = activeFY?.value;
  const quarterBlock = row?.years?.[fyValue]?.quarters?.[workingQuarter];
  const monthly = quarterBlock?.monthly || [];
  const quarterDemand = row?.planDemand ?? 0;

  // Editable allocation state, initialized from the row's ACTIVE plan every
  // time the drawer opens (or the row changes — e.g. after a save). Save
  // feedback survives a same-material row swap (the post-save update re-inits
  // allocation to the persisted plan without clearing the message); it is
  // cleared on a fresh open or when the target material changes.
  const [allocation, setAllocation] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const [showApplyAllConfirm, setShowApplyAllConfirm] = useState(false);
  const [applyAllSaving, setApplyAllSaving] = useState(false);
  const [applyAllResult, setApplyAllResult] = useState(null);

  // Backend is the source of truth. activePlan is what the table shows and
  // the drawer edits; autoPlan is the current forecast-driven prediction that
  // Reset restores (and the default when no manual plan is saved).
  const activePlan = row?.replenishmentPlan;
  const autoPlan = row?.autoReplenishmentPlan;
  const requiredStock = row?.requiredStock ?? 0;

  const prevOpenRef = useRef(false);
  const prevMaterialRef = useRef(null);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) return;
    const key = row?.materialNo;
    const isNewOpen = !wasOpen;
    const isNewMaterial = prevMaterialRef.current !== key;
    prevMaterialRef.current = key;
    if (activePlan?.distribution?.length) {
      setAllocation(activePlan.distribution.map((d) => ({ month: d.month, percentage: d.percentage, quantity: d.quantity, source: d.source })));
    } else {
      setAllocation(null);
    }
    setDirty(false);
    setIsSaving(false);
    if (isNewOpen || isNewMaterial) {
      setSaveError(null);
      setSaveMessage(null);
    }
  }, [open, row]);

  const livePercentages = (allocation || []).map((d) => d.percentage);
  const liveQuantities = computeQuantities(requiredStock, livePercentages);
  const pctTotal = livePercentages.reduce((s, p) => s + (Number.isFinite(p) ? p : 0), 0);
  const pctTotalStatus =
    Math.abs(pctTotal - 100) < 0.01 ? "ok"
      : (allocation || []).some((d) => !Number.isFinite(d.percentage) || d.percentage < 0 || d.percentage > 100) ? "invalid"
        : "mismatch";

  // The editor is enabled only when there is an allocation to edit: a saved
  // MANUAL plan always carries one, and an AUTO plan only in the computed
  // state. Safe N/A states (missing/invalid forecast) never invent percentages.
  const editable = Boolean(allocation) && (activePlan?.mode === "MANUAL" || (activePlan?.mode === "AUTO_FORECAST" && activePlan?.state === "computed"));

  // Source label — never color-only (spec: text distinguishes AUTO vs MANUAL).
  const isDirty = dirty && allocation;
  const sourceLabel = isDirty
    ? "MANUAL · Planner Override"
    : activePlan?.mode === "MANUAL"
      ? "MANUAL · Planner Override"
      : "AUTO · Forecast";
  const isAutoActive = !isDirty && activePlan?.mode === "AUTO_FORECAST";

  const handlePercentageChange = (index, raw) => {
    const value = raw === "" ? NaN : Number(raw);
    setAllocation((prev) => {
      const next = prev.map((d) => ({ ...d }));
      next[index] = { ...next[index], percentage: value };
      return next;
    });
    setDirty(true);
    setSaveError(null);
    setSaveMessage(null);
  };

  // Reset = "discard all unsaved edits and restore the LATEST PERSISTED STATE".
  const handleReset = async () => {
    if (activePlan?.mode === "MANUAL" && dirty && activePlan?.distribution?.length) {
      setAllocation(activePlan.distribution.map((d) => ({ month: d.month, percentage: d.percentage, quantity: d.quantity, source: d.source })));
      setDirty(false);
      setSaveError(null);
      setSaveMessage("Restored to saved allocation.");
      return;
    }
    if (activePlan?.mode === "MANUAL" && !dirty && activePlan?.distribution?.length) {
      setIsResetting(true);
      setSaveError(null);
      setSaveMessage(null);
      try {
        await resetReplenishmentPlan({
          materialNo: row.materialNo,
          financialYear: activePlan.financialYear,
          quarter: workingQuarter,
        });
        if (autoPlan) onSave?.(row.materialNo, autoPlan);
        if (autoPlan?.state === "computed" && autoPlan?.distribution?.length) {
          setAllocation(autoPlan.distribution.map((d) => ({ month: d.month, percentage: d.percentage, quantity: d.quantity, source: d.source })));
        } else {
          setAllocation(null);
        }
        setDirty(false);
        setSaveMessage("Reset to the auto-predicted allocation.");
      } catch (err) {
        setSaveError(err.response?.data?.message || "Could not reset the replenishment allocation.");
      } finally {
        setIsResetting(false);
      }
      return;
    }
    if (autoPlan?.state === "computed" && autoPlan?.distribution?.length) {
      setAllocation(autoPlan.distribution.map((d) => ({ month: d.month, percentage: d.percentage, quantity: d.quantity, source: d.source })));
    } else {
      setAllocation(null);
    }
    setDirty(false);
    setSaveError(null);
    setSaveMessage(null);
  };

  // Generate = "reload the system's latest auto-predicted allocation into the
  // drawer" — unsaved, editable state. No backend call needed.
  const handleGenerate = () => {
    if (autoPlan?.state === "computed" && autoPlan?.distribution?.length) {
      setAllocation(autoPlan.distribution.map((d) => ({ month: d.month, percentage: d.percentage, quantity: d.quantity, source: d.source })));
    } else {
      setAllocation(null);
    }
    setDirty(true);
    setSaveError(null);
    setSaveMessage("Forecasted allocation loaded — review and save to persist.");
  };

  const handleSave = async () => {
    if (!allocation) return;
    if (pctTotalStatus !== "ok") {
      setSaveError("Percentages must each be 0–100 and total exactly 100%.");
      return;
    }
    if (!activePlan) {
      setSaveError("This material has no working-quarter allocation to save.");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const payload = {
        materialNo: row.materialNo,
        financialYear: activePlan.financialYear,
        quarter: workingQuarter,
        requiredStock,
        distribution: allocation.map((d, i) => ({
          month: d.month,
          percentage: Math.round(d.percentage * 100) / 100,
          quantity: liveQuantities[i],
          source: d.source || "none",
        })),
        depotId: "",
      };
      const saved = await saveReplenishmentPlan(payload);
      setSaveMessage("Replenishment allocation saved.");
      setDirty(false);
      onSave?.(row.materialNo, {
        mode: "MANUAL",
        state: autoPlan?.state || "computed",
        financialYear: saved.financialYear,
        quarter: saved.quarter,
        requiredStock: saved.requiredStock,
        distribution: saved.distribution.map((d) => ({
          month: d.month,
          percentage: d.percentage,
          quantity: d.quantity,
          source: d.source,
        })),
        explanation: autoPlan?.explanation || "",
      });
    } catch (err) {
      setSaveError(err.response?.data?.message || "Could not save the replenishment allocation.");
    } finally {
      setIsSaving(false);
    }
  };

  // Apply to All — validate current percentages, then show confirmation dialog.
  const handleApplyAllClick = () => {
    if (!allocation) return;
    if (pctTotalStatus !== "ok") {
      setSaveError("Percentages must each be 0–100 and total exactly 100% before applying to all.");
      return;
    }
    if (!activePlan) {
      setSaveError("This material has no working-quarter allocation to apply.");
      return;
    }
    setSaveError(null);
    setSaveMessage(null);
    setShowApplyAllConfirm(true);
  };

  const handleApplyAllConfirm = async () => {
    setApplyAllSaving(true);
    setApplyAllResult(null);
    try {
      const distributionPayload = allocation.map((d) => ({
        month: d.month,
        percentage: Math.round(d.percentage * 100) / 100,
        source: d.source || "none",
      }));
      const result = await applyToAllReplenishmentPlan({
        financialYear: activePlan.financialYear,
        distribution: distributionPayload,
      });
      setApplyAllResult(result);
      setShowApplyAllConfirm(false);
      setSaveMessage(`Applied to ${result.saved} of ${result.affected} materials.`);
      if (onApplyAll) await onApplyAll();
    } catch (err) {
      setSaveError(err.response?.data?.message || "Could not apply distribution to all materials.");
      setShowApplyAllConfirm(false);
    } finally {
      setApplyAllSaving(false);
    }
  };

  const handleApplyAllCancel = () => {
    setShowApplyAllConfirm(false);
    setApplyAllResult(null);
  };

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
                <h3 className="font-display text-base font-bold">Replenishment Details</h3>
                <p className="text-xs text-gray-500">
                  {row.materialNo} · {row.materialName}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                  Replenish
                </span>
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <MonthlyDemandDistribution monthly={monthly} quarterDemand={quarterDemand} workingQuarter={workingQuarter} />

              {/* Monthly Replenishment Allocation — editable allocation of WHEN
                  Required Stock is replenished. NOT demand distribution. */}
              <div className="mt-6">
                <div className="mb-1 flex items-center justify-between">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    Monthly Replenishment Allocation · {workingQuarter}
                  </h4>
                  <div className="flex items-center gap-2">
                    {activePlan?.mode === "MANUAL" && !isDirty && (
                      <span className="rounded bg-healthy/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-healthy">Saved</span>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                        isAutoActive ? "bg-accent/10 text-accent" : "bg-primary/10 text-primary"
                      }`}
                    >
                      {sourceLabel}
                    </span>
                  </div>
                </div>
                <p className="mb-2 text-xs text-gray-400">
                  Controls WHEN Required Stock is replenished across the quarter's months — this is not the demand
                  distribution above.
                </p>

                {isAutoActive && (
                  <p className="mb-2 text-xs text-gray-400 italic">Recommended from XGBoost demand forecast and projected stock depletion.</p>
                )}

                {requiredStock === 0 ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                    No replenishment required — Required Stock is 0.
                  </div>
                ) : !editable ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                    {activePlan?.state === "no_forecast_demand"
                      ? "No forecast demand — an automatic allocation cannot be generated."
                      : "N/A · Insufficient Forecast — no usable forecast to drive an automatic allocation."}
                  </div>
                ) : (
                  <>
                    <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
                      <div className="grid grid-cols-[1fr_90px_80px] gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <span>Month</span>
                        <span className="text-right">%</span>
                        <span className="text-right">Qty</span>
                      </div>
                      {(allocation || []).map((d, i) => (
                        <div
                          key={d.month}
                          className={`grid grid-cols-[1fr_90px_80px] items-center gap-3 px-4 py-2.5 ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}
                        >
                          <span className="flex items-center gap-2 text-gray-600">
                            {d.month}
                            <SourceTag source={d.source} />
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={Number.isFinite(d.percentage) ? d.percentage : ""}
                            onChange={(e) => handlePercentageChange(i, e.target.value)}
                            className="w-full rounded-md border border-gray-300 px-2 py-1 text-right font-mono text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                            aria-label={`${d.month} allocation percentage`}
                          />
                          <span className="text-right font-mono font-semibold text-gray-700">
                            {num(Number.isFinite(liveQuantities[i]) ? liveQuantities[i] : 0)}
                          </span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-4 py-2.5 text-sm font-semibold">
                        <span className="text-gray-600">Total</span>
                        <span className="flex items-center gap-3">
                          <span className={`font-mono ${pctTotalStatus === "ok" ? "text-healthy" : "text-out"}`}>
                            ~{Math.round(pctTotal)}% ·
                          </span>
                          <span className="font-mono font-bold">{num(liveQuantities.reduce((s, v) => s + v, 0))}</span>
                        </span>
                      </div>
                    </div>

                    <p className="mt-2 text-xs text-gray-400">
                      Quantities recompute live and always sum exactly to {num(requiredStock)} units. Percentages must total
                      100% to save.
                    </p>

                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="flex-1">
                        {saveError && <div className="text-xs font-medium text-out">{saveError}</div>}
                        {saveMessage && <div className="text-xs font-medium text-healthy">{saveMessage}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleGenerate}
                          disabled={isSaving || isResetting || applyAllSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-2 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:opacity-50"
                        >
                          Generate
                        </button>
                        <button
                          onClick={handleReset}
                          disabled={isSaving || isResetting || applyAllSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          {isResetting && <Spinner />}
                          Reset
                        </button>
                        <button
                          onClick={handleSave}
                          disabled={isSaving || !allocation || applyAllSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isSaving && <Spinner />}
                          Save Allocation
                        </button>
                        <button
                          onClick={handleApplyAllClick}
                          disabled={isSaving || isResetting || applyAllSaving || !allocation}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Apply to All
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Apply to All — confirmation dialog */}
              {showApplyAllConfirm && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
                  <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
                    <h4 className="font-display text-base font-bold text-[#1B2338]">Apply to All Materials</h4>
                    <p className="mt-2 text-sm text-gray-600">
                      This will apply the current percentage distribution to <strong>every applicable material</strong> in the
                      current Planning Master view for {workingQuarter} · {activeFY?.label}.
                    </p>
                    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Distribution</p>
                      <p className="mt-1 font-mono text-sm text-[#1B2338]">
                        {(allocation || []).map((d) => `${d.month}: ${Math.round(d.percentage)}%`).join(" · ")}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Each material's quantities will be recalculated from its own Required Stock.
                      </p>
                    </div>
                    <p className="mt-3 text-xs text-gray-500">
                      All affected materials will be set to <strong>MANUAL</strong> mode. This action can be undone per-record using Reset.
                    </p>
                    <div className="mt-5 flex items-center justify-end gap-2">
                      <button
                        onClick={handleApplyAllCancel}
                        disabled={applyAllSaving}
                        className="rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleApplyAllConfirm}
                        disabled={applyAllSaving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {applyAllSaving && <Spinner />}
                        {applyAllSaving ? "Applying…" : "Confirm Apply to All"}
                      </button>
                    </div>
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

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
    </svg>
  );
}