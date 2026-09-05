/**
 * PlanningTable — 3-slot FY comparison view. Three independent FY column
 * groups side-by-side (Q1-Q4 + Total per group), one material per row.
 *
 * Each FY column-group header carries its own dropdown/filter (spreadsheet
 * style) so the user can re-point that specific slot at any available
 * financial year — historical, current, or forecast. Selecting a year
 * re-requests that slot's real data; nothing is fabricated.
 *
 * Actual FY groups (historical/current) show Sales Master actuals — quarter
 * cells are clickable to open the historical drill-down drawer (real
 * monthly sales).
 * Forecast FY groups show ML predictions — quarter cells are tinted and
 * clickable to open the ForecastDetailsDrawer.
 *
 * A FY group with no data renders clean empty cells with a "No data" tag —
 * never fabricated numbers, never an implied 36-month forecast.
 *
 * Sticky left: Material Number, Material Name.
 * Sticky right: Current Stock, Safety Stock, Trend. Forecast Confidence is
 * rendered next to Total inside each forecast FY's blue column group.
 */
import { Fragment } from "react";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

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
 * Quarter-over-quarter trend within a single FY group. First quarter is
 * always null (nothing precedes it within the year).
 */
function buildGroupTrend(block, isForecastYear) {
  const trend = {};
  QUARTERS.forEach((q, i) => {
    if (i === 0) { trend[q] = null; return; }
    const prevQ = QUARTERS[i - 1];
    let prevVal, currVal;
    if (isForecastYear) {
      prevVal = block?.forecast?.quarters?.[prevQ]?.qty ?? 0;
      currVal = block?.forecast?.quarters?.[q]?.qty ?? 0;
    } else {
      prevVal = block?.quarters?.[prevQ]?.qty ?? 0;
      currVal = block?.quarters?.[q]?.qty ?? 0;
    }
    trend[q] = currVal > prevVal ? "up" : currVal < prevVal ? "down" : "flat";
  });
  return trend;
}

const STICKY_LEFT = [
  { key: "materialNo", label: "Material Number", width: 140 },
  { key: "materialName", label: "Material Name", width: 220 },
];

// Trailing sticky-right block, listed left-to-right as they should appear.
const STICKY_RIGHT = [
  { key: "currentStock", label: "Current Stock", width: 110 },
  { key: "safetyStock", label: "Safety Stock", width: 110 },
  { key: "trend", label: "Trend", width: 80 },
];

const HEADER_ROW_H = 38; // px, both header rows are the same height

export default function PlanningTable({ groups, rows, availableYears = [], onChangeYear, loading, onCellClick }) {
  const renderedRight = STICKY_RIGHT;

  let leftOffset = 0;
  const leftOffsets = STICKY_LEFT.map((col) => {
    const offset = leftOffset;
    leftOffset += col.width;
    return offset;
  });

  let rightOffset = 0;
  const rightOffsets = [...renderedRight].reverse().map((col) => {
    const offset = rightOffset;
    rightOffset += col.width;
    return offset;
  }).reverse();

  const totalCols = STICKY_LEFT.length
    + groups.reduce((count, g) => count + QUARTERS.length + 1 + (g.isForecastYear ? 1 : 0), 0)
    + renderedRight.length;

  const yearHeaderClass = (g) =>
    g.isForecastYear
      ? "border-b border-l border-accent/40 bg-accent px-3 py-2 text-center font-display text-[13px] font-bold text-white"
      : "border-b border-l border-white/10 bg-navy-2 px-3 py-2 text-center font-display text-[13px] font-bold text-white";

  const quarterHeaderClass = (g) =>
    g.isForecastYear
      ? "border-b border-l border-accent/40 bg-accent/80 px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-white"
      : "border-b border-l border-white/10 bg-navy px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-[#C9D3EA]";

  const totalHeaderClass = (g) =>
    g.isForecastYear
      ? "border-b border-l border-accent/40 bg-accent px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white"
      : "border-b border-l border-white/10 bg-gray-500 px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white";

  return (
    <div className="sn-card overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="min-w-max overflow-x-auto">
          <table className="min-w-max border-separate border-spacing-0 text-left text-[12.5px]">
            <thead>
              {/* Row 1: sticky-left labels + one FY header (with its own year
                  filter) per slot + sticky-right labels */}
              <tr style={{ height: HEADER_ROW_H }}>
                {STICKY_LEFT.map((col, i) => (
                  <th
                    key={col.key}
                    rowSpan={2}
                    style={{ position: "sticky", left: leftOffsets[i], top: 0, width: col.width, zIndex: 30 }}
                    className="bg-navy px-3 text-[11px] font-semibold uppercase tracking-wide text-[#C9D3EA] align-middle border-b border-white/10"
                  >
                    {col.label}
                  </th>
                ))}

                {groups.map((g) => (
                  <th
                    key={g.index}
                    colSpan={QUARTERS.length + 1 + (g.isForecastYear ? 1 : 0)}
                    style={{ position: "sticky", top: 0, zIndex: 20 }}
                    className={yearHeaderClass(g)}
                  >
                    <div className="flex items-center justify-center gap-1.5">
                      <FYHeaderSelect group={g} availableYears={availableYears} onChangeYear={onChangeYear} />
                      {g.viewYear.current && (
                        <span className="text-[9.5px] font-semibold uppercase tracking-wide opacity-80">Current</span>
                      )}
                      {g.isForecastYear && !g.viewYear.current && (
                        <span className="text-[9.5px] font-semibold uppercase tracking-wide opacity-80">Forecast</span>
                      )}
                      {!g.hasData && (
                        <span className="rounded bg-white/20 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide">No data</span>
                      )}
                    </div>
                  </th>
                ))}

                {renderedRight.map((col, i) => (
                  <th
                    key={col.key}
                    rowSpan={2}
                    style={{ position: "sticky", right: rightOffsets[i], top: 0, width: col.width, zIndex: 30 }}
                    className="border-b border-l border-white/10 bg-navy px-3 text-[10.5px] font-semibold uppercase tracking-wide text-[#C9D3EA] align-middle"
                  >
                    {col.label}
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
                    {g.isForecastYear && (
                      <th
                        style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }}
                        className="border-b border-l border-accent/40 bg-accent px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white"
                      >
                        Forecast Confidence
                      </th>
                    )}
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
                        style={{ position: "sticky", left: leftOffsets[0], width: STICKY_LEFT[0].width, zIndex: 5 }}
                        className={`px-3 py-2.5 font-mono text-[#3B4666] ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {row.materialNo}
                      </td>
                      <td
                        style={{ position: "sticky", left: leftOffsets[1], width: STICKY_LEFT[1].width, zIndex: 5 }}
                        className={`whitespace-nowrap px-3 py-2.5 ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {row.materialName}
                      </td>

                      {groups.map((g) => {
                        const block = row.years?.[g.viewYear.value];
                        if (g.isForecastYear) {
                          const hasData = block?.forecast?.source !== "NO_DATA";
                          const trend = buildGroupTrend(block, true);
                          return (
                            <Fragment key={g.index}>
                              {QUARTERS.map((q) => {
                                const cell = block?.forecast?.quarters?.[q];
                                if (!hasData) {
                                  return (
                                    <td key={q} className="border-l border-gray-100 bg-gray-50/60 px-2.5 py-2.5 text-right font-mono text-gray-300">
                                      —
                                    </td>
                                  );
                                }
                                return (
                                  <td
                                    key={q}
                                    onClick={() => onCellClick?.(row, g.viewYear.value, q)}
                                    className="cursor-pointer border-l border-accent/10 bg-accent/5 px-2.5 py-2.5 text-right font-mono transition hover:bg-accent/15"
                                    title="Click for forecast details"
                                  >
                                    {num(cell?.qty)}
                                    <TrendArrow direction={trend[q]} />
                                  </td>
                                );
                              })}
                              <td className={`border-l px-3 py-2.5 text-right font-mono font-bold ${hasData ? "border-accent/10 bg-accent/10 text-primary" : "border-gray-100 bg-gray-100 text-gray-400"}`}>
                                {num(block?.total ?? 0)}
                              </td>
                              <td className="border-l border-accent/10 bg-accent/10 px-3 py-2.5 text-center">
                                <span className={`sn-badge ${hasData && block?.forecast?.avgConfidence != null ? "bg-white/80 text-accent" : "bg-white/40 text-white/70"}`}>
                                  {hasData && block?.forecast?.avgConfidence != null ? `${block.forecast.avgConfidence}%` : "—"}
                                </span>
                              </td>
                            </Fragment>
                          );
                        }
                        // Actual (historical/current) FY slot: clickable for the drill-down drawer.
                        const trend = buildGroupTrend(block, false);
                        return (
                          <Fragment key={g.index}>
                            {QUARTERS.map((q) => {
                              const qty = block?.quarters?.[q]?.qty ?? 0;
                              return (
                                <td
                                  key={q}
                                  onClick={() => onCellClick?.(row, g.viewYear.value, q)}
                                  className="cursor-pointer border-l border-gray-100 px-2.5 py-2.5 text-right font-mono transition hover:bg-[#EAF2FF]"
                                  title="Click for actual monthly sales"
                                >
                                  {num(qty)}
                                  <TrendArrow direction={trend[q]} />
                                </td>
                              );
                            })}
                            <td className="border-l border-gray-100 bg-gray-100 px-3 py-2.5 text-right font-mono font-bold">
                              {num(block?.total ?? 0)}
                            </td>
                          </Fragment>
                        );
                      })}

                      {/* Sticky-right summary block */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[0], width: renderedRight[0].width, zIndex: 5 }}
                        className="border-l border-gray-100 bg-healthy/10 px-3 py-2.5 text-right font-mono"
                      >
                        {num(row.currentStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[1], width: renderedRight[1].width, zIndex: 5 }}
                        className="border-l border-gray-100 bg-healthy/5 px-3 py-2.5 text-right font-mono"
                      >
                        {num(row.safetyStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[2], width: renderedRight[2].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <span className={`text-base font-bold ${row.trend === "up" ? "text-healthy" : row.trend === "down" ? "text-out" : "text-gray-400"}`}>
                          {row.trend === "up" ? "↗" : row.trend === "down" ? "↘" : "→"}
                        </span>
                      </td>
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

/**
 * The spreadsheet-style per-group FY filter — a compact dropdown that is
 * part of the FY column-group header itself. Lists every available
 * financial year; choosing one re-points this specific slot at that FY.
 */
function FYHeaderSelect({ group, availableYears, onChangeYear }) {
  const current = group.viewYear.value;
  // Ensure the slot's current selection is always an available option even
  // if it isn't in the canonical year list (defensive).
  const options = availableYears.some((y) => y.value === current)
    ? availableYears
    : [{ value: current, label: group.viewYear.label }, ...availableYears];

  return (
    <select
      className="max-w-[120px] cursor-pointer bg-transparent text-center font-display text-[13px] font-bold text-inherit outline-none"
      value={current}
      onChange={(e) => onChangeYear?.(group.index, Number(e.target.value))}
      aria-label={`Financial year for column group ${group.index + 1}`}
      title="Change this column's financial year"
    >
      {options.map((y) => (
        <option key={y.value} value={y.value} className="text-[#1B2338]">
          {y.label}
        </option>
      ))}
    </select>
  );
}
