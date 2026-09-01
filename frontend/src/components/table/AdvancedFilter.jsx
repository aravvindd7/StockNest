import { useEffect, useState } from "react";

/**
 * Right-side drawer for filters that don't map neatly to a single table
 * column (or that a module wants exposed more prominently). Shares the
 * exact same filter state as the column-header filters — a field can
 * appear in both places and stay in sync, since both write into the same
 * `useTableFilters` state via `setFilterValue`.
 *
 * Numeric fields here are Min/Max only (matching the spec's own Advanced
 * Filter example — "Sales Quantity: Minimum ___ Maximum ___"); the fuller
 * Equals/Greater Than/Less Than set lives in the column-icon popup.
 *
 * instant=true (default): every edit applies immediately, matching every
 *   other module's drawer.
 * instant=false: edits are buffered in one drawer-level draft object and
 *   only committed when Apply is clicked; Cancel discards them and closes
 *   without changing anything (Sales Master's Detailed Records view uses
 *   this). Reset Filters still clears immediately either way — it's an
 *   unambiguous action, not something that benefits from a confirm step.
 *
 * fields: [{ key, label, type: "text" | "number", fetchOptions?, staticOptions? }]
 */
export default function AdvancedFilter({ open, onClose, fields, filters, setFilterValue, clearAll, hasActiveFilters, instant = true }) {
  const [draft, setDraft] = useState(filters);

  useEffect(() => {
    if (open && !instant) setDraft(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const effectiveFilters = instant ? filters : draft;
  const setValue = instant ? setFilterValue : (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  function handleApply() {
    Object.entries(draft).forEach(([key, value]) => setFilterValue(key, value));
    onClose();
  }

  function handleCancel() {
    setDraft(filters);
    onClose();
  }

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-sm transform bg-white shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h3 className="font-display text-base font-bold">Advanced Filters</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-5">
              {fields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{field.label}</label>
                  {field.type === "text" ? (
                    <AdvancedTextValues
                      value={effectiveFilters[field.key]}
                      onChange={(v) => setValue(field.key, v)}
                      fetchOptions={field.fetchOptions}
                      staticOptions={field.staticOptions}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        placeholder="Minimum"
                        value={effectiveFilters[field.key]?.min ?? ""}
                        onChange={(e) => setValue(field.key, { op: "between", min: e.target.value, max: effectiveFilters[field.key]?.max ?? "" })}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-gray-300">–</span>
                      <input
                        type="number"
                        placeholder="Maximum"
                        value={effectiveFilters[field.key]?.max ?? ""}
                        onChange={(e) => setValue(field.key, { op: "between", min: effectiveFilters[field.key]?.min ?? "", max: e.target.value })}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 border-t border-gray-100 px-6 py-4">
            <button onClick={clearAll} disabled={!hasActiveFilters} className="sn-btn-ghost flex-1 justify-center disabled:opacity-40">
              Reset Filters
            </button>
            {!instant && (
              <>
                <button onClick={handleCancel} className="flex-1 rounded-lg border border-gray-200 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleApply} className="flex-1 rounded-lg bg-primary py-2 text-sm font-semibold text-white hover:bg-primary/90">
                  Apply
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * "Select Values" for the drawer — a fixed tag-button set for small enums
 * (Status, FG/RM, ...) or a live-searched checkbox list for larger ones
 * (Material Number, Depot Name, ...). Both write { mode: "values", values }
 * and both are instant — no apply button.
 */
function AdvancedTextValues({ value, onChange, fetchOptions, staticOptions }) {
  const selected = value?.mode === "values" ? value.values : [];

  function toggle(opt) {
    const next = selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt];
    onChange(next.length > 0 ? { mode: "values", values: next } : null);
  }

  if (staticOptions) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {staticOptions.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                active ? "border-primary bg-primary/10 text-primary" : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );
  }

  return <AdvancedLiveSearch selected={selected} onToggle={toggle} fetchOptions={fetchOptions} />;
}

function AdvancedLiveSearch({ selected, onToggle, fetchOptions }) {
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fetchOptions) return;
    setLoading(true);
    const t = setTimeout(() => {
      fetchOptions(search)
        .then(setOptions)
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="rounded-lg border border-gray-200">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search…"
        className="w-full border-b border-gray-100 px-3 py-2 text-sm outline-none"
      />
      <div className="max-h-40 overflow-y-auto p-1.5">
        {loading && <div className="px-2 py-2 text-xs text-gray-400">Loading…</div>}
        {!loading && options.length === 0 && <div className="px-2 py-2 text-xs text-gray-400">No matches.</div>}
        {!loading &&
          options.map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-50">
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} className="h-3.5 w-3.5" />
              <span className="truncate">{opt}</span>
            </label>
          ))}
      </div>
    </div>
  );
}
