import ColumnFilter from "./table/ColumnFilter";

/**
 * Generic enterprise data table. Sorting and pagination are server-side —
 * this component only renders what it's given and reports user intent
 * (sort/page changes) back to the parent via callbacks.
 *
 * columns: [{ key, label, sortable?: bool, sticky?: bool, stickyOffset?: number,
 *              render?: (row) => node, className?: string,
 *              filterType?: "multiselect" | "range", filterKey?: string }]
 * `sticky` freezes a column while horizontally scrolling — stack sticky
 * columns left-to-right and give each one an increasing `stickyOffset`
 * (in px) equal to the summed width of the sticky columns before it.
 * `filterType` opts a column into the shared column-filter-icon system —
 * omit it and the column behaves exactly as before this upgrade.
 * rows: array of plain objects
 * sort / onSortChange: legacy plain sort props, still supported standalone.
 * filterState: optional — the object returned by useTableFilters(). When
 *   provided, it takes over sorting (so the column filter popup's Sort
 *   Asc/Desc and a plain header click stay in sync) and filter icons render
 *   for any column with a `filterType`.
 * getFilterOptions(field, search): required alongside filterState if any
 *   column uses filterType="multiselect" — fetches live distinct values.
 * instant: defaults to true (every filter edit applies immediately, no
 *   Apply button — the behavior everywhere else in the app). Pass false
 *   for a column filter popup with Apply/Cancel buttons instead (Sales
 *   Master's Detailed Records view uses this).
 * pagination: { page, totalPages, total, limit }  onPageChange(page)
 */
export default function DataTable({
  columns,
  rows,
  loading,
  sort,
  onSortChange,
  filterState,
  getFilterOptions,
  instant = true,
  pagination,
  onPageChange,
  onRowClick,
  emptyMessage = "No records match your filters.",
}) {
  const effectiveSort = filterState?.sort || sort;
  const effectiveToggleSort = filterState?.toggleSort || onSortChange;

  const stickyStyle = (col) =>
    col.sticky
      ? {
          position: "sticky",
          left: col.stickyOffset || 0,
          zIndex: 1,
          boxShadow: "2px 0 4px rgba(16,24,40,0.06)",
          width: col.width,
          minWidth: col.width,
        }
      : undefined;

  return (
    <div className="sn-card overflow-hidden">
      <div className="max-h-[620px] overflow-y-auto">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max whitespace-nowrap text-left text-[12.5px]">
            <thead>
            <tr>
              {columns.map((col) => {
                const isSorted = effectiveSort?.sortBy === col.key;
                const filterKey = col.filterKey || col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => col.sortable !== false && effectiveToggleSort?.(col.key)}
                    style={col.sticky ? { ...stickyStyle(col), zIndex: 11 } : undefined}
                    className={`sticky top-0 z-10 bg-navy px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[#C9D3EA] ${
                      col.sticky ? "bg-navy" : ""
                    } ${col.sortable !== false ? "cursor-pointer select-none hover:bg-navy-2" : ""}`}
                  >
                    {col.label}
                    {col.sortable !== false && (
                      <span className={`ml-1 text-[9px] ${isSorted ? "text-accent" : "opacity-50"}`}>
                        {isSorted ? (effectiveSort.sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    )}
                    {col.filterType && filterState && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <ColumnFilter
                          label={col.label}
                          type={col.filterType}
                          value={filterState.filters[filterKey]}
                          onChange={(v) => filterState.setFilterValue(filterKey, v)}
                          fetchOptions={col.filterType === "multiselect" || col.multiselect ? (search) => getFilterOptions(filterKey, search) : undefined}
                          sort={filterState.sort}
                          sortKey={col.key}
                          onSort={filterState.setSort}
                          instant={instant}
                        />
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}

            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-gray-400">
                  {emptyMessage}
                </td>
              </tr>
            )}

            {!loading &&
              rows.map((row, i) => (
                <tr
                  key={row._id || i}
                  onClick={() => onRowClick?.(row)}
                  className={`border-b border-gray-100 transition hover:bg-[#EAF2FF] ${
                    i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white"
                  } ${onRowClick ? "cursor-pointer" : ""}`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={stickyStyle(col)}
                      className={`px-3.5 py-2.5 ${col.sticky ? (i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white") : ""} ${col.className || ""}`}
                    >
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        </div>
      </div>

      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3">
          <span className="text-xs text-gray-500">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total.toLocaleString("en-IN")} records
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
              className="h-8 min-w-[32px] rounded-md border border-gray-200 px-2 text-xs font-medium disabled:opacity-40 enabled:hover:border-primary enabled:hover:text-primary"
            >
              Prev
            </button>
            <button
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
              className="h-8 min-w-[32px] rounded-md border border-gray-200 px-2 text-xs font-medium disabled:opacity-40 enabled:hover:border-primary enabled:hover:text-primary"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
