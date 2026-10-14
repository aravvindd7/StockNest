import { useEffect, useState } from "react";
import { transferAction } from "../../services/distributionService";
import { ErrorBanner, Field, num, useSubmission } from "./shared";

/**
 * One modal for every transfer lifecycle action. Each action's body matches
 * the backend contract exactly (controllers/distributionTransferController.js)
 * and the copy states plainly what happens physically. Stock is only ever
 * changed by the server — this dialog never computes or edits inventory.
 */
const ACTIONS = {
  approve: {
    path: "approve",
    title: "Approve transfer",
    confirm: "Approve Transfer",
    explain: (t) => `No stock moves on approval. ${num(t.requestedQuantity)} requested; the approved quantity is committed against ${t.sourceDepotId}'s stock in hand. The server re-checks live availability.`,
  },
  dispatch: {
    path: "dispatch",
    title: "Dispatch transfer",
    confirm: "Confirm Dispatch",
    irreversible: true,
    explain: (t) => `Stock moves now: ${t.sourceDepotId}'s stock in hand decreases and the goods become in-transit stock at ${t.destinationDepotId}. A dispatched transfer can no longer be cancelled.`,
  },
  "in-transit": {
    path: "in-transit",
    title: "Mark as in transit",
    confirm: "Mark In Transit",
    explain: () => "Confirms the goods are on the way. No stock quantities change at this step.",
  },
  receive: {
    path: "receive",
    title: "Receive transfer",
    confirm: "Confirm Receipt",
    irreversible: true,
    explain: (t) => `Stock moves now: ${t.destinationDepotId}'s in-transit stock is cleared and the received quantity is added to its stock in hand. Any shortfall is recorded as transit loss. Enter the quantity actually received.`,
  },
  cancel: {
    path: "cancel",
    title: "Cancel transfer",
    confirm: "Cancel Transfer",
    danger: true,
    explain: (t) => `No stock has moved yet. Cancelling releases the ${num(t.approvedQuantity ?? t.requestedQuantity)} units committed against ${t.sourceDepotId}. This cannot be undone.`,
  },
};

