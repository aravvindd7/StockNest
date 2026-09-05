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
 * Two operational columns sit right after the Active FY group:
 *   PLAN            — the current working quarter's demand; clickable → Plan Details
 *   REQUIRED STOCK  — max(0, plan demand − current stock); excludes safety stock
 *
 * Sticky left:  Material Number, Material Name.
 * Sticky right: PLAN, REQUIRED STOCK, CURRENT STOCK, SAFETY STOCK,
 *               TREND, FORECAST CONFIDENCE (confidence only rendered when
 *               the Active FY actually holds forecast-backed data).
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

const STICKY_LEFT = [
  { key: "materialNo", label: "Material Number", width: 140 },
  { key: "materialName", label: "Material Name", width: 220 },
];

// Trailing sticky-right block, listed left-to-right as they should appear.
const STICKY_RIGHT = [
  { key: "plan", label: "Plan", width: 100 },
  { key: "requiredStock", label: "Required Stock", width: 120 },
  { key: "currentStock", label: "Current Stock", width: 110 },
  { key: "safetyStock", label: "Safety Stock", width: 100 },
  { key: "trend", label: "Trend", width: 80 },
  { key: "confidence", label: "Forecast Confidence", width: 130 },
];

const HEADER_ROW_H = 38; // px, both header rows are the same height

export default function PlanningTable({ groups, rows, loading, onCellClick, onPlanClick, workingQuarter, activeFY, hasForecastData }) {
  // Forecast Confidence (sticky-right) is only rendered when the Active FY
  // holds forecast-backed months — it never shows for a purely historical view.
  const renderedRight = hasForecastData
    ? STICKY_RIGHT
    : STICKY_RIGHT.filter((c) => c.key !== "confidence");

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

  const totalCols = STICKY_LEFT.length + groups.length * (QUARTERS.length + 1) + renderedRight.length;

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
                {STICKY_LEFT.map((col, i) => (
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

                {renderedRight.map((col, i) => (
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
                        style={{ position: "sticky", right: rightOffsets[0], width: renderedRight[0].width, zIndex: 5 }}
                        onClick={() => onPlanClick?.(row)}
                        className={`cursor-pointer border-l border-accent/15 bg-accent/10 px-3 py-2.5 text-right font-mono transition hover:bg-accent/20 ${rowBg}`}
                        title="Open Plan Details"
                      >
                        {num(row.planDemand)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[1], width: renderedRight[1].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono font-semibold ${row.requiredStock > 0 ? "text-out" : "text-[#3B4666]"} ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.requiredStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[2], width: renderedRight[2].width, zIndex: 5 }}
                        className={`border-l border-gray-100 bg-healthy/10 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.currentStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[3], width: renderedRight[3].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-right font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.safetyStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[4], width: renderedRight[4].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <span className={`text-base font-bold ${trendClass(row.trend)}`}>{trendText(row.trend)}</span>
                      </td>
                      {hasForecastData && (
                        <td
                          style={{ position: "sticky", right: rightOffsets[5], width: renderedRight[5].width, zIndex: 5 }}
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