import { Fragment } from "react";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const num = (n) => Number(n ?? 0).toLocaleString("en-IN");

/**
 * Computes a trend arrow for every quarter in the flattened sequence —
 * historical years followed by the forecast year — except the very first
 * one overall (nothing precedes it). This makes the forecast's Q1 arrow
 * compare against the last historical year's Q4, so the trend reads as
 * one continuous timeline rather than resetting at the forecast boundary.
 */
function buildTrendMap(row, years, forecastYear) {
  const sequence = [];
  years.forEach((year) => {
    QUARTERS.forEach((q) => {
      sequence.push({ key: `${year}:${q}`, value: row.years[year]?.[q] ?? 0 });
    });
  });
  QUARTERS.forEach((q) => {
    sequence.push({ key: `${forecastYear}:${q}`, value: row.forecast?.quarters?.[q]?.qty ?? 0 });
  });

  const trend = {};
  sequence.forEach((entry, i) => {
    if (i === 0) {
      trend[entry.key] = null;
      return;
    }
    const prev = sequence[i - 1].value;
    if (entry.value > prev) trend[entry.key] = "up";
    else if (entry.value < prev) trend[entry.key] = "down";
    else trend[entry.key] = "flat";
  });
  return trend;
}

function TrendArrow({ direction }) {
  if (!direction) return null;
  const config = {
    up: { symbol: "↗", color: "text-healthy" },
    down: { symbol: "↘", color: "text-out" },
    flat: { symbol: "→", color: "text-gray-400" },
  }[direction];
  return <sup className={`ml-0.5 text-[10px] font-bold ${config.color}`}>{config.symbol}</sup>;
}

function OverallTrendBadge({ trend }) {
  const config = {
    up: { symbol: "↗", color: "text-healthy" },
    down: { symbol: "↘", color: "text-out" },
    flat: { symbol: "→", color: "text-gray-400" },
  }[trend] || { symbol: "—", color: "text-gray-400" };
  return <span className={`text-base font-bold ${config.color}`}>{config.symbol}</span>;
}

const STICKY_LEFT = [
  { key: "safetyStock", label: "Safety Stock", width: 110 },
  { key: "materialNo", label: "Material Number", width: 140 },
  { key: "materialName", label: "Material Name", width: 220 },
];

// Trailing sticky-right block, listed left-to-right as they should appear.
const STICKY_RIGHT = [
  { key: "currentStock", label: "Current Stock", width: 110 },
  { key: "trend", label: "Trend", width: 80 },
  { key: "recommendedStock", label: "Recommended Stock", width: 140 },
  { key: "confidence", label: "Forecast Confidence", width: 130 },
];

const HEADER_ROW_H = 38; // px, both header rows are the same height

