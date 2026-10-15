import { useCallback, useEffect, useRef, useState } from "react";
import { approveRecommendation, fetchRecommendation, rejectRecommendation } from "../../services/distributionService";
import {
  DepotIdentity, Drawer, ErrorBanner, Field, KV, MaterialIdentity, PriorityBadge, RouteSections, SectionTitle, StatusBadge, dateTime, describeError,
  destinationSnapshotRows, forecastPeriodLabel, nameOr, num, sourceSnapshotRows, useSubmission,
} from "./shared";

/**
 * Recommendation details + review. Everything shown comes from the STORED
 * snapshot on the recommendation (never recalculated here), and the backend's
 * reason is displayed verbatim. Approve / Reject call the Stage 4 endpoints;
 * approval creates a REQUESTED transfer on the server — no stock moves.
 */
export default function RecommendationDrawer({ open, recommendationId, onClose, depotNames, materialNames, plantsByDepot, onChanged, onOpenTransfer }) {
  const [rec, setRec] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mode, setMode] = useState(null); // null | "approve" | "reject"
  const [approvedQuantity, setApprovedQuantity] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [formError, setFormError] = useState(null);
  const [createdTransfer, setCreatedTransfer] = useState(null);
  const submission = useSubmission();

  // A response for an earlier request (another record, or a reload overtaken
  // by a newer one) must never replace what the drawer now shows.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!recommendationId) return;
    const seq = ++loadSeq.current;
    setLoadError(null);
    try {
      const data = await fetchRecommendation(recommendationId);
      if (seq === loadSeq.current) setRec(data);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(describeError(err, "Could not load this recommendation."));
    }
  }, [recommendationId]);

  useEffect(() => {
    if (!open) return;
    setRec(null);
    setMode(null);
    setCreatedTransfer(null);
    setFormError(null);
    submission.reset();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recommendationId]);

  const cap = rec ? Math.min(rec.sourceSurplus, rec.destinationShortage) : 0;

  function startApprove() {
    setMode("approve");
    setApprovedQuantity(String(rec.recommendedQuantity));
    setReviewNotes("");
    setFormError(null);
    submission.reset();
  }

  function startReject() {
    setMode("reject");
    setReviewNotes("");
    setFormError(null);
    submission.reset();
  }

  async function confirm() {
    setFormError(null);
    let call;
    if (mode === "approve") {
      const qty = Number(approvedQuantity);
      if (!Number.isInteger(qty) || qty < 1) return setFormError("Approved quantity must be a whole number of at least 1.");
      if (qty > cap) return setFormError(`Approved quantity cannot exceed ${num(cap)} — the smaller of the source surplus and the destination shortage in this recommendation.`);
      const body = { approvedQuantity: qty, expectedVersion: rec.__v };
      if (reviewNotes.trim()) body.reviewNotes = reviewNotes.trim();
      call = (key) => approveRecommendation(rec._id, body, key);
    } else {
      if (!reviewNotes.trim()) return setFormError("A reason is required to reject a recommendation.");
      call = (key) => rejectRecommendation(rec._id, { reviewNotes: reviewNotes.trim(), expectedVersion: rec.__v }, key);
    }
    const result = await submission.submit(call);
    if (result) {
      setRec(result.recommendation);
      if (result.transfer) setCreatedTransfer(result.transfer);
      setMode(null);
      onChanged?.();
    }
  }

  // Reload the record after a conflict so the drawer reflects the current server state.
  useEffect(() => {
    if (submission.error?.status === 409) load();
  }, [submission.error, load]);

  const depotLabel = (id) => <DepotIdentity depotId={id} depotName={depotNames?.[id]} align="right" />;
  const plantLabel = (id) => (plantsByDepot?.[id]?.length ? plantsByDepot[id].join(", ") : "—");

  const footer = rec?.status === "PENDING" && (
    <div className="flex items-center justify-end gap-2">
      {mode === null && (
        <>
          <button onClick={startReject} className="sn-btn-ghost">Reject</button>
          <button onClick={startApprove} className="sn-btn-primary">Approve…</button>
        </>
      )}
      {mode !== null && (
        <>
          <button onClick={() => setMode(null)} disabled={submission.pending} className="sn-btn-ghost disabled:opacity-50">Back</button>
          <button
            onClick={confirm}
            disabled={submission.pending}
            className={`sn-btn-primary disabled:opacity-60 ${mode === "reject" ? "!bg-out hover:!bg-out/90" : ""}`}
          >
            {submission.pending ? "Submitting…" : mode === "approve" ? "Confirm Approval" : "Confirm Rejection"}
          </button>
        </>
      )}
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Distribution Recommendation"
      subtitle={rec ? `${nameOr(materialNames, rec.materialNo)} · ${nameOr(depotNames, rec.sourceDepotId)} to ${nameOr(depotNames, rec.destinationDepotId)}` : "Loading…"}
      badge={rec && <StatusBadge status={rec.status} />}
      footer={footer}
    >
      {!rec && !loadError && <div className="py-12 text-center text-sm text-gray-400">Loading recommendation…</div>}
      <ErrorBanner error={loadError} onRetry={load} />

      {rec && (
        <div className="flex flex-col">
          {createdTransfer && (
            <div className="mb-4 rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm">
              <div className="font-semibold text-healthy">Approved — transfer {createdTransfer.transferId} created (REQUESTED).</div>
              <div className="mt-0.5 text-gray-600">No stock has moved. The transfer still needs approval and dispatch.</div>
              <button onClick={() => onOpenTransfer?.(createdTransfer._id)} className="mt-2 text-xs font-semibold text-primary hover:underline">
                Open transfer {createdTransfer.transferId} →
              </button>
            </div>
          )}
          <StatusNote rec={rec} onOpenTransfer={onOpenTransfer} />

          <div className="mb-4">
            <MaterialIdentity materialNo={rec.materialNo} materialName={materialNames?.[rec.materialNo]} size="lg" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wide text-gray-500">Recommended Quantity</div>
              <div className="font-display text-2xl font-bold text-primary">{num(rec.recommendedQuantity)}</div>
            </div>
            <div className="rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wide text-gray-500">Priority</div>
              <div className="mt-1.5"><PriorityBadge priority={rec.priority} /></div>
            </div>
            <div className="rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wide text-gray-500">Forecast Period</div>
              <div className="mt-1 text-sm font-semibold">{forecastPeriodLabel(rec.forecastPeriod)}</div>
            </div>
          </div>

          <div className="mt-2">
          <RouteSections
            source={
              <KV rows={[
                ["Depot", depotLabel(rec.sourceDepotId)],
                ["Plant (current mapping)", plantLabel(rec.sourceDepotId)],
                ...sourceSnapshotRows(rec),
              ]} />
            }
            destination={
              <KV rows={[
                ["Depot", depotLabel(rec.destinationDepotId)],
                ["Plant (current mapping)", plantLabel(rec.destinationDepotId)],
                ...destinationSnapshotRows(rec),
              ]} />
            }
          />
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Snapshot values recorded by the engine at generation time. Stock in transit is never counted as transferable.
          </p>

          <SectionTitle>Reason</SectionTitle>
          <div className="whitespace-pre-line rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-relaxed text-[#1B2338]">{rec.reason}</div>

          <SectionTitle>Recommendation</SectionTitle>
          <KV rows={[
            ["Generation Run", <span key="r" className="font-mono text-xs">{rec.generationRunId || "—"}</span>],
            ["Generated At", dateTime(rec.generatedAt)],
            rec.generatedBy ? ["Generated By", rec.generatedBy] : null,
            ["Recommendation ID", <span key="i" className="font-mono text-xs">{rec._id}</span>],
          ]} />

          {mode === "approve" && (
            <ReviewForm title="Approve recommendation">
              <p className="text-sm text-gray-600">
                Approval creates a transfer in <b>REQUESTED</b> status. No stock moves until the transfer is dispatched. The server re-checks
                the source's live stock in hand and open commitments before approving.
              </p>
              <Field label="Approved Quantity" required hint={`Recommended ${num(rec.recommendedQuantity)} · maximum ${num(cap)} (smaller of surplus and shortage)`}>
                <input type="number" min={1} max={cap} step={1} className="sn-input" value={approvedQuantity} onChange={(e) => setApprovedQuantity(e.target.value)} />
              </Field>
              <Field label="Review Notes" hint="Optional">
                <textarea rows={2} className="sn-input" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
              </Field>
            </ReviewForm>
          )}
          {mode === "reject" && (
            <ReviewForm title="Reject recommendation">
              <p className="text-sm text-gray-600">Rejection is final for this recommendation. A new generation run can propose the route again.</p>
              <Field label="Reason" required>
                <textarea rows={3} className="sn-input" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} placeholder="Why is this transfer not going ahead?" />
              </Field>
            </ReviewForm>
          )}
          {formError && <div className="mt-3 rounded-lg border border-out/30 bg-out/5 px-4 py-2.5 text-sm text-out">{formError}</div>}
          {submission.error && <div className="mt-3"><ErrorBanner error={submission.error} /></div>}
        </div>
      )}
    </Drawer>
  );
}

function ReviewForm({ title, children }) {
  return (
    <div className="mt-5 rounded-lg border-2 border-primary/20 bg-white p-4">
      <h4 className="mb-3 font-display text-sm font-bold">{title}</h4>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function StatusNote({ rec, onOpenTransfer }) {
  if (rec.status === "APPROVED") {
    return (
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
        Approved <b>{num(rec.approvedQuantity)}</b> by {rec.reviewedBy} on {dateTime(rec.reviewedAt)}
        {rec.reviewNotes && <> — “{rec.reviewNotes}”</>}.
        {rec.transferId && (
          <button onClick={() => onOpenTransfer?.(null, rec.transferId)} className="ml-1 font-semibold text-primary hover:underline">
            Transfer {rec.transferId} →
          </button>
        )}
      </div>
    );
  }
  if (rec.status === "REJECTED") {
    return (
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
        Rejected by {rec.reviewedBy} on {dateTime(rec.reviewedAt)}: “{rec.reviewNotes}”
      </div>
    );
  }
  return null;
}
