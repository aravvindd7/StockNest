/**
 * Current Quarter Sales & Sales to Go — Phase 1 Sales Tracking for Planning
 * Master.
 *
 * Two live, date-derived columns:
 *   {Current Quarter} Sales        = actual Sales Master sales from the start
 *                                    of the current REAL-WORLD calendar quarter
 *                                    through the current date (the current
 *                                    month's posted value at month granularity).
 *   {Current Quarter} Sales to Go  = remaining forecast demand for the same
 *                                    calendar quarter after the current date.
 *
 * Everything here is derived from the backend clock + existing Sales Master +
 * existing ForecastPredictions. There is NO stored "q2Sales" value and no
 * scheduled job — the values roll forward automatically because a pure
 * function of `now` recomputes them on every read.
 *
 * GRANULARITY — this util deliberately reuses the project's existing MONTHLY
 * ACTUAL/FORECAST architecture (see services/planningService.js's
 * buildActiveQuarter / buildPlanSeries):
 *   - a month with a posted Sales Master value → ACTUAL (even the current
 *     month — its posted value IS "sales through today" at month granule);
 *   - the current month with no posted value → FORECAST (full-month
 *     prediction, the same way buildActiveQuarter reads it);
 *   - a future month → FORECAST.
 * No fake daily forecasts are invented (a future daily engine can slot into
 * computeCurrentQuarterMetrics via its two lookup functions without reshaping
 * the util).
 *
 * CALENDAR-QUARTER NOTE: the quarter here is the normal Q1=Jan–Mar …
 * Q4=Oct–Dec, NOT the Indian-FY quarter selector used elsewhere in Planning
 * Master. A calendar quarter's 3 months always fall inside ONE financial year,
 * which is what fyStartForCalendarQuarter resolves.
 */
const { finYearLabel } = require("./financialYear");

// Calendar-order month names — index 0 = January (matches Date#getMonth()).
const CALENDAR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ALL_CALENDAR_QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

/**
 * The real-world calendar quarter a date falls in: Jan–Mar → Q1, Apr–Jun →
 * Q2, Jul–Sep → Q3, Oct–Dec → Q4. Purely calendar — unrelated to the
 * Indian-FY quarter of the same name.
 */
function calendarQuarterOfDate(now) {
  return ALL_CALENDAR_QUARTERS[Math.floor(now.getMonth() / 3)];
}

/**
 * The 3 calendar months of a calendar quarter, in calendar order.
 * e.g. "Q2" → ["April", "May", "June"].
 */
function calendarQuarterMonths(quarterLabel) {
  const q = ALL_CALENDAR_QUARTERS.indexOf(quarterLabel);
  if (q === -1) return [];
  return CALENDAR_MONTHS.slice(q * 3, q * 3 + 3);
}

/**
 * Start calendar year of the single Indian financial year that contains the
 * given calendar quarter for a date:
 *   - Q1 (Jan–Mar)  → now.getFullYear() − 1  (Jan 2026 → FY 2025-26)
 *   - Q2–Q4 (Apr–Dec) → now.getFullYear()      (May 2026 → FY 2026-27)
 * Equivalent to currentFinancialYearStart(now); kept local so the util is a
 * pure, dependency-free function tests can pin.
 */
function fyStartForCalendarQuarter(now) {
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
}

/**
 * Financial-year label (e.g. "2026-27") for the current calendar quarter.
 */
function fyLabelForCalendarQuarter(now) {
  return finYearLabel(fyStartForCalendarQuarter(now));
}

/**
 * Split the current calendar quarter's months into ACTUAL sales and
 * remaining FORECAST demand. Every month is classified exactly once
 * (completed periods → Sales; current month → Sales if posted else
 * Sales-to-Go; future months → Sales-to-Go), so no period is double-counted.
 *
 * @param {Date} now             authoritative backend date
 * @param {function(string): (number|null)} actualForMonth
 *        Sales Master value for the month-name, or null when no posted value.
 * @param {function(string): (number|null)} forecastForMonth
 *        ForecastPredictions demand for the month-name, or null when none.
 * @returns {{sales: number, salesToGo: number}} both >= 0. salesToGo is a
 *          number (possibly 0) — never NaN/Infinity.
 */
function computeCurrentQuarterMetrics({ now, actualForMonth, forecastForMonth }) {
  const quarter = calendarQuarterOfDate(now);
  const months = calendarQuarterMonths(quarter);
  const currentMonthIndex = now.getMonth();

  let sales = 0;
  let salesToGo = 0;

  for (const month of months) {
    const monthIndex = CALENDAR_MONTHS.indexOf(month);
    const actual = typeof actualForMonth === "function" ? actualForMonth(month) : null;
    const hasActual = actual != null && Number.isFinite(actual);

    if (monthIndex < currentMonthIndex || (monthIndex === currentMonthIndex && hasActual)) {
      // Completed months, and the current month once it has posted data —
      // only the ACTUAL value counts; that month's forecast is never included.
      sales += hasActual ? actual : 0;
    } else {
      // Current month with no posted data, and future months — remaining
      // forecast demand for the rest of the quarter.
      const forecast = typeof forecastForMonth === "function" ? forecastForMonth(month) : null;
      salesToGo += forecast != null && Number.isFinite(forecast) && forecast > 0 ? forecast : 0;
    }
  }

  return { sales, salesToGo };
}

module.exports = {
  CALENDAR_MONTHS,
  ALL_CALENDAR_QUARTERS,
  calendarQuarterOfDate,
  calendarQuarterMonths,
  fyStartForCalendarQuarter,
  fyLabelForCalendarQuarter,
  computeCurrentQuarterMetrics,
};