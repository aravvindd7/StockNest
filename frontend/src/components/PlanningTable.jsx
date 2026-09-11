/**
 * PlanningTable — fixed Active-FY operational timeline. Exactly three FY
 * column groups: Previous FY | Previous FY | Active FY, derived from the
 * server clock and shown in this order. Each group: Q1-Q4 + Total.
 *
 * The Active FY is a MIXED year — months that have started show real Sales
 * Master actuals; future months show the rolling XGBoost forecast where
 * stored. A future month with no stored prediction renders as a
 * non-clickable "—" (no data, never fabricated).
 *
 * The right-side operational block shares the Active FY's columns:
 *   PLAN               — the current working quarter's demand; clickable → Plan Details
 *   CURRENT STOCK      — current inventory on hand
 *   REQUIRED STOCK     — max(0, plan demand − current stock); excludes safety stock
 *   REPLENISHMENT PLAN — planner-controlled allocation summary (clickable →
 *                       Replenishment Details drawer)
 *   WEEK COVERAGE      — current stock ÷ average weekly forecast demand (read-only
 *                        inventory-health indicator; consumes the forecast months of
 *                        the active rolling forecast only). Placed AFTER Replenishment
 *                        Plan, never beside Current Stock.
 *
 * Sticky left:  Material Number, Material Name, then the two current
 *                real-world calendar-quarter columns — "{Q} Sales" (actuals
 *                so far) and "{Q} Sales to Go" (remaining forecast) — with
 *                dynamic labels from the backend, never tied to the selected
 *                FY/quarter.
 * Sticky right: PLAN, CURRENT STOCK, REQUIRED STOCK, MONTHLY REPLENISHMENT,
 *               REPLENISHMENT PLAN, WEEK COVERAGE, SAFETY STOCK, TREND,
 *               FORECAST CONFIDENCE
 *               (confidence only rendered when the Active FY actually holds
 *               forecast-backed data).
 */
import { Fragment } from "react";
import { MONTHS_BY_QUARTER, QUARTERS } from "../constants/salesColumns";

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

function TrendArrow({ direction }) {
  if (!direction) return null;
  const config = {
    up: { symbol: "↗", color: "text-healthy" },
    down: { symbol: "↘", color: "text-out" },
    flat: { symbol: "→", color: "text-gray-400" },
  }[direction];
  return <sup className={`ml-0.5 text-[10px] font-bold ${config.color}`}>{config.symbol}</sup>;
}

/**
 * Replenishment Plan cell — compact summary of the ACTIVE allocation.
 * Distinguishes the two modes by tag (never color-only):
 *   MANUAL → "20% / 40% / 40%" + accent MANUAL tag (planner override)
 *   AUTO   → "0% / 0% / 100%" + muted AUTO tag (system-generated forecast-
 *            driven allocation)
 * Safe N/A states come from the backend's `state` field (never fabricated):
 *   insufficient_forecast / invalid_stock → "N/A · Insufficient Forecast"
 *   no_forecast_demand                     → "No forecast demand"
 * Disabled when requiredStock is 0.
 */
