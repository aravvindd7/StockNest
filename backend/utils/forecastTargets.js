/**
 * Rolling multi-year forecast target derivation.
 *
 * All logic for "which financial years exist" and "which are historical,
 * current, or forecast" lives here — the ML service stays a dumb
 * downstream (receives an anchor, emits N months), and the frontend is a
 * pure view layer. This util is the single source of truth for the rolling
 * window, derived entirely from the server's system clock.
 *
 * Indian Financial Year: April 1 – March 31.
 *   months >= 4 (April–December) → calendar year IS the FY start year.
 *   months < 4  (January–March)  → previous calendar year IS the FY start year.
 */
const { finYearLabel, finYearStartCalendarYear, ALL_MONTHS, QUARTER_BY_MONTH, MONTHS_BY_QUARTER, ALL_QUARTERS } = require("./financialYear");

/**
 * Returns the start calendar year of the current Indian Financial Year.
 * e.g. 2026-09-02 → 2026 (FY 2026-27), 2027-02-15 → 2026 (FY 2026-27),
 * 2027-04-01 → 2027 (FY 2027-28).
 */
function currentFinancialYearStart(date = new Date()) {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();
  return month >= 4 ? year : year - 1;
}

/**
 * The one immediate next FY available in Planning Master — represented as a
 * start calendar year. Forecast generation currently covers this window only.
 * e.g. currentFyStart=2026 → [2027].
 */
function nextForecastStartYears(currentFyStart) {
  return [currentFyStart + 1];
}

/**
 * The start year of the first forecastable FY (the one immediately
 * following the current FY).
 */
function forecastStartYear(currentFyStart) {
  return currentFyStart + 1;
}

/**
 * Builds the dropdown year options array, merging:
 *   1. Historical years from Sales Master (may be empty or partial).
 *   2. The current FY (always present, marked `current: true`).
 *   3. The immediate next forecast FY (always present, marked `forecast: true`).
 *
 * Each entry: { value: number (start calendar year), label: "YYYY-YY",
 *              current?: boolean, forecast?: boolean }
 * `value` is the start calendar year — unchanged from the existing dropdown
 * contract (planningController passes it as `startYear` / `viewYear`).
 */
function buildYearOptions({ currentFyStart, financialYearsFromSales = [] }) {
  const historical = financialYearsFromSales
    .filter((y) => Number.isFinite(y) && y > 0 && y < currentFyStart)
    .reduce((acc, y) => { if (!acc.includes(y)) acc.push(y); return acc; }, [])
    .sort((a, b) => a - b);

  const forecastYears = nextForecastStartYears(currentFyStart);

  const options = [
    ...historical.map((y) => ({ value: y, label: finYearLabel(y) })),
    {
      value: currentFyStart,
      label: finYearLabel(currentFyStart),
      current: true,
    },
    ...forecastYears.map((y) => ({
      value: y,
      label: finYearLabel(y),
      forecast: true,
    })),
  ];

  return options;
}

// ─── Rolling-horizon helpers: "current quarter + next 2 quarters" ─────────────

// Calendar-ordered month names (index = JS Date month 0–11)
const CALENDAR_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Calendar month name → index within Indian FY (Apr=0 … Mar=11)
const ALL_MONTHS_TO_IDX = {};
ALL_MONTHS.forEach((m, i) => { ALL_MONTHS_TO_IDX[m] = i; });

// Quarter index within the Indian FY (Q1=0 … Q4=3)
const QUARTER_IDX = { Q1: 0, Q2: 1, Q3: 2, Q4: 3 };

// Index of the last month of each quarter (within the FY: Jun=2, Sep=5, Dec=8, Mar=11)
const LAST_MONTH_OF_QUARTER = { Q1: 2, Q2: 5, Q3: 8, Q4: 11 };

/**
 * The month name and FY label at the end of "current quarter + 2 quarters".
 * May cross an FY boundary: Q4 working quarter → end is Q2 of next FY.
 *
 * @param {string} activeFyLabel e.g. "2026-27"
 * @param {string} workingQuarter e.g. "Q2"
 * @returns {{ fyLabel: string, month: string }}
 */
function planForecastEndMonth(activeFyLabel, workingQuarter) {
  const qi = QUARTER_IDX[workingQuarter];
  const forecastEndQi = qi + 2; // +2 quarters forward
  const endQuarterName = ALL_QUARTERS[forecastEndQi % 4];
  // LAST_MONTH_OF_QUARTER gives the *last* month index (0-based within FY) of the quarter
  const endMonthName = ALL_MONTHS[LAST_MONTH_OF_QUARTER[endQuarterName]];
  // Cross-FY when forecastEndQi >= 4
  const offsetYears = Math.floor(forecastEndQi / 4);
  const endFyStartYear = finYearStartCalendarYear(activeFyLabel) + offsetYears;
  return { fyLabel: finYearLabel(endFyStartYear), month: endMonthName };
}

/**
 * Full forecast-horizon range covering the first month after the latest
 * actual Sales month through the end of "current quarter + next 2 quarters."
 *
 * @param {Date}   now               server clock
 * @param {string} latestActualFy    FY label containing the latest actual month
 * @param {string} latestActualMonth month name (e.g. "August")
 * @returns {{ startFy, startMonth, endFy, endMonth, horizonMonths }}
 */
function planForecastHorizonRange(now, latestActualFy, latestActualMonth) {
  const activeFyStart = currentFinancialYearStart(now);
  // Calendar-ordered month for the working quarter (Jan=0 … Dec=11 matches JS getMonth())
  const activeMonth = CALENDAR_MONTHS[now.getMonth()];
  const workingQuarter = QUARTER_BY_MONTH[activeMonth];

  const { fyLabel: endFy, month: endMonth } = planForecastEndMonth(finYearLabel(activeFyStart), workingQuarter);

  // Start = first month after the latest actual (may be in a different FY)
  const startIdx = finYearStartCalendarYear(latestActualFy) * 12 + ALL_MONTHS_TO_IDX[latestActualMonth] + 1;
  const endIdx = finYearStartCalendarYear(endFy) * 12 + ALL_MONTHS_TO_IDX[endMonth];
  const horizonMonths = Math.max(1, endIdx - startIdx + 1);

  // Determine start month's FY label and month name
  const startMonthIdx = (ALL_MONTHS_TO_IDX[latestActualMonth] + 1) % 12;
  const startFyOffset = startMonthIdx === 0 ? 1 : 0;
  const startFy = finYearLabel(finYearStartCalendarYear(latestActualFy) + startFyOffset);

  return { startFy, startMonth: ALL_MONTHS[startMonthIdx], endFy, endMonth, horizonMonths };
}

module.exports = {
  currentFinancialYearStart,
  nextForecastStartYears,
  forecastStartYear,
  buildYearOptions,
  ALL_MONTHS_TO_IDX,
  QUARTER_IDX,
  LAST_MONTH_OF_QUARTER,
  planForecastEndMonth,
  planForecastHorizonRange,
};