export default function PlanningTable({ years, forecastYear, rows, loading, onForecastCellClick }) {
  let leftOffset = 0;
  const leftOffsets = STICKY_LEFT.map((col) => {
    const offset = leftOffset;
    leftOffset += col.width;
    return offset;
  });

  // Right offsets computed from the RIGHT edge inward, so the last entry
  // in STICKY_RIGHT sits at right:0 and earlier ones stack further left.
  let rightOffset = 0;
  const rightOffsets = [...STICKY_RIGHT].reverse().map((col) => {
    const offset = rightOffset;
    rightOffset += col.width;
    return offset;
  }).reverse();

  const totalCols = STICKY_LEFT.length + years.length * 5 + 5 + STICKY_RIGHT.length;

  return (
    <div className="sn-card overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="min-w-max overflow-x-auto">
          <table className="min-w-max border-separate border-spacing-0 text-left text-[12.5px]">
            <thead>
              {/* Row 1: sticky-left labels + one cell per year (5 cols each) + sticky-right summary labels */}
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
                {years.map((year) => (
                  <th
                    key={year}
                    colSpan={5}
                    style={{ position: "sticky", top: 0, zIndex: 20 }}
                    className="border-b border-l border-white/10 bg-navy-2 px-3 py-2 text-center font-display text-[13px] font-bold text-white"
                  >
                    {year}
                  </th>
                ))}
                <th
                  colSpan={5}
                  style={{ position: "sticky", top: 0, zIndex: 20 }}
                  className="border-b border-l border-accent/40 bg-accent px-3 py-2 text-center font-display text-[13px] font-bold text-white"
                >
                  {forecastYear} (Forecast)
                </th>
                {STICKY_RIGHT.map((col, i) => (
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
              {/* Row 2: Q1-Q4 + Total under each year, including the forecast year */}
              <tr style={{ height: HEADER_ROW_H }}>
                {years.map((year) => (
                  <Fragment key={year}>
                    {QUARTERS.map((q) => (
                      <th
                        key={`${year}-${q}`}
                        style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }}
                        className="border-b border-l border-white/10 bg-navy px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-[#C9D3EA]"
                      >
                        {q}
                      </th>
                    ))}
                    <th
                      style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }}
                      className="border-b border-l border-white/10 bg-gray-500 px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white"
                    >
                      Total
                    </th>
                  </Fragment>
                ))}
                {QUARTERS.map((q) => (
                  <th
                    key={`forecast-${q}`}
                    style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }}
                    className="border-b border-l border-accent/40 bg-accent/80 px-2.5 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-white"
                  >
                    {q}
                  </th>
                ))}
                <th
                  style={{ position: "sticky", top: HEADER_ROW_H, zIndex: 20 }}
                  className="border-b border-l border-accent/40 bg-accent px-3 py-1.5 text-center text-[10.5px] font-bold uppercase tracking-wide text-white"
                >
                  Total
                </th>
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
                  const trend = buildTrendMap(row, years, forecastYear);
                  const rowBg = i % 2 === 1 ? "bg-[#F8FAFD]" : "bg-white";
                  return (
                    <tr key={row.materialNo} className={`group border-b border-gray-100 transition hover:bg-[#EAF2FF] ${rowBg}`}>
                      <td
                        style={{ position: "sticky", left: leftOffsets[0], width: STICKY_LEFT[0].width, zIndex: 5 }}
                        className={`px-3 py-2.5 font-mono ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {num(row.safetyStock)}
                      </td>
                      <td
                        style={{ position: "sticky", left: leftOffsets[1], width: STICKY_LEFT[1].width, zIndex: 5 }}
                        className={`px-3 py-2.5 font-mono text-[#3B4666] ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {row.materialNo}
                      </td>
                      <td
                        style={{ position: "sticky", left: leftOffsets[2], width: STICKY_LEFT[2].width, zIndex: 5 }}
                        className={`whitespace-nowrap px-3 py-2.5 ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        {row.materialName}
                      </td>

                      {/* Historical years — white/plain, per the spec's colour scheme */}
                      {years.map((year) => {
                        const yearData = row.years[year] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0, total: 0 };
                        return (
                          <Fragment key={year}>
                            {QUARTERS.map((q) => (
                              <td key={q} className="border-l border-gray-100 px-2.5 py-2.5 text-right font-mono">
                                {num(yearData[q])}
                                <TrendArrow direction={trend[`${year}:${q}`]} />
                              </td>
                            ))}
                            <td className="border-l border-gray-100 bg-gray-100 px-3 py-2.5 text-right font-mono font-bold">
                              {num(yearData.total)}
                            </td>
                          </Fragment>
                        );
                      })}

                      {/* Forecast year — very light blue, clickable quarter cells open the drawer */}
                      {QUARTERS.map((q) => {
                        const cell = row.forecast?.quarters?.[q];
                        return (
                          <td
                            key={`forecast-${q}`}
                            onClick={() => onForecastCellClick?.(row, q)}
                            className="cursor-pointer border-l border-accent/10 bg-accent/5 px-2.5 py-2.5 text-right font-mono transition hover:bg-accent/15"
                            title="Click for forecast details"
                          >
                            {num(cell?.qty)}
                            <TrendArrow direction={trend[`${forecastYear}:${q}`]} />
                          </td>
                        );
                      })}
                      <td className="border-l border-accent/10 bg-accent/10 px-3 py-2.5 text-right font-mono font-bold text-primary">
                        {num(row.forecast?.total)}
                      </td>

                      {/* Sticky-right summary block */}
                      <td
                        style={{ position: "sticky", right: rightOffsets[0], width: STICKY_RIGHT[0].width, zIndex: 5 }}
                        className="border-l border-gray-100 bg-healthy/10 px-3 py-2.5 text-right font-mono"
                      >
                        {num(row.currentStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[1], width: STICKY_RIGHT[1].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <OverallTrendBadge trend={row.trend} />
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[2], width: STICKY_RIGHT[2].width, zIndex: 5 }}
                        className="border-l border-gray-100 bg-low/10 px-3 py-2.5 text-right font-mono"
                      >
                        {num(row.recommendedStock)}
                      </td>
                      <td
                        style={{ position: "sticky", right: rightOffsets[3], width: STICKY_RIGHT[3].width, zIndex: 5 }}
                        className={`border-l border-gray-100 px-3 py-2.5 text-center ${rowBg} group-hover:bg-[#EAF2FF]`}
                      >
                        <span className="sn-badge bg-accent/10 text-accent">{row.forecast?.avgConfidence}%</span>
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
