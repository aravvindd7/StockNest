import { useCallback, useMemo, useState } from "react";

/**
 * Shared filter/sort state, reused by every master module's table. This is
 * the "Filter State Manager" in the architecture diagram — it never talks
 * to the backend itself, it just tracks what's active and turns that into
 * query params. Each module supplies its own `filterConfig` (which columns
 * are filterable, and how) but the state machine is identical everywhere,
 * so there's exactly one filtering implementation to maintain, not five.
 *
 * filterConfig: [{ key, label, type: "text" | "number", dbField? }]
 *   dbField defaults to `key` if the API's query param name differs from
 *   the column key.
 *
 * Filter value shapes (mirrors backend/utils/queryFilterBuilder.js exactly):
 *   text:   { mode: "values", values: string[] }
 *         | { mode: "contains" | "startsWith", text: string }
 *   number: { op: "equals" | "gt" | "lt", value: string }
 *         | { op: "between" | undefined, min: string, max: string }
 *
 * Column filters and Advanced-Filter-drawer filters share the exact same
 * underlying state — a column filter IS just a shortcut into the same
 * filter set the drawer edits, so chips/clear-all work uniformly for both.
 */
export function useTableFilters({ filterConfig = [], defaultSort = null } = {}) {
  const [filters, setFilters] = useState({}); // { [key]: filterValue }
  const [search, setSearch] = useState("");
  const [sort, setSortState] = useState(defaultSort ? { sortBy: defaultSort, sortDir: "asc" } : { sortBy: null, sortDir: "asc" });

  const configByKey = useMemo(() => Object.fromEntries(filterConfig.map((f) => [f.key, f])), [filterConfig]);

  function isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (value.mode === "values") return !value.values || value.values.length === 0;
    if (value.mode === "contains" || value.mode === "startsWith") return !value.text;
    if (value.op === "equals" || value.op === "gt" || value.op === "lt") return value.value === undefined || value.value === "";
    return (value.min === undefined || value.min === "") && (value.max === undefined || value.max === "");
  }

  const setFilterValue = useCallback((key, value) => {
    setFilters((prev) => {
      if (isEmptyValue(value)) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const clearFilter = useCallback((key) => setFilterValue(key, null), [setFilterValue]);

  const clearAll = useCallback(() => {
    setFilters({});
    setSearch("");
  }, []);

  /** Explicit sort (used by the column filter popup's Sort Asc/Desc/Clear buttons). */
  const setSort = useCallback((key, dir) => {
    setSortState(dir ? { sortBy: key, sortDir: dir } : { sortBy: null, sortDir: "asc" });
  }, []);

  /** Click-to-toggle sort (used by a plain header click, same as before this upgrade). */
  const toggleSort = useCallback((key) => {
    setSortState((prev) => (prev.sortBy === key ? { sortBy: key, sortDir: prev.sortDir === "asc" ? "desc" : "asc" } : { sortBy: key, sortDir: "asc" }));
  }, []);

  /** Human-readable summary for a chip/drawer label. */
  function describeValue(value) {
    if (value.mode === "values") return value.values.join(", ");
    if (value.mode === "contains") return `contains "${value.text}"`;
    if (value.mode === "startsWith") return `starts with "${value.text}"`;
    if (value.op === "equals") return `= ${value.value}`;
    if (value.op === "gt") return `> ${value.value}`;
    if (value.op === "lt") return `< ${value.value}`;
    return [value.min !== "" && value.min !== undefined && `≥${value.min}`, value.max !== "" && value.max !== undefined && `≤${value.max}`]
      .filter(Boolean)
      .join(" ");
  }

  /** Flattened for chips: [{ key, label, display, onRemove }]. */
  const activeChips = useMemo(() => {
    return Object.entries(filters).map(([key, value]) => {
      const cfg = configByKey[key] || { label: key };
      return { key, label: cfg.label, display: describeValue(value), onRemove: () => clearFilter(key) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, configByKey, clearFilter]);

  /** Builds the query-string params object the API expects (mirrors queryFilterBuilder.js). */
  const queryParams = useMemo(() => {
    const params = {};
    if (search) params.search = search;

    Object.entries(filters).forEach(([key, value]) => {
      const cfg = configByKey[key];
      const dbField = cfg?.dbField || key;

      if (value.mode === "values") {
        if (value.values.length > 0) params[dbField] = value.values.join(",");
      } else if (value.mode === "contains" || value.mode === "startsWith") {
        params[`${dbField}Mode`] = value.mode;
        params[`${dbField}Text`] = value.text;
      } else if (value.op === "equals" || value.op === "gt" || value.op === "lt") {
        params[`${dbField}Op`] = value.op;
        params[`${dbField}Value`] = value.value;
      } else {
        if (value.min !== undefined && value.min !== "") params[`${dbField}Min`] = value.min;
        if (value.max !== undefined && value.max !== "") params[`${dbField}Max`] = value.max;
      }
    });

    if (sort.sortBy) {
      params.sortBy = sort.sortBy;
      params.sortDir = sort.sortDir;
    }
    return params;
  }, [filters, search, sort, configByKey]);

  return {
    filters,
    search,
    setSearch,
    sort,
    setFilterValue,
    clearFilter,
    clearAll,
    setSort,
    toggleSort,
    activeChips,
    queryParams,
    hasActiveFilters: Object.keys(filters).length > 0 || Boolean(search),
  };
}
