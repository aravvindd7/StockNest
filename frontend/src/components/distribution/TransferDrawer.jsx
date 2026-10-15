import { useCallback, useEffect, useState } from "react";
import { fetchTransfer, fetchTransferMovements } from "../../services/distributionService";
import TransferActionDialog from "./TransferActionDialog";
import {
  DepotIdentity, Drawer, ErrorBanner, KV, MaterialIdentity, RouteSections, SectionTitle, StatusBadge, dateTime, describeError, nameOr, num, statusLabel,
} from "./shared";

const STAGES = ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT", "RECEIVED"];

/** Valid actions per status — mirrors the backend lifecycle (the server stays authoritative). */
const ACTIONS_BY_STATUS = {
  REQUESTED: [["approve", "Approve"], ["cancel", "Cancel"]],
  APPROVED: [["dispatch", "Dispatch"], ["cancel", "Cancel"]],
  DISPATCHED: [["in-transit", "Mark In Transit"]],
  IN_TRANSIT: [["receive", "Receive"]],
  RECEIVED: [],
  CANCELLED: [],
};

/**
 * Transfer details: route, quantities, the lifecycle timeline (straight from
 * the backend's statusHistory — never reconstructed), the StockMovement ledger
 * and the valid next actions.
 */
export default function TransferDrawer({ open, transferId, onClose, depotNames, materialNames, plantsByDepot, onChanged }) {
  const [transfer, setTransfer] = useState(null);
  const [movements, setMovements] = useState([]);
  const [error, setError] = useState(null);
  const [action, setAction] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!transferId) return;
    setError(null);
    try {
      const t = await fetchTransfer(transferId);
      setTransfer(t);
      setMovements(["DISPATCHED", "IN_TRANSIT", "RECEIVED"].includes(t.status) ? await fetchTransferMovements(t._id) : []);
    } catch (err) {
      setError(describeError(err, "Could not load this transfer."));
    }
  }, [transferId]);

  useEffect(() => {
    if (!open) return;
    setTransfer(null);
    setMovements([]);
    setAction(null);
    setNotice(null);
    load();
  }, [open, transferId, load]);

  async function handleDone(result) {
    setAction(null);
    setTransfer(result.transfer);
    if (result.movements) setMovements((prev) => [...prev, ...result.movements]);
    setNotice(`${statusLabel(result.transfer.status)} — recorded by the server.${result.transitLoss ? ` Transit loss of ${num(result.transitLoss)} recorded.` : ""}`);
    onChanged?.();
    load(); // pick up the full ledger + history exactly as stored
  }

  const depotLabel = (id) => <DepotIdentity depotId={id} depotName={depotNames?.[id]} align="right" />;
  const plantOf = (stored, depotId) => stored || (plantsByDepot?.[depotId]?.length ? `${plantsByDepot[depotId].join(", ")} (current mapping)` : "—");

  const actions = transfer ? ACTIONS_BY_STATUS[transfer.status] || [] : [];
  const footer = transfer && (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-gray-500">{actions.length ? "Next step" : `No further actions — transfer is ${statusLabel(transfer.status)}.`}</span>
      <div className="flex gap-2">
        {actions.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setAction(key)}
            className={key === "cancel" ? "sn-btn-ghost !text-out hover:!border-out" : "sn-btn-primary"}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={transfer ? transfer.transferId : "Transfer"}
        subtitle={transfer ? `${nameOr(materialNames, transfer.materialNo)} · ${nameOr(depotNames, transfer.sourceDepotId)} to ${nameOr(depotNames, transfer.destinationDepotId)}` : "Loading…"}
        badge={transfer && <StatusBadge status={transfer.status} />}
        footer={footer}
      >
        {!transfer && !error && <div className="py-12 text-center text-sm text-gray-400">Loading transfer…</div>}
        <ErrorBanner error={error} onRetry={load} />
        {notice && <div className="mb-4 rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-2.5 text-sm text-healthy">{notice}</div>}

        {transfer && (
          <div className="flex flex-col">
            <div className="mb-1">
              <MaterialIdentity materialNo={transfer.materialNo} materialName={materialNames?.[transfer.materialNo]} size="lg" />
            </div>

            <RouteSections
              source={<KV rows={[["Depot", depotLabel(transfer.sourceDepotId)], ["Plant", plantOf(transfer.sourcePlantName, transfer.sourceDepotId)]]} />}
              destination={<KV rows={[["Depot", depotLabel(transfer.destinationDepotId)], ["Plant", plantOf(transfer.destinationPlantName, transfer.destinationDepotId)]]} />}
            />

            <SectionTitle>Quantities</SectionTitle>
            <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
              {[
                ["Requested", transfer.requestedQuantity],
                ["Approved", transfer.approvedQuantity],
                ["Dispatched", transfer.dispatchedQuantity],
                ["Received", transfer.receivedQuantity],
                ["Discrepancy", transfer.transitLossQuantity],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-gray-200 px-2 py-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
                  <div className={`font-display text-lg font-bold ${label === "Discrepancy" && value > 0 ? "text-out" : "text-[#1B2338]"}`}>{num(value)}</div>
                </div>
              ))}
            </div>
            {transfer.discrepancyReason && (
              <p className="mt-2 rounded-lg border border-out/20 bg-out/5 px-3 py-2 text-sm text-out">Discrepancy reason: {transfer.discrepancyReason}</p>
            )}

            <SectionTitle>Lifecycle</SectionTitle>
            <Timeline history={transfer.statusHistory || []} status={transfer.status} />

            <SectionTitle>Details</SectionTitle>
            <KV rows={[
              ["Reason", <span key="r" className="block max-w-sm whitespace-normal text-right font-normal">{transfer.reason}</span>],
              transfer.notes ? ["Notes", transfer.notes] : null,
              ["Origin", transfer.recommendationId ? "From an approved recommendation" : "Manual transfer"],
              transfer.cancellationReason ? ["Cancellation Reason", transfer.cancellationReason] : null,
              transfer.unitCost !== undefined ? ["Unit Cost (at dispatch)", num(transfer.unitCost)] : null,
            ]} />

            {movements.length > 0 && (
              <>
                <SectionTitle>Stock Movements (ledger)</SectionTitle>
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full whitespace-nowrap text-left text-[12px]">
                    <thead className="bg-gray-50 text-[10.5px] uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2">Movement</th>
                        <th className="px-3 py-2">Depot / Plant</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-right">SIH</th>
                        <th className="px-3 py-2 text-right">In Transit</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2">By / At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movements.map((m) => (
                        <tr key={m._id || `${m.movementType}-${m.side}`} className="border-t border-gray-100">
                          <td className="px-3 py-2 font-semibold">{m.movementType.replace("_", " ")}<span className="ml-1 text-[10px] font-normal text-gray-400">{m.side}</span></td>
                          <td className="px-3 py-2">{m.depotId} · {m.plantName}</td>
                          <td className="px-3 py-2 text-right font-semibold">{num(m.quantity)}</td>
                          <td className="px-3 py-2 text-right font-mono">{num(m.before.SIHQty)} → {num(m.after.SIHQty)}</td>
                          <td className="px-3 py-2 text-right font-mono">{num(m.before.SITQTY)} → {num(m.after.SITQTY)}</td>
                          <td className="px-3 py-2 text-right font-mono">{num(m.before.TotalStockQty)} → {num(m.after.TotalStockQty)}</td>
                          <td className="px-3 py-2 text-gray-500">{m.actor} · {dateTime(m.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>

      {action && transfer && (
        <TransferActionDialog
          action={action}
          transfer={transfer}
          labels={{
            material: nameOr(materialNames, transfer.materialNo),
            source: nameOr(depotNames, transfer.sourceDepotId),
            destination: nameOr(depotNames, transfer.destinationDepotId),
          }}
          onClose={() => setAction(null)}
          onDone={handleDone}
        />
      )}
    </>
  );
}

/** Vertical lifecycle from statusHistory. Stages not yet reached are shown muted; a cancellation ends the line. */
function Timeline({ history, status }) {
  const byStatus = Object.fromEntries(history.map((h) => [h.status, h]));
  const cancelled = byStatus.CANCELLED;
  const stages = cancelled ? [...STAGES.filter((s) => byStatus[s]), "CANCELLED"] : STAGES;
  return (
    <ol className="relative ml-2 border-l-2 border-gray-200">
      {stages.map((stage) => {
        const entry = byStatus[stage];
        const current = stage === status;
        return (
          <li key={stage} className="mb-4 ml-5 last:mb-0">
            <span
              className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 ${
                entry ? (stage === "CANCELLED" ? "border-gray-400 bg-gray-400" : current ? "border-primary bg-primary" : "border-healthy bg-healthy") : "border-gray-300 bg-white"
              }`}
            />
            <div className={`text-sm font-semibold ${entry ? "text-[#1B2338]" : "text-gray-400"}`}>
              {statusLabel(stage)}
              {current && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-primary">current</span>}
            </div>
            {entry ? (
              <div className="text-xs text-gray-500">
                {entry.changedBy} · {dateTime(entry.changedAt)}
                {entry.note && <div className="mt-0.5 text-gray-600">“{entry.note}”</div>}
              </div>
            ) : (
              <div className="text-xs text-gray-400">Not reached</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
