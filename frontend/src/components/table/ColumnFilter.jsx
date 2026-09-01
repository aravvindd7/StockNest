import { useEffect, useRef, useState } from "react";

const TEXT_MODES = [
  { key: "values", label: "Select Values" },
  { key: "contains", label: "Contains" },
  { key: "startsWith", label: "Starts With" },
];

const NUMBER_OPS = [
  { key: "equals", label: "Equals" },
  { key: "gt", label: "Greater Than" },
  { key: "lt", label: "Less Than" },
  { key: "between", label: "Between" },
];

/**
 * The dropdown that opens from a column header's filter icon. By default
 * every interaction applies immediately (instant=true, the default) — no
 * Apply/Submit button, matching every other module's filtering.
 *
 * instant=false (used by Sales Master's Detailed Records view, per its
 * "Apply and Cancel buttons... not automatically apply while typing"
 * requirement) buffers edits in local draft state until Apply is clicked;
 * Cancel discards the draft and reverts to whatever was last applied. This
 * is the one place filtering behavior differs between modules — it's an
 * opt-in prop on the existing shared component, not a second filter system.
 *
 * type="text": mode-switchable — "Select Values" is a live-searched
 *   multiselect checkbox list (backed by fetchOptions), "Contains"/"Starts
 *   With" are single free-text inputs matched as a pattern.
 * type="number": operator-switchable — Equals/Greater Than/Less Than take
 *   one value, "Between" takes Min/Max (the default mode).
 *
 * value shape matches useTableFilters.js exactly:
 *   text:   { mode, values? } | { mode, text? }
 *   number: { op, value? } | { op: "between"|undefined, min?, max? }
 */
