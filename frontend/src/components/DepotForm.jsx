import { useEffect, useState } from "react";
import { createDepot, updateDepot } from "../services/depotService";

const EMPTY = { depotId: "", depotName: "" };

/**
 * Add/Edit Depot — exactly two fields (Depot ID, Depot Name), per the
 * Depot Master spec. Depot ID is editable (not locked like Material No)
 * since nothing yet references it as a foreign key; uniqueness is
 * re-validated server-side on every save regardless.
 */
export default function DepotForm({ open, depot, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const isEdit = Boolean(depot);

  useEffect(() => {
    if (open) {
      setForm(depot ? { depotId: depot.depotId, depotName: depot.depotName } : EMPTY);
      setErrors([]);
    }
  }, [open, depot]);

  if (!open) return null;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate() {
    const errs = [];
    if (!form.depotId.trim()) errs.push("Depot ID is required.");
    if (!form.depotName.trim()) errs.push("Depot Name is required.");
    return errs;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const clientErrors = validate();
    if (clientErrors.length) {
      setErrors(clientErrors);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      const payload = { depotId: form.depotId.trim(), depotName: form.depotName.trim() };
      const saved = isEdit ? await updateDepot(depot._id, payload) : await createDepot(payload);
      onSaved(saved);
    } catch (err) {
      const serverErrors = err.response?.data?.errors || [err.response?.data?.message || "Could not save the depot."];
      setErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="font-display text-base font-bold">{isEdit ? "Edit Depot" : "Add Depot"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5">
          {errors.length > 0 && (
            <div className="mb-4 rounded-lg border border-out/30 bg-out/5 px-3 py-2.5 text-sm text-out">
              <ul className="list-inside list-disc">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-4">
            <Field label="Depot ID" required>
              <input
                className="sn-input"
                value={form.depotId}
                onChange={(e) => set("depotId", e.target.value)}
                placeholder="DEP001"
              />
            </Field>
            <Field label="Depot Name" required>
              <input
                className="sn-input"
                value={form.depotName}
                onChange={(e) => set("depotName", e.target.value)}
                placeholder="Chennai Central Depot"
              />
            </Field>
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
            <button type="button" onClick={onClose} className="sn-btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="sn-btn-primary disabled:opacity-60">
              {saving ? "Saving…" : "Save Depot"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label} {required && <span className="text-out">*</span>}
      </label>
      {children}
    </div>
  );
}