export default function TransferActionDialog({ action, transfer, onClose, onDone }) {
  const cfg = ACTIONS[action];
  const [qty, setQty] = useState("");
  const [text, setText] = useState(""); // reason / discrepancy reason
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState(null);
  const submission = useSubmission();

  useEffect(() => {
    if (!cfg || !transfer) return;
    setQty(action === "approve" ? String(transfer.requestedQuantity) : action === "dispatch" ? String(transfer.approvedQuantity) : "");
    setText("");
    setNotes("");
    setFormError(null);
    submission.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, transfer?._id]);

  if (!cfg || !transfer) return null;

  const dispatched = transfer.dispatchedQuantity;
  const receivedNum = qty === "" ? null : Number(qty);
  const loss = action === "receive" && Number.isInteger(receivedNum) ? dispatched - receivedNum : null;

  function buildBody() {
    const body = { expectedVersion: transfer.__v };
    const asInt = (v) => (v === "" ? NaN : Number(v));
    if (action === "approve") {
      const n = asInt(qty);
      if (!Number.isInteger(n) || n < 1) throw new Error("Approved quantity must be a whole number of at least 1.");
      if (n > transfer.requestedQuantity) throw new Error(`Approved quantity cannot exceed the requested ${num(transfer.requestedQuantity)}.`);
      body.approvedQuantity = n;
    }
    if (action === "dispatch") {
      const n = asInt(qty);
      if (!Number.isInteger(n) || n < 1) throw new Error("Dispatched quantity must be a whole number of at least 1.");
      if (n > transfer.approvedQuantity) throw new Error(`Dispatched quantity cannot exceed the approved ${num(transfer.approvedQuantity)}.`);
      body.dispatchedQuantity = n;
    }
    if (action === "receive") {
      const n = asInt(qty);
      if (!Number.isInteger(n) || n < 0) throw new Error("Enter the quantity actually received (a whole number, 0 or more).");
      if (n > dispatched) throw new Error(`Received quantity cannot exceed the dispatched ${num(dispatched)}.`);
      if (n < dispatched && !text.trim()) throw new Error(`A discrepancy reason is required — ${num(dispatched - n)} of ${num(dispatched)} dispatched units were not received.`);
      body.receivedQuantity = n;
      if (text.trim()) body.discrepancyReason = text.trim();
    }
    if (action === "cancel") {
      if (!text.trim()) throw new Error("A cancellation reason is required.");
      body.cancellationReason = text.trim();
    }
    if (action !== "cancel" && notes.trim()) body.notes = notes.trim();
    return body;
  }

  async function confirm() {
    setFormError(null);
    let body;
    try {
      body = buildBody();
    } catch (e) {
      setFormError(e.message);
      return;
    }
    const result = await submission.submit((key) => transferAction(transfer._id, cfg.path, body, key));
    if (result) onDone(result);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h3 className="font-display text-base font-bold">{cfg.title}</h3>
            <p className="text-xs text-gray-500">{transfer.transferId} · {transfer.materialNo} · {transfer.sourceDepotId} → {transfer.destinationDepotId}</p>
          </div>
          <button onClick={onClose} disabled={submission.pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <p className={`rounded-lg px-3 py-2.5 text-sm ${cfg.irreversible ? "border border-low/40 bg-low/10 text-[#92400E]" : "bg-gray-50 text-gray-600"}`}>
            {cfg.irreversible && <b>Irreversible. </b>}
            {cfg.explain(transfer)}
          </p>

          {action === "approve" && (
            <Field label="Approved Quantity" required hint={`Requested ${num(transfer.requestedQuantity)}`}>
              <input type="number" min={1} max={transfer.requestedQuantity} className="sn-input" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          )}
          {action === "dispatch" && (
            <Field label="Dispatched Quantity" required hint={`Approved ${num(transfer.approvedQuantity)}`}>
              <input type="number" min={1} max={transfer.approvedQuantity} className="sn-input" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          )}
          {action === "receive" && (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Mini label="Dispatched" value={num(dispatched)} />
                <Mini label="Received" value={qty === "" ? "—" : num(receivedNum)} />
                <Mini label="Discrepancy" value={loss === null ? "—" : num(Math.max(0, loss))} warn={loss > 0} />
              </div>
              <Field label="Received Quantity" required hint="Enter what was physically received — it is never assumed to equal the dispatched quantity.">
                <input type="number" min={0} max={dispatched} className="sn-input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`0 – ${dispatched}`} />
              </Field>
              <Field label="Discrepancy Reason" required={loss > 0} hint={loss > 0 ? `${num(loss)} units will be recorded as transit loss.` : "Required only when less is received than was dispatched."}>
                <textarea rows={2} className="sn-input" value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            </>
          )}
          {action === "cancel" && (
            <Field label="Cancellation Reason" required>
              <textarea rows={3} className="sn-input" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          {action !== "cancel" && (
            <Field label="Notes" hint="Optional — recorded in the transfer's status history.">
              <input className="sn-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          )}

          {formError && <div className="rounded-lg border border-out/30 bg-out/5 px-3 py-2.5 text-sm text-out">{formError}</div>}
          <ErrorBanner error={submission.error} />
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button onClick={onClose} disabled={submission.pending} className="sn-btn-ghost disabled:opacity-50">Close</button>
          <button
            onClick={confirm}
            disabled={submission.pending}
            className={`sn-btn-primary disabled:opacity-60 ${cfg.danger ? "!bg-out hover:!bg-out/90" : ""}`}
          >
            {submission.pending ? "Submitting…" : cfg.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, warn }) {
  return (
    <div className="rounded-lg border border-gray-200 px-2 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`font-display text-lg font-bold ${warn ? "text-out" : "text-[#1B2338]"}`}>{value}</div>
    </div>
  );
}