export default function ColumnFilter({ label, type, value, onChange, fetchOptions, sort, sortKey, onSort, instant = true }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [draft, setDraft] = useState(value);
  const containerRef = useRef(null);

  // In instant mode there's no separate draft — every edit IS the applied
  // value. In non-instant mode, edits go to `draft` until Apply.
  const effectiveValue = instant ? value : draft;
  const applyChange = instant ? onChange : setDraft;

  // Refresh the draft from the last-applied value whenever the popup opens,
  // so a previously cancelled edit doesn't linger.
  useEffect(() => {
    if (open && !instant) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mode = type === "text" ? effectiveValue?.mode || "values" : undefined;
  const op = type === "number" ? effectiveValue?.op || "between" : undefined;

  // The badge/dot reflects what's actually applied (`value`), never the
  // in-progress draft — so it doesn't light up before Apply is clicked.
  const isActive =
    type === "text"
      ? (value?.mode === "values" && value.values?.length > 0) || ((value?.mode === "contains" || value?.mode === "startsWith") && value.text)
      : Boolean(value && (value.value || value.min || value.max));

  useEffect(() => {
    if (!open || type !== "text" || mode !== "values" || !fetchOptions) return;
    setLoadingOptions(true);
    const t = setTimeout(() => {
      fetchOptions(search)
        .then(setOptions)
        .catch(() => setOptions([]))
        .finally(() => setLoadingOptions(false));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, mode]);

  // Click-outside, click-icon-again, and Escape all close the popup —
  // never force a user to hunt for a way out (Section "Filter Popup
  // Closing Behaviour"). In non-instant mode this behaves like Cancel
  // (the draft simply never got applied), not like a hidden Apply.
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    function handleKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleOption(opt) {
    const selected = effectiveValue?.mode === "values" ? effectiveValue.values || [] : [];
    const next = selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt];
    applyChange(next.length > 0 ? { mode: "values", values: next } : null);
  }

  function setTextMode(newMode) {
    if (newMode === "values") applyChange(null);
    else applyChange({ mode: newMode, text: effectiveValue?.mode === newMode ? effectiveValue.text : "" });
  }

  function setNumberOp(newOp) {
    applyChange(newOp === "between" ? null : { op: newOp, value: "" });
  }

  function handleApply() {
    onChange(draft);
    setOpen(false);
  }

  function handleCancel() {
    setDraft(value);
    setOpen(false);
  }

  const isSorted = sort?.sortBy === sortKey;

  return (
    <span className="relative inline-flex" ref={containerRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`ml-1 flex h-4 w-4 items-center justify-center rounded-sm transition ${
          isActive ? "text-accent" : "text-[#7C8AB5] hover:text-white"
        }`}
        title={`Filter ${label}`}
      >
        <svg viewBox="0 0 24 24" fill={isActive ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
        </svg>
        {isActive && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-6 z-40 w-60 rounded-lg border border-gray-200 bg-white normal-case tracking-normal text-[#1B2338] shadow-xl"
        >
          <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">Filter {label}</div>

          {type === "text" && (
            <>
              <div className="flex gap-1 border-b border-gray-100 px-2 py-1.5">
                {TEXT_MODES.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setTextMode(m.key)}
                    className={`rounded px-2 py-1 text-[10.5px] font-medium transition ${
                      mode === m.key ? "bg-primary/10 text-primary" : "text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {mode === "values" && (
                <>
                  <div className="border-b border-gray-100 px-2 py-2">
                    <input
                      autoFocus
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter…"
                      className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto px-2 py-1.5">
                    {loadingOptions && <div className="px-2 py-2 text-xs text-gray-400">Loading…</div>}
                    {!loadingOptions && (!Array.isArray(options) || options.length === 0) && (
                      <div className="px-2 py-2 text-xs text-gray-400">No matches.</div>
                    )}
                    {!loadingOptions && Array.isArray(options) &&
                      options.map((opt) => (
                        <label key={opt} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={effectiveValue?.mode === "values" && Array.isArray(effectiveValue.values) && effectiveValue.values.includes(opt)}
                            onChange={() => toggleOption(opt)}
                            className="h-3.5 w-3.5"
                          />
                          <span className="truncate">{opt}</span>
                        </label>
                      ))}
                  </div>
                </>
              )}

              {(mode === "contains" || mode === "startsWith") && (
                <div className="px-3 py-3">
                  <input
                    autoFocus
                    value={effectiveValue?.text || ""}
                    onChange={(e) => applyChange({ mode, text: e.target.value })}
                    placeholder={mode === "contains" ? "Contains…" : "Starts with…"}
                    className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-primary"
                  />
                </div>
              )}
            </>
          )}

          {type === "number" && (
            <>
              <div className="flex flex-wrap gap-1 border-b border-gray-100 px-2 py-1.5">
                {NUMBER_OPS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => setNumberOp(o.key)}
                    className={`rounded px-2 py-1 text-[10.5px] font-medium transition ${
                      op === o.key ? "bg-primary/10 text-primary" : "text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {op === "between" ? (
                <div className="flex flex-col gap-2 px-3 py-3">
                  <div>
                    <label className="text-[10px] uppercase text-gray-400">Minimum</label>
                    <input
                      type="number"
                      autoFocus
                      value={effectiveValue?.min ?? ""}
                      onChange={(e) => applyChange({ op: "between", min: e.target.value, max: effectiveValue?.max ?? "" })}
                      className="mt-0.5 w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase text-gray-400">Maximum</label>
                    <input
                      type="number"
                      value={effectiveValue?.max ?? ""}
                      onChange={(e) => applyChange({ op: "between", min: effectiveValue?.min ?? "", max: e.target.value })}
                      className="mt-0.5 w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  </div>
                </div>
              ) : (
                <div className="px-3 py-3">
                  <input
                    type="number"
                    autoFocus
                    value={effectiveValue?.value ?? ""}
                    onChange={(e) => applyChange({ op, value: e.target.value })}
                    className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs outline-none focus:border-primary"
                  />
                </div>
              )}
            </>
          )}

          {onSort && (
            <div className="border-t border-gray-100 py-1">
              <button
                onClick={() => onSort(sortKey, "asc")}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${isSorted && sort.sortDir === "asc" ? "text-primary font-semibold" : "text-gray-600"}`}
              >
                Sort Ascending
              </button>
              <button
                onClick={() => onSort(sortKey, "desc")}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${isSorted && sort.sortDir === "desc" ? "text-primary font-semibold" : "text-gray-600"}`}
              >
                Sort Descending
              </button>
              {isSorted && (
                <button onClick={() => onSort(sortKey, null)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50">
                  Clear Sorting
                </button>
              )}
            </div>
          )}

          {Boolean(effectiveValue) && (
            <div className="border-t border-gray-100 py-1">
              <button onClick={() => applyChange(null)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-out hover:bg-out/5">
                Clear Filter
              </button>
            </div>
          )}

          {!instant && (
            <div className="flex gap-2 border-t border-gray-100 px-3 py-2.5">
              <button onClick={handleCancel} className="flex-1 rounded-md border border-gray-200 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleApply} className="flex-1 rounded-md bg-primary py-1.5 text-xs font-semibold text-white hover:bg-primary/90">
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
