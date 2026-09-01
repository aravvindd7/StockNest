import { useState } from "react";
import { SALES_COLUMNS, SALES_FORM_KEYS, SALES_REQUIRED_KEYS, ALL_MONTHS } from "../constants/salesColumns";
import { createSales } from "../services/salesService";

function buildEmptyForm() {
  const form = {};
  SALES_FORM_KEYS.forEach((key) => {
    form[key] = "";
  });
  return form;
}

/**
 * Add Sales — the 17 user-entered Sales Master fields (everything except
 * Quarter and Period, both server-derived — see salesController.js's
 * buildSalesPayload). Only the matching-key fields (Material Number/
 * Description, Plant, Financial Year, Month) are required; the rest are
 * optional, matching the restored operational ERP field set.
 */
export default function SalesForm({ open, onClose, onSaved }) {
  const [form, setForm] = useState(buildEmptyForm);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate() {
    const errs = [];
    SALES_REQUIRED_KEYS.forEach((key) => {
      const col = SALES_COLUMNS.find((c) => c.key === key);
      if (!String(form[key] || "").trim()) errs.push(`${col.label} is required.`);
    });
    if (form.FinancialYear && !/^\d{4}-\d{2}$/.test(form.FinancialYear.trim())) {
      errs.push('Financial Year must be in "YYYY-YY" format, e.g. "2025-26".');
    }
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
      await createSales(form);
      onSaved();
      setForm(buildEmptyForm());
    } catch (err) {
      const serverErrors = err.response?.data?.errors || [err.response?.data?.message || "Could not save the sales record."];
      setErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="font-display text-base font-bold">Add Sales</h3>
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

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SALES_COLUMNS.filter((col) => !["Quarter", "Period"].includes(col.key)).map((col) => {
              const required = SALES_REQUIRED_KEYS.includes(col.key);
              return (
                <div key={col.key} className="flex flex-col gap-1">
                  <label className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                    {col.label} {required && <span className="text-out">*</span>}
                  </label>
                  {col.key === "Month" ? (
                    <select className="sn-input" value={form.Month} onChange={(e) => set("Month", e.target.value)}>
                      <option value="">Select…</option>
                      {ALL_MONTHS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : col.key === "Status" ? (
                    <select className="sn-input" value={form.Status} onChange={(e) => set("Status", e.target.value)}>
                      <option value="">Select…</option>
                      <option value="Active">Active</option>
                      <option value="Hold">Hold</option>
                    </select>
                  ) : (
                    <input
                      type={col.type === "Number" ? "number" : "text"}
                      className="sn-input"
                      value={form[col.key]}
                      placeholder={col.key === "FinancialYear" ? "2025-26" : undefined}
                      onChange={(e) => set(col.key, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-gray-400">
            Quarter and Period are calculated automatically from Financial Year + Month — neither is entered manually.
          </p>

          <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
            <button type="button" onClick={onClose} className="sn-btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="sn-btn-primary disabled:opacity-60">
              {saving ? "Saving…" : "Add Sales"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
