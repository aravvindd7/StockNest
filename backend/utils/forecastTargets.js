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
const { finYearLabel } = require("./financialYear");

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

module.exports = {
  currentFinancialYearStart,
  nextForecastStartYears,
  forecastStartYear,
  buildYearOptions,
};
