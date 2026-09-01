import { useCallback, useEffect, useState } from "react";
import PlanningTable from "../components/PlanningTable";
import ForecastDrawer from "../components/ForecastDrawer";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { fetchPlanningData, fetchPlanningYears } from "../services/planningService";

// Planning Master's filters are the "intelligent" kind (Trend, Growth %,
// Forecast Confidence, Stock Risk) — there's no natural per-column icon
// here since the table is pivoted (each row spans multiple years/quarters,
// not a single filterable value per column), so these surface through the
// Advanced Filter drawer only. Material Number/Name filtering is already
// covered by the existing search box. Filtering NEVER touches the
// forecasting math itself — see services/planningService.js's
// applyPlanningFilters, which runs strictly after the forecast is computed.
const FILTER_CONFIG = [
  { key: "trend", label: "Trend" },
  { key: "stockRisk", label: "Stock Risk" },
  { key: "growthPct", label: "Growth %" },
  { key: "confidence", label: "Forecast Confidence" },
];

const ADVANCED_FIELDS = [
  { key: "trend", label: "Trend", type: "multiselect", staticOptions: ["up", "down", "flat"] },
  { key: "stockRisk", label: "Stock Risk", type: "multiselect", staticOptions: ["Low", "Healthy", "Overstock"] },
  { key: "growthPct", label: "Growth %", type: "range" },
  { key: "confidence", label: "Forecast Confidence", type: "range" },
];

/**
 * Planning Master — read-only analytical view across Material, Stock, and
 * Sales Master. No Add/Edit/Delete/Import/Export/Refresh/model selector —
 * this page only ever calls GET, and the forecasting engine runs
 * automatically server-side (services/planningService.js).
 */
export default function PlanningMaster() {
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG });
  const [yearOptions, setYearOptions] = useState([]);
  const [startYear, setStartYear] = useState(null);

  const [years, setYears] = useState([]);
  const [forecastYear, setForecastYear] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [drawerTarget, setDrawerTarget] = useState(null); // { row, quarter } | null

  // Load the selectable starting-year options once.
  useEffect(() => {
    fetchPlanningYears()
      .then((opts) => {
        setYearOptions(opts);
        if (opts.length > 0) setStartYear(opts[0].value);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPlanningData({ ...filterState.queryParams, startYear: startYear || undefined });
      setYears(result.years);
      setForecastYear(result.forecastYear);
      setRows(result.data);
      if (!startYear) setStartYear(result.startYear);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load the planning view. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams, startYear]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Planning Master</h2>
          <p className="text-sm text-gray-500">
            Read-only analytical view. Historical sales, automatic forecast, current stock, trend, and recommended
            stock — sourced from Material, Stock, and Sales Master.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Financial Year</label>
          <select
            className="sn-input min-w-[140px]"
            value={startYear ?? ""}
            onChange={(e) => setStartYear(Number(e.target.value))}
          >
            {yearOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      <div className="sn-card p-4">
        <div className="flex max-w-md items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-gray-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            className="w-full border-none bg-transparent text-sm outline-none"
            placeholder="Search Material Number, Name, Description, or Model…"
            value={filterState.search}
            onChange={(e) => filterState.setSearch(e.target.value)}
          />
        </div>
      </div>

      <FilterManager filterState={filterState} advancedFields={ADVANCED_FIELDS} />

      {years.length > 0 && (
        <PlanningTable
          years={years}
          forecastYear={forecastYear}
          rows={rows}
          loading={loading}
          onForecastCellClick={(row, quarter) => setDrawerTarget({ row, quarter })}
        />
      )}

      <p className="text-xs text-gray-400">
        Safety Stock is a computed heuristic (half of average quarterly sales) — Stock Master doesn't currently store a
        dedicated safety-stock value. Forecast quarters are generated automatically by the Planning Engine — click any
        forecast quarter cell for details.
      </p>

      <ForecastDrawer
        open={Boolean(drawerTarget)}
        row={drawerTarget?.row}
        quarter={drawerTarget?.quarter}
        forecastYear={forecastYear}
        onClose={() => setDrawerTarget(null)}
      />
    </div>
  );
}
