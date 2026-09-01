/**
 * Generic yes/no confirmation modal. Section 16's delete-confirmation
 * flow is the primary use case, but this is intentionally generic so it
 * can be reused anywhere else a destructive action needs a guard.
 */
export default function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", danger = false, onConfirm, onCancel }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="font-display text-base font-bold text-[#1B2338]">{title}</h3>
        <p className="mt-2 whitespace-pre-line text-sm text-gray-500">{message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="sn-btn-ghost">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`sn-btn-primary ${danger ? "!bg-out !border-out hover:!bg-out/90" : ""}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
