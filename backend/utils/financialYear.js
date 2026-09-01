/**
 * Single source of truth for financial-year/quarter/month logic, shared by
 * Sales Master (validation + auto-quarter-generation on import/create) and
 * Planning Service (aggregating monthly Sales data into quarters). Having
 * one copy of this mapping is what makes "Quarter is never manually
 * entered, always derived from Month" actually safe — there's nowhere
 * else in the codebase this could drift out of sync.
 *
 * Indian financial year convention: Q1 = Apr-Jun ... Q4 = Jan-Mar.
 */
const MONTHS_BY_QUARTER = {
  Q1: ["April", "May", "June"],
  Q2: ["July", "August", "September"],
  Q3: ["October", "November", "December"],
  Q4: ["January", "February", "March"],
};

const QUARTER_BY_MONTH = {};
Object.entries(MONTHS_BY_QUARTER).forEach(([quarter, months]) => {
  months.forEach((month) => {
    QUARTER_BY_MONTH[month] = quarter;
  });
});

const ALL_MONTHS = Object.values(MONTHS_BY_QUARTER).flat();
const ALL_QUARTERS = Object.keys(MONTHS_BY_QUARTER);

/** Derives Q1-Q4 from a month name. Returns null for an unrecognized month. */
function deriveQuarter(month) {
  return QUARTER_BY_MONTH[month] || null;
}

function isValidMonth(month) {
  return Object.prototype.hasOwnProperty.call(QUARTER_BY_MONTH, month);
}

/** "2025-26" style financial year label — accepts a 4-digit start year + 2-digit end year. */
function isValidFinancialYear(fy) {
  return /^\d{4}-\d{2}$/.test(String(fy || "").trim());
}

/** e.g. 2025 -> "2025-26" (used by Planning Service to label its 3-year + forecast window). */
function finYearLabel(year) {
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/** "2025-26" -> 2025 (the calendar year Planning Service's numeric year-range logic already works in). */
function finYearStartCalendarYear(fyLabel) {
  const match = /^(\d{4})-\d{2}$/.exec(String(fyLabel || "").trim());
  return match ? parseInt(match[1], 10) : null;
}

/**
 * "2025-26" + "April" -> "2025-26-April". Same derivation principle as
 * Quarter — Period is a display/reference convenience, not independently
 * entered, so it can never drift from FinancialYear+Month.
 */
function derivePeriod(financialYear, month) {
  if (!financialYear || !month) return "";
  return `${financialYear}-${month}`;
}

module.exports = {
  MONTHS_BY_QUARTER,
  QUARTER_BY_MONTH,
  ALL_MONTHS,
  ALL_QUARTERS,
  deriveQuarter,
  derivePeriod,
  isValidMonth,
  isValidFinancialYear,
  finYearLabel,
  finYearStartCalendarYear,
};