function ReplenishmentPlanCell({ plan }) {
  if (!plan || plan.requiredStock === 0) {
    return <span className="text-[10.5px] text-gray-300">—</span>;
  }
  if (plan.state === "insufficient_forecast" || plan.state === "invalid_stock") {
    return <span className="whitespace-nowrap text-[10px] text-gray-400">N/A · Insufficient Forecast</span>;
  }
  if (plan.state === "no_forecast_demand") {
    return <span className="whitespace-nowrap text-[10px] text-gray-400">No forecast demand</span>;
  }
  if (!plan.distribution || plan.distribution.length === 0) {
    return <span className="text-[10.5px] text-gray-300">—</span>;
  }
  // Round each percentage to a whole number; if that no longer sums to 100
  // (e.g. 33.33/33.33/33.34 rounds to 33/33/33 = 99), adjust the LAST entry
  // by the remainder so the displayed summary always reads exactly 100% —
  // "33% / 33% / 34%", never a confusing "… / 33%".
  const pct = plan.distribution.map((d) => Math.round(d.percentage));
  const sum = pct.reduce((s, v) => s + v, 0);
  if (sum !== 100 && pct.length) pct[pct.length - 1] += 100 - sum;
  const summary = pct.map((p) => `${p}%`).join(" / ");
  const isManual = plan.mode === "MANUAL";
  return (
    <span className="whitespace-nowrap">
      <span className={`font-mono text-[11px] ${isManual ? "text-gray-700" : "text-gray-500"}`}>{summary}</span>
      <span
        className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
          isManual ? "bg-accent/10 text-accent" : "bg-gray-100 text-gray-400"
        }`}
      >
        {isManual ? "MANUAL" : "AUTO"}
      </span>
    </span>
  );
}

const MONTH_ABBREV = { April: "Apr", May: "May", June: "Jun", July: "Jul", August: "Aug", September: "Sep", October: "Oct", November: "Nov", December: "Dec", January: "Jan", February: "Feb", March: "Mar" };

function MonthlyReplenishmentCell({ plan, workingQuarter }) {
  if (!plan || plan.requiredStock === 0 || plan.state === "insufficient_forecast" || plan.state === "invalid_stock") {
    return <span className="flex h-full w-full items-center justify-center text-[10.5px] text-gray-300">—</span>;
  }
  const months = MONTHS_BY_QUARTER[workingQuarter];
  if (!months || !plan.distribution || plan.distribution.length === 0) {
    return <span className="flex h-full w-full items-center justify-center text-[10.5px] text-gray-300">—</span>;
  }
  return (
    <div className="grid grid-cols-3 gap-x-1 text-center">
      {months.map((m) => (
        <span key={m} className="text-[8.5px] font-medium uppercase tracking-wide text-gray-400">{MONTH_ABBREV[m] || m}</span>
      ))}
      {months.map((m, idx) => {
        const d = plan.distribution[idx];
        const val = d && Number.isFinite(d.quantity) && d.quantity != null ? num(d.quantity) : "—";
        return (
          <span key={m} className="flex items-center justify-center font-mono text-[10px] text-gray-600">{val}</span>
        );
      })}
    </div>
  );
}

/**
 * Quarter-over-quarter trend within a single FY group. First quarter is
 * always null (nothing precedes it within the year). Works for both pure
 * actual blocks and the Active FY's hybrid blocks — both expose `quarters`.
 */
function buildGroupTrend(block) {
  const trend = {};
  QUARTERS.forEach((q, i) => {
    if (i === 0) { trend[q] = null; return; }
    const prevQ = QUARTERS[i - 1];
    const prevVal = block?.quarters?.[prevQ]?.qty ?? 0;
    const currVal = block?.quarters?.[q]?.qty ?? 0;
    trend[q] = currVal > prevVal ? "up" : currVal < prevVal ? "down" : "flat";
  });
  return trend;
}

// Sticky-left base columns are defined as STICKY_LEFT_BASE further down
// (Material Number, Material Name), then extended in-component with the two
// dynamic current-calendar-quarter Sales columns.

// Trailing sticky-right block, listed left-to-right as they should appear.
// The live current-quarter sales metrics sit immediately next to the Plan
// block so the planner can compare sales, sales-to-go, and the working-plan
// decision without scanning away from the operational summary.
const STICKY_RIGHT = [
  { key: "currentStock", label: "Current Stock", width: 110 },
  { key: "requiredStock", label: "Required Stock", width: 120 },
  { key: "plan", label: "Plan", width: 100 },
  { key: "monthlyReplenishment", label: "Monthly Replenishment", width: 180 },
  { key: "replenishmentPlan", label: "Replenishment Plan", width: 150 },
  { key: "weekCoverage", label: "Week Coverage", width: 150 },
  { key: "safetyStock", label: "Safety Stock", width: 100 },
  { key: "trend", label: "Trend", width: 80 },
  { key: "confidence", label: "Forecast Confidence", width: 130 },
];

const WEEK_STATUS_STYLE = {
  CRITICAL: "bg-out/10 text-out",
  HEALTHY: "bg-healthy/10 text-healthy",
  HIGH: "bg-primary/10 text-primary",
};

const WEEK_STATUS_LABEL = { CRITICAL: "Critical", HEALTHY: "Healthy", HIGH: "High Stock" };

// One-decimal weeks, but exactly 0 renders "0" (spec: "0 weeks · Critical").
const formatWeeks = (w) => (w === 0 ? "0" : w.toFixed(1));

/**
 * Week Coverage cell — always shows text (never color alone), and the four
 * safe N/A states come from the backend's `state` field (never NaN/undefined/
 * Infinity). Computed states render an sn-badge tagged by status.
 */
function WeekCoverageCell({ wc }) {
  if (!wc) return <span className="text-[10.5px] text-gray-400">N/A</span>;
  if (wc.state === "invalid_stock") {
    return <span className="text-[10.5px] text-gray-400">N/A</span>;
  }
  if (wc.state === "insufficient_forecast") {
    return <span className="whitespace-nowrap text-[10px] text-gray-400">N/A · Insufficient Forecast</span>;
  }
  if (wc.state === "no_forecast_demand") {
    return <span className="whitespace-nowrap text-[10px] text-gray-400">No forecast demand</span>;
  }
  return (
    <span className={`whitespace-nowrap sn-badge ${WEEK_STATUS_STYLE[wc.status] || "bg-gray-100 text-gray-500"}`}>
      {formatWeeks(wc.weeks)} weeks · {WEEK_STATUS_LABEL[wc.status] || wc.status}
    </span>
  );
}

const HEADER_ROW_H = 38; // px, both header rows are the same height

// The base sticky-left block (Material Number, Material Name). The
// current-calendar-quarter Sales columns ride along directly after it, with
// DYNAMIC labels from the backend ("Q3 Sales", "Q3 Sales to Go") — they always
// represent the real-world current quarter, never the selected FY/quarter.
const STICKY_LEFT_BASE = [
  { key: "materialNo", label: "Material Number", width: 140 },
  { key: "materialName", label: "Material Name", width: 220 },
];

export default function PlanningTable({
  groups, rows, loading, onCellClick, onPlanClick, onReplenishmentClick, workingQuarter, activeFY, hasForecastData, currentQuarter,
}) {
  // Forecast Confidence (sticky-right) is only rendered when the Active FY
  // holds forecast-backed months — it never shows for a purely historical view.
  const renderedRight = hasForecastData
    ? STICKY_RIGHT
    : STICKY_RIGHT.filter((c) => c.key !== "confidence");

  // Two current-quarter columns, present whenever the backend supplies the
  // quarter id. They are intentionally placed immediately before the Plan
  // block, and the displayed label follows the actual working quarter (Q2),
  // not a stale calendar quarter from the backend.
  const salesQuarterLabel = workingQuarter || currentQuarter;
  const cqCols = salesQuarterLabel
    ? [
        { key: "currentQuarterSales", label: `${salesQuarterLabel} Sales`, width: 96 },
        { key: "currentQuarterSalesToGo", label: `${salesQuarterLabel} Sales to Go`, width: 132 },
      ]
    : [];
  const stickyLeft = [...STICKY_LEFT_BASE];
  const rightWithCurrentQuarter = salesQuarterLabel
    ? [
        { key: "plan", label: "Plan", width: 100 },
        renderedRight[0],
        renderedRight[1],
        ...cqCols,
        ...renderedRight.slice(2),
      ]
    : [
        { key: "plan", label: "Plan", width: 100 },
        ...renderedRight,
      ];

  let leftOffset = 0;
  const leftOffsets = stickyLeft.map((col) => {
    const offset = leftOffset;
    leftOffset += col.width;
    return offset;
  });

  let rightOffset = 0;
  const rightOffsets = [...rightWithCurrentQuarter].reverse().map((col) => {
    const offset = rightOffset;
    rightOffset += col.width;
    return offset;
  }).reverse();

  const totalCols = stickyLeft.length + groups.length * (QUARTERS.length + 1) + rightWithCurrentQuarter.length;

  const groupHeaderClass = (g) =>
    g.viewYear.active
      ? "border-b border-l border-accent/40 bg-accent px-3 py-2 text-center font-display text-[13px] font-bold text-white"
      : "border-b border-l border-white/10 bg-navy-2 px-3 py-2 text-center font-display text-[13px] font-bold text-white";

  const quarterHeaderClass = (g) =>
    g.viewYear.active
      ? "border-b border-l border-accent/40 bg-accent/80 px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-white"
      : "border-b border-l border-white/10 bg-navy px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-[#C9D3EA]";

  const totalHeaderClass = (g) =>
    g.viewYear.active
      ? "border-b border-l border-accent/40 bg-accent px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white"
      : "border-b border-l border-white/10 bg-gray-500 px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white";

  const trendText = (t) => (t === "up" ? "↗" : t === "down" ? "↘" : "→");
  const trendClass = (t) => (t === "up" ? "text-healthy" : t === "down" ? "text-out" : "text-gray-400");

  return (
    <div className="sn-card overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="min-w-max overflow-x-auto">
          <table className="min-w-max border-separate border-spacing-0 text-left text-[12.5px]">
            <thead>
              {/* Row 1: sticky-left labels + one FY header per slot + sticky-right labels */}
              <tr style={{ height: HEADER_ROW_H }}>
                {stickyLeft.map((col, i) => (
                  <th
                    key={col.key}
                    rowSpan={2}
                    style={{ position: "sticky", left: leftOffsets[i], top: 0, width: col.width, zIndex: 30 }}
                    className="border-b border-white/10 bg-navy px-3 align-middle text-[11px] font-semibold uppercase tracking-wide text-[#C9D3EA]"
                  >
                    {col.label}
                  </th>
                ))}

                {groups.map((g) => (
                  <th key={g.index} colSpan={5} style={{ position: "sticky", top: 0, zIndex: 20 }} className={groupHeaderClass(g)}>
                    <div className="flex items-center justify-center gap-1.5">
                      <span>{g.viewYear.label}</span>
                      {g.viewYear.active && (
                        <span className="rounded bg-white/20 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide">
                          Active
                        </span>
                      )}
                      {!g.hasData && (
                        <span className="rounded bg-white/20 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide">No data</span>
                      )}
                    </div>
                  </th>
                ))}

                {rightWithCurrentQuarter.map((col, i) => (
                  <th
                    key={col.key}
                    rowSpan={2}
                    style={{ position: "sticky", right: rightOffsets[i], top: 0, width: col.width, zIndex: 30 }}
                    className="border-b border-l border-white/10 bg-navy px-3 align-middle text-[10.5px] font-semibold uppercase tracking-wide text-[#C9D3EA]"
                  >
                    {col.key === "plan" ? (
                      <div className="flex flex-col items-center leading-tight">
                        <span>Plan</span>
                        <span className="text-[9px] font-medium normal-case tracking-normal opacity-70">
                          {workingQuarter} · {activeFY?.label}
                        </span>
                      </div>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
              {/* Row 2: Q1-Q4 + Total per slot */}
              <tr style={{ height: HEADER_ROW_H }}>
                {groups.map((g) => (
                  <Fragment key={g.index}>
                    {QUARTERS.map((q) => (
                      <th key={q} style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }} className={quarterHeaderClass(g)}>
                        {q}
                      </th>
                    ))}
                    <th style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }} className={totalHeaderClass(g)}>
                      Total
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={totalCols} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={totalCols} className="px-4 py-10 text-center text-gray-400">
                    No materials match your search.
                  </td>
                </tr>
              )}

              {!loading &&
                rows.map((row, i) => {
                  const rowBg = i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white";
                  return (
                    <tr key={row.materialNo} className={`group border-b border-gray-100 transition hover:bg-[#EAF2FF] ${rowBg}`}>
                      <td
                        style={{ position: "sticky", left: leftOffsets[0], width: stickyLeft[0].width, zIndex: 5 }}
                        className={`px-3 py-2.5 font-mono text-[#3B4666] ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {row.materialNo}
                      </td>
                      <td
                        style={{ position: "sticky", left: leftOffsets[1], width: stickyLeft[1].width, zIndex: 5 }}
                        className={`whitespace-nowrap px-3 py-2.5 ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <span className="truncate">{row.materialName}</span>
                      </td>

                      {groups.map((g) => {
                        const block = row.years?.[g.viewYear.value];
                        const trend = buildGroupTrend(block);
                        return (
                          <Fragment key={g.index}>
                            {QUARTERS.map((q) => {
                              const cell = block?.quarters?.[q];
                              if (!cell || cell.mode === "none") {
                                return (
                                  <td key={q} className="border-l border-gray-100 bg-gray-50/60 px-2.5 py-2.5 text-right font-mono text-gray-300">
                                    —
                                  </td>
                                );
                              }
                              if (cell.mode === "forecast") {
                                return (
                                  <td
                                    key={q}
                                    onClick={() => onCellClick?.(row, g.viewYear.value, q)}
                                    className="cursor-pointer border-l border-accent/10 bg-accent/5 px-2.5 py-2.5 text-right font-mono transition hover:bg-accent/15"
                                    title="Click for forecast details"
                                  >
                                    {num(cell.qty)}
                                    <TrendArrow direction={trend[q]} />
                                  </td>
                                );
                              }
                              return (
                                <td
                                  key={q}
                                  onClick={() => onCellClick?.(row, g.viewYear.value, q)}
                                  className="cursor-pointer border-l border-gray-100 px-2.5 py-2.5 text-right font-mono transition hover:bg-[#EAF2FF]"
                                  title="Click for actual monthly sales"
                                >
                                  {num(cell.qty)}
                                  <TrendArrow direction={trend[q]} />
                                </td>
                              );
                            })}
                            <td className={`border-l px-3 py-2.5 text-right font-mono font-bold ${g.viewYear.active ? "border-accent/10 bg-accent/10 text-primary" : "border-gray-100 bg-gray-100"}`}>
                              {num(block?.total ?? 0)}
                            </td>
                          </Fragment>
                        );
                      })}

                      {/* Sticky-right operational block */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[0], width: rightWithCurrentQuarter[0].width, zIndex: 10 }}
                        onClick={() => onPlanClick?.(row)}
                        className={`cursor-pointer border-l border-accent/15 bg-accent/10 px-3 py-2.5 text-right font-mono transition hover:bg-accent/20 ${rowBg}`}
                        title="Open Plan Details"
                      >
                        {num(row.planDemand)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[1], width: rightWithCurrentQuarter[1].width, zIndex: 5 }}
                        className={`border-l border-gray-100 bg-healthy/10 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.currentStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[2], width: rightWithCurrentQuarter[2].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono font-semibold ${row.requiredStock > 0 ? "text-out" : "text-[#3B4666]"} ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.requiredStock)}
                      </td>
                      {salesQuarterLabel && (
                        <>
                          <td
                            style={{ position: "sticky", right: rightOffsets[3], width: rightWithCurrentQuarter[3].width, zIndex: 4 }}
                            className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                          >
                            {row.currentQuarterSales == null ? "—" : num(row.currentQuarterSales)}
                          </td>
                          <td
                            style={{ position: "sticky", right: rightOffsets[4], width: rightWithCurrentQuarter[4].width, zIndex: 4 }}
                            className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                          >
                            {row.currentQuarterSalesToGo == null ? "—" : num(row.currentQuarterSalesToGo)}
                          </td>
                        </>
                      )}
                      {/* MONTHLY REPLENISHMENT — working quarter M1/M2/M3 allocation summary.
                          Reuses distribution from the single-source replenishmentPlan. */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 5 : 3], width: rightWithCurrentQuarter[salesQuarterLabel ? 5 : 3].width, zIndex: 5 }}
                        className={`flex items-center justify-center border-l border-gray-100 px-1.5 py-2 ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <MonthlyReplenishmentCell plan={row.replenishmentPlan} workingQuarter={workingQuarter} />
                      </td>
                      {/* REPLENISHMENT PLAN — planner-controlled allocation of WHEN
                          Required Stock is replenished (working quarter months). */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 6 : 4], width: rightWithCurrentQuarter[salesQuarterLabel ? 6 : 4].width, zIndex: 5 }}
                        onClick={() => onReplenishmentClick?.(row)}
                        className={`cursor-pointer border-l border-accent/15 px-2.5 py-2.5 text-center transition hover:bg-accent/15 ${rowBg}`}
                        title="Open Replenishment Details to allocate replenishment"
                      >
                        <ReplenishmentPlanCell plan={row.replenishmentPlan} />
                      </td>
                      {/* WEEK COVERAGE — directly AFTER Replenishment Plan; sticky, z-index 5 (same layer as its right-side neighbors). */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 7 : 5], width: rightWithCurrentQuarter[salesQuarterLabel ? 7 : 5].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-2.5 py-2.5 text-right ${rowBg} group-hover:bg-[#EAF2FF]`}
                        title="Weeks of cover from current stock against the active rolling forecast's weekly forecast demand"
                      >
                        <WeekCoverageCell wc={row.weekCoverage} />
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 8 : 6], width: rightWithCurrentQuarter[salesQuarterLabel ? 8 : 6].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.safetyStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 9 : 7], width: rightWithCurrentQuarter[salesQuarterLabel ? 9 : 7].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <span className={`text-base font-bold ${trendClass(row.trend)}`}>{trendText(row.trend)}</span>
                      </td>
                      {hasForecastData && (
                        <td
                          style={{ position: "sticky", right: rightOffsets[salesQuarterLabel ? 10 : 8], width: rightWithCurrentQuarter[salesQuarterLabel ? 10 : 8].width, zIndex: 5 }}
                          className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                        >
                          <span className={`sn-badge ${row.confidence != null ? "bg-accent/10 text-accent" : "bg-gray-100 text-gray-300"}`}>
                            {row.confidence != null ? `${row.confidence}%` : "—"}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
