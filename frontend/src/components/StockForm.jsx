import { useState } from "react";
import { STOCK_COLUMNS, STOCK_REQUIRED_KEYS } from "../constants/stockColumns";
import { createStock } from "../services/stockService";

function buildEmptyForm() {
  const form = {};
  STOCK_COLUMNS.forEach(({ key, type }) => {
    form[key] = type === "Number" ? "" : "";
  });
  return form;
}

/**
 * Add Stock — all 43 Stock Master fields (Section 7), generated from the
 * shared column list so it can never drift out of sync with the table.
 * Only the four matching-key fields (PlantName/MatNo/StockDate/
 * StorageLocation) are required; everything else is optional.
 */
export default function StockForm({ open, onClose, onSaved }) {
  const [form, setForm] = useState(buildEmptyForm);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate() {
    const errs = [];
    STOCK_REQUIRED_KEYS.forEach((key) => {
      const col = STOCK_COLUMNS.find((c) => c.key === key);
      if (!String(form[key] || "").trim()) errs.push(`${col.label} is required.`);
    });
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
      await createStock(form);
      onSaved();
      setForm(buildEmptyForm());
    } catch (err) {
      const serverErrors = err.response?.data?.errors || [err.response?.data?.message || "Could not save the stock record."];
      setErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="max-h-full w-full max-w-4xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="font-display text-base font-bold">Add Stock</h3>
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

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {STOCK_COLUMNS.map((col) => {
              const required = STOCK_REQUIRED_KEYS.includes(col.key);
              return (
                <div key={col.key} className="flex flex-col gap-1">
                  <label className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                    {col.label} {required && <span className="text-out">*</span>}
                  </label>
                  <input
                    type={col.type === "Date" ? "date" : col.type === "Number" ? "number" : "text"}
                    className="sn-input"
                    value={form[col.key]}
                    onChange={(e) => set(col.key, e.target.value)}
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
            <button type="button" onClick={onClose} className="sn-btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="sn-btn-primary disabled:opacity-60">
              {saving ? "Saving…" : "Add Stock"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
