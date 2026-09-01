import { useEffect, useState } from "react";
import { createMaterial, updateMaterial } from "../services/materialService";

const EMPTY = {
  materialNo: "",
  description: "",
  model: "",
  status: "STD",
  invCost: "",
  moq: "",
  type: "FG",
};

/**
 * Add/Edit Material — exactly the seven Material Master business fields.
 * Material No is required on create and disabled on edit (Section 15's
 * "not editable after creation" rule). No category, brand, supplier, unit
 * of measure, or other fields — this form intentionally stops at seven.
 */
export default function MaterialForm({ open, material, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const isEdit = Boolean(material);

  useEffect(() => {
    if (open) {
      setForm(
        material
          ? {
              materialNo: material.materialNo,
              description: material.description,
              model: material.model || "",
              status: material.status,
              invCost: material.invCost,
              moq: material.moq,
              type: material.type,
            }
          : EMPTY
      );
      setErrors([]);
    }
  }, [open, material]);

  if (!open) return null;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate() {
    const errs = [];
    if (!isEdit && !form.materialNo.trim()) errs.push("Material No is required.");
    if (!form.description.trim()) errs.push("Description is required.");
    if (!["STD", "Discontinued"].includes(form.status)) errs.push("Status must be selected.");
    if (!["FG", "RM"].includes(form.type)) errs.push("FG/RM must be selected.");
    const cost = Number(form.invCost);
    if (form.invCost === "" || Number.isNaN(cost) || cost < 0) errs.push("Inv Cost must be numeric.");
    const moq = Number(form.moq);
    if (form.moq === "" || Number.isNaN(moq) || moq <= 0) errs.push("MOQ must be a positive number.");
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
      const payload = { ...form };
      const saved = isEdit ? await updateMaterial(material._id, payload) : await createMaterial(payload);
      onSaved(saved);
    } catch (err) {
      const serverErrors = err.response?.data?.errors || [err.response?.data?.message || "Could not save the material."];
      setErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="font-display text-base font-bold">{isEdit ? "Edit Material" : "Add Material"}</h3>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Material No" required>
              <input
                className="sn-input disabled:cursor-not-allowed disabled:bg-gray-100"
                value={form.materialNo}
                disabled={isEdit}
                onChange={(e) => set("materialNo", e.target.value)}
                placeholder="MAT0001"
              />
            </Field>
            <Field label="Model">
              <input className="sn-input" value={form.model} onChange={(e) => set("model", e.target.value)} />
            </Field>

            <Field label="Description" required wide>
              <input className="sn-input" value={form.description} onChange={(e) => set("description", e.target.value)} />
            </Field>

            <Field label="Status" required>
              <select className="sn-input" value={form.status} onChange={(e) => set("status", e.target.value)}>
                <option value="STD">STD</option>
                <option value="Discontinued">Discontinued</option>
              </select>
            </Field>
            <Field label="FG / RM" required>
              <select className="sn-input" value={form.type} onChange={(e) => set("type", e.target.value)}>
                <option value="FG">FG</option>
                <option value="RM">RM</option>
              </select>
            </Field>

            <Field label="Inv Cost" required>
              <input
                type="number"
                step="0.01"
                className="sn-input"
                value={form.invCost}
                onChange={(e) => set("invCost", e.target.value)}
              />
            </Field>
            <Field label="MOQ" required>
              <input type="number" className="sn-input" value={form.moq} onChange={(e) => set("moq", e.target.value)} />
            </Field>
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
            <button type="button" onClick={onClose} className="sn-btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="sn-btn-primary disabled:opacity-60">
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Material"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, wide, children }) {
  return (
    <div className={`flex flex-col gap-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label} {required && <span className="text-out">*</span>}
      </label>
      {children}
    </div>
  );
}
