/**
 * Week Coverage — a read-only inventory-health / early-warning indicator for
 * Planning Master. NOT a forecasting pipeline: it consumes the FORECAST
 * months of the existing active rolling forecast (the per-row `planSeries`
 * from services/planningService.js) and divides current stock by the average
 * weekly forecast demand those months imply.
 *
 * Formula:
 *   Average Weekly Forecast Demand =
 *     (Σ forecast demand over the eligible forecast months) ÷
 *     (Σ actual calendar days in those months) × 7
 *   Week Coverage = Current Stock ÷ Average Weekly Forecast Demand
 *
 * Days are real calendar days per month (via `new Date(y, m+1, 0)`, which
 * handles leap years), never an assumed 30-day / 4-week month.
 *
 * Thresholds: < 8 → CRITICAL · 8–16 inclusive → HEALTHY · > 16 → HIGH
 *
 * The caller passes ONLY the forecast portion of the planSeries (months with
 * `source === "forecast"`), so actual months can never leak into forecast
 * demand and no month is ever double-counted.
 *
 * Every invalid/no-data path returns a SAFE state — the consuming UI must
 * never see undefined/NaN/Infinity.
 */
const { finYearStartCalendarYear, calendarYearOfMonth } = require("./financialYear");

// Calendar-order month names (Jan = index 0 … Dec = index 11)
const CALENDAR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Actual number of days in a (calendar year, calendar month index) month. */
function daysInMonth(calendarYear, calendarMonthIndex) {
  return new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
}

function weekCoverageStatus(weeks) {
  if (weeks < 8) return "CRITICAL";
  if (weeks <= 16) return "HEALTHY";
  return "HIGH";
}

/**
 * Result states (all values are never NaN/Infinity):
 *   computed           — { avgWeeklyForecastDemand, weeks: number, status }
 *   no_forecast_demand — total eligible forecast demand is 0
 *   insufficient_forecast — no forecast months, or any forecast value invalid
 *   invalid_stock      — currentStock not a finite non-negative number
 *
 * Ordering note: when currentStock is 0 AND there is no forecast demand,
 * the deeper data condition wins → "no_forecast_demand" (a 0-week figure
 * would be meaningless without a denominator).
 *
 * @param {{ currentStock: number, forecastMonths: Array<{month, financialYear, qty}> }}
 * @returns {{ avgWeeklyForecastDemand, weeks, status, state }}
 */
function computeWeekCoverage({ currentStock, forecastMonths = [] }) {
  if (!Number.isFinite(currentStock) || currentStock < 0) {
    return { avgWeeklyForecastDemand: null, weeks: null, status: null, state: "invalid_stock" };
  }

  const eligible = [];
  for (const m of forecastMonths || []) {
    const fyStart = finYearStartCalendarYear(m && m.financialYear);
    if (fyStart === null) continue; // unparseable FY → not an eligible month
    const calendarYear = calendarYearOfMonth(m.month, fyStart);
    const monthIndex = CALENDAR_MONTHS.indexOf(m.month);
    if (monthIndex === -1) continue; // unparseable month → not eligible
    // Invalid/non-numeric/negative forecast demand means the average cannot
    // be trusted — return the safe insufficient-data state rather than
    // silently manufacturing a denominator.
    if (!Number.isFinite(m.qty) || m.qty < 0) {
      return { avgWeeklyForecastDemand: null, weeks: null, status: null, state: "insufficient_forecast" };
    }
    eligible.push({ calendarYear, monthIndex, qty: m.qty });
  }

  if (eligible.length === 0) {
    return { avgWeeklyForecastDemand: null, weeks: null, status: null, state: "insufficient_forecast" };
  }

  let totalDays = 0;
  let totalQty = 0;
  eligible.forEach((e) => {
    totalDays += daysInMonth(e.calendarYear, e.monthIndex);
    totalQty += e.qty;
  });

  if (totalQty <= 0) {
    return { avgWeeklyForecastDemand: 0, weeks: null, status: null, state: "no_forecast_demand" };
  }
  if (totalDays <= 0) {
    return { avgWeeklyForecastDemand: null, weeks: null, status: null, state: "insufficient_forecast" };
  }

  const avgWeeklyForecastDemand = (totalQty / totalDays) * 7;
  const weeks = currentStock / avgWeeklyForecastDemand;
  const weeksRounded = Math.round(weeks * 10) / 10; // one decimal, as displayed
  return {
    avgWeeklyForecastDemand: Math.round(avgWeeklyForecastDemand * 100) / 100,
    weeks: weeksRounded,
    // Threshold applies to the DISPLAYED value so "8.0 weeks" never appears
    // tagged Critical (and "16.0" never tagged High).
    status: weekCoverageStatus(weeksRounded),
    state: "computed",
  };
}

module.exports = { computeWeekCoverage, weekCoverageStatus, daysInMonth };