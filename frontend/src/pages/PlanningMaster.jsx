import { useCallback, useEffect, useState } from "react";
import PlanningTable from "../components/PlanningTable";
import ForecastDrawer from "../components/ForecastDrawer";
import PlanDetailsDrawer from "../components/PlanDetailsDrawer";
import FilterManager from "../components/table/FilterManager";
import { useTableFilters } from "../components/table/useTableFilters";
import { fetchPlanningComparison, regenerateForecast } from "../services/planningService";

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
  { key: "stockRisk", label: "Stock Risk", type: "multiselect", staticOptions: ["Low", "Healthy"] },
  { key: "growthPct", label: "Growth %", type: "range" },
  { key: "confidence", label: "Forecast Confidence", type: "range" },
];

/**
 * Planning Master — read-only fixed Active-FY operational timeline across
 * Material, Stock, Sales Master, and ForecastPredictions. No Add/Edit/
 * Delete/Import/Export/Refresh/model selector — this page only ever calls
 * GET (plus the explicit admin-only Regenerate Forecast trigger), and the
 * forecasting engine runs server-side (services/planningService.js).
 *
 * The table shows a fixed, clock-derived window of three FY groups:
 * Previous FY | Previous FY | Active FY (e.g. 2024-25 | 2025-26 | 2026-27
 * ACTIVE). The Active FY is a per-month hybrid of actuals + forecast. PLAN
 * (the current working quarter's demand) and REQUIRED STOCK sit alongside
 * it as the operational decision layer.
 */
export default function PlanningMaster() {
  const filterState = useTableFilters({ filterConfig: FILTER_CONFIG });

  const [groups, setGroups] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [timeline, setTimeline] = useState(null); // { activeFY, workingQuarter, activeMonth, previousFY, hasForecastData }
  const [drawerTarget, setDrawerTarget] = useState(null); // { row, fyValue, quarter, mode } | null
  const [planTarget, setPlanTarget] = useState(null); // row | null → Plan Details sidebar
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPlanningComparison({ ...filterState.queryParams });
      setGroups(result.groups);
      setRows(result.data);
      setTimeline({
        activeFY: result.activeFY,
        workingQuarter: result.workingQuarter,
        activeMonth: result.activeMonth,
        previousFY: result.previousFY,
        hasForecastData: result.hasForecastData,
      });
    } catch (err) {
      setError(err.response?.data?.message || "Could not load the planning view. Is the backend running?");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState.queryParams]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      await regenerateForecast();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "Regeneration failed. Is the ML service running?");
    } finally {
      setRegenerating(false);
    }
  };

  // A quarter cell's mode decides which drawer opens. The service marks cells
  // "actual" | "forecast" | "none", while the drawer contract is
  // "historical" | "forecast" — normalize at this routing boundary:
  //   - forecast-backed cell  → Forecast Details drawer
  //   - actual cell (historical FY, or an elapsed Active FY quarter)
  //   → the historical/actual drawer
  //   - "none" cells are never rendered clickable.
  // This keeps a purely historical quarter out of the Forecast branch.
  const handleCellClick = (row, fyValue, quarter) => {
    const block = row.years?.[fyValue];
    const cellMode = block?.quarters?.[quarter]?.mode;
    if (!cellMode || cellMode === "none") return;
    const mode = cellMode === "forecast" ? "forecast" : "historical";
    setDrawerTarget({ row, fyValue, quarter, mode });
  };

  const handlePlanClick = (row) => setPlanTarget(row);

  // Resolve the drawer's payload from the clicked cell.
  const target = drawerTarget;
  const targetGroup = target ? groups.find((g) => g.viewYear.value === target.fyValue) : null;
  const targetBlock = target ? target.row?.years?.[target.fyValue] : null;
  const targetCell = targetBlock ? targetBlock.quarters?.[target.quarter] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Planning Master</h2>
          <p className="text-sm text-gray-500">
            Read-only fixed Active-FY operational timeline (Previous FY · Previous FY · Active FY) — derived from the
            server clock and rolling forward automatically. The Active FY mixes elapsed months' real Sales Master actuals
            with future months' existing forecast. Click an actual quarter for monthly sales, a forecast quarter for
            forecast details, or a PLAN cell for the working-quarter plan.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRegenerate}
            disabled={regenerating || loading}
            className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-2 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {regenerating ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                </svg>
                Regenerating…
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Regenerate Forecast
              </>
            )}
          </button>
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

      {groups.length > 0 && (
        <PlanningTable
          groups={groups}
          rows={rows}
          loading={loading}
          onCellClick={handleCellClick}
          onPlanClick={handlePlanClick}
          workingQuarter={timeline?.workingQuarter}
          activeFY={timeline?.activeFY}
          hasForecastData={Boolean(timeline?.hasForecastData)}
        />
      )}

      <p className="text-xs text-gray-400">
        Safety Stock is a computed heuristic (half of average quarterly sales) — Stock Master doesn't currently store a
        dedicated safety-stock value. REQUIRED STOCK is the immediate demand gap (working-quarter plan demand minus
        current stock), deliberately excluding safety stock; the separate inventory/replenishment decision shows in a
        forecast quarter's details. Forecast months are generated by the ML pipeline.
      </p>

      <ForecastDrawer
        open={Boolean(drawerTarget)}
        onClose={() => setDrawerTarget(null)}
        mode={target?.mode}
        row={target?.row}
        quarter={target?.quarter}
        yearLabel={targetGroup?.viewYear?.label}
        cell={targetCell}
        decision={target?.mode === "forecast" ? target?.row?.inventoryDecision?.[target?.quarter] : null}
        source={target?.mode === "forecast" ? targetCell?.source : null}
      />

      <PlanDetailsDrawer
        open={Boolean(planTarget)}
        onClose={() => setPlanTarget(null)}
        row={planTarget}
        activeFY={timeline?.activeFY}
        workingQuarter={timeline?.workingQuarter}
        activeMonth={timeline?.activeMonth}
      />
    </div>
  );
}
