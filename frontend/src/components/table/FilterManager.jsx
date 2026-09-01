import { useState } from "react";
import FilterChip from "./FilterChip";
import AdvancedFilter from "./AdvancedFilter";

/**
 * The piece every module page drops in once: the "Advanced Filter"
 * trigger, the active-filter chip row with "Clear All", and the drawer
 * itself. Takes the object returned by useTableFilters() plus a module's
 * advancedFields config — this is what makes adding filtering to a new
 * module a few lines, not a new implementation.
 */
export default function FilterManager({ filterState, advancedFields, instant = true }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { filters, activeChips, setFilterValue, clearAll, hasActiveFilters } = filterState;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setDrawerOpen(true)} className="sn-btn-ghost sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
          </svg>
          Advanced Filter
        </button>

        {activeChips.length > 0 && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Active Filters:</span>
            {activeChips.map((chip) => (
              <FilterChip key={chip.key} label={chip.label} display={chip.display} onRemove={chip.onRemove} />
            ))}
            <button onClick={clearAll} className="text-xs font-semibold text-out hover:underline">
              Clear All
            </button>
          </>
        )}
      </div>

      <AdvancedFilter
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        fields={advancedFields}
        filters={filters}
        setFilterValue={setFilterValue}
        clearAll={clearAll}
        hasActiveFilters={hasActiveFilters}
        instant={instant}
      />
    </div>
  );
}
