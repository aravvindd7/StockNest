import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ConfirmDialog from "./ConfirmDialog";

const dateTimeStr = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const TYPE_STYLES = {
  APPEND: "bg-primary/10 text-primary",
  REPLACE: "bg-low/15 text-low",
  RESTORE: "bg-accent/10 text-accent",
  INITIAL: "bg-gray-100 text-gray-600",
};

/**
 * Generic Import History UI, shared by Material, Depot, and Stock Master.
 * Every entry here is an archived snapshot (never the live active data —
 * see models/DatasetHistory.js), so:
 *   - "View" restores that snapshot as active (and archives whatever was
 *     active a moment ago, so that's recoverable too).
 *   - "Remove" deletes the historical entry. This can never remove the
 *     active dataset, because the active dataset is never itself a history
 *     entry — there's nothing there to accidentally delete.
 */
export default function MasterImportHistoryPage({ title, moduleLabel, service, backLink }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [viewTarget, setViewTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    service
      .fetchHistory()
      .then(setRows)
      .catch((err) => setError(err.response?.data?.message || "Could not load import history."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleViewConfirmed() {
    if (!viewTarget) return;
    setBusy(true);
    try {
      const result = await service.viewHistory(viewTarget._id);
      setViewTarget(null);
      setNotice({ type: "success", text: `${viewTarget.batchId} is now the active ${moduleLabel} dataset (${result.restoredCount} records).` });
      load();
    } catch (err) {
      setError(err.response?.data?.message || "Could not restore this snapshot.");
      setViewTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveConfirmed() {
    if (!removeTarget) return;
    setBusy(true);
    try {
      const result = await service.removeHistory(removeTarget._id);
      setRemoveTarget(null);
      setNotice({ type: "success", text: `${result.batchId} removed from Import History.` });
      load();
    } catch (err) {
      setError(err.response?.data?.message || "Could not remove this import history entry.");
      setRemoveTarget(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold">{title}</h2>
          <p className="text-sm text-gray-500">
            Every archived {moduleLabel} snapshot, most recent first. The currently active dataset is never listed here — only past states are.
          </p>
        </div>
        <Link to={backLink} className="sn-btn-ghost">
          Back
        </Link>
      </div>

      {notice && <div className="rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm text-healthy">{notice.text}</div>}
      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="bg-navy text-[11px] uppercase tracking-wide text-[#C9D3EA]">
              <tr>
                <th className="px-4 py-3">File Name</th>
                <th className="px-4 py-3">Batch ID</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Imported By</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Total Rows</th>
                <th className="px-4 py-3">Added</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Failed</th>
                <th className="px-4 py-3">Records Archived</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-gray-400">Loading…</td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-gray-400">No import history yet.</td>
                </tr>
              )}
              {!loading &&
                rows.map((r, i) => (
                  <tr key={r._id} className={`border-t border-gray-100 ${i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white"}`}>
                    <td className="px-4 py-3">{r.fileName}</td>
                    <td className="px-4 py-3 font-mono text-xs">{r.batchId}</td>
                    <td className="px-4 py-3">
                      <span className={`sn-badge ${TYPE_STYLES[r.importType] || "bg-gray-100 text-gray-600"}`}>{r.importType}</span>
                    </td>
                    <td className="px-4 py-3">{r.importedBy}</td>
                    <td className="px-4 py-3 font-mono text-xs">{dateTimeStr(r.createdAt)}</td>
                    <td className="px-4 py-3 font-mono">{r.totalRows}</td>
                    <td className="px-4 py-3 font-mono text-healthy">{r.addedCount}</td>
                    <td className="px-4 py-3 font-mono text-accent">{r.updatedCount}</td>
                    <td className="px-4 py-3 font-mono text-out">{r.failedCount}</td>
                    <td className="px-4 py-3 font-mono">{r.recordCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <button onClick={() => setViewTarget(r)} className="text-xs font-semibold text-primary hover:underline">
                          View
                        </button>
                        <button onClick={() => setRemoveTarget(r)} className="text-xs font-semibold text-out hover:underline">
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(viewTarget)}
        title={`Restore ${viewTarget?.batchId} as the active dataset?`}
        message={
          viewTarget
            ? `This snapshot holds ${viewTarget.recordCount} record(s) from just before "${viewTarget.fileName}" was processed.\n\nRestoring it will archive whatever is currently active (so you can undo this too), then make this snapshot the active ${moduleLabel} dataset.\n\nDo you want to continue?`
            : ""
        }
        confirmLabel={busy ? "Restoring…" : "Restore as Active"}
        onConfirm={handleViewConfirmed}
        onCancel={() => setViewTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Remove this import history entry?"
        message={
          removeTarget
            ? `Batch: ${removeTarget.batchId}\nFile: ${removeTarget.fileName}\n\nThis permanently deletes this archived snapshot. It does not affect the currently active ${moduleLabel} dataset.\n\nThis action cannot be undone.`
            : ""
        }
        confirmLabel={busy ? "Removing…" : "Remove"}
        danger
        onConfirm={handleRemoveConfirmed}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
