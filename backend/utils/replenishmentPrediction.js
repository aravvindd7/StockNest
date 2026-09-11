/**
 * Forecast-Driven Replenishment Prediction — deterministic engine.
 *
 * Generates the AUTOMATIC monthly replenishment allocation (mode
 * "AUTO_FORECAST") for a working quarter, replacing the temporary
 * 33.33 / 33.33 / 33.34 fallback. It runs a stock-depletion simulation over
 * the working quarter's months and allocates Required Stock to the months
 * where projected stock actually runs out.
 *
 * THIS IS NOT MONTHLY DEMAND DISTRIBUTION (monthly demand / quarter demand):
 * it is a replenishment TIMING decision driven by when current stock is
 * projected to be depleted. It never trains or runs a second ML pipeline.
 *
 * How the XGBoost forecast is consumed:
 *   XGBoost predicts monthly DEMAND. This engine takes that demand forecast
 *   (via the planning view's per-month classification: actual / forecast /
 *   none) plus the CURRENT INVENTORY position, and decides WHEN the already
 *   calculated Required Stock should be replenished. It does NOT claim
 *   XGBoost predicted a percentage.
 *
 * Guarantees:
 *   - Completed historical months are never replenishment targets.
 *   - The simulation starts from current stock; already-consumed historical
 *     demand is never re-subtracted twice.
 *   - Quantities always sum EXACTLY to Required Stock (reuses the existing
 *     largest-remainder implementation — no second rounding algorithm).
 *   - Never fabricates percentages: missing/invalid forecast yields a safe
 *     "insufficient_forecast" state and an empty distribution.
 *   - Never emits NaN / Infinity / undefined.
 */

const { WORKING_QUARTER_MONTHS, computeAllocation } = require("./replenishmentAllocation");
const { ALL_MONTHS, calendarYearOfMonth } = require("./financialYear");

/** Calendar-order month names (Jan=0..Dec=11) — Document index 0 of getMonth(). */
const CALENDAR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Short human explanation surfaced to the planner for AUTO plans. */
const EXPLANATION =
  "Recommended from XGBoost demand forecast and projected stock depletion.";

/**
 * Absolute month-start time for a month name in a given FY (Jan–Mar belong to
 * calendar year fyStart+1). Used to decide completed (past) vs actionable
 * (current/future) months.
 */
function monthStartTime(month, fyStart) {
  const calYear = calendarYearOfMonth(month, fyStart);
  return new Date(calYear, CALENDAR_MONTHS.indexOf(month), 1).getTime();
}

/**
 * Build a "computed" (normal) AUTO allocation object from shortage weights.
 *
 * @param {string[]} monthNames - working-quarter month names in order
 * @param {number[]} weights - per-month shortage weights (completed months = 0)
 * @param {number} requiredStock
 * @param {string[]} sources - per-month source ("actual"|"forecast"|"none")
 * @param {object} meta - { financialYear, quarter }
 */
function buildComputedDistribution(monthNames, weights, requiredStock, sources, meta) {
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const percentages =
    totalWeight > 0
      ? weights.map((w) => (w / totalWeight) * 100)
      : weights.map(() => 0);
  // Round for stable storage/display; quantity allocation below is exact.
  const roundedPct = percentages.map((p) => Math.round(p * 100) / 100);
  const quantities = computeAllocation(requiredStock, roundedPct);

  const distribution = monthNames.map((month, i) => ({
    month,
    percentage: roundedPct[i],
    quantity: Number.isFinite(quantities[i]) ? quantities[i] : 0,
    source: sources[i] || "none",
  }));

  const shortageMonths = monthNames.filter((_, i) => weights[i] > 0);

  return {
    mode: "AUTO_FORECAST",
    state: "computed",
    financialYear: meta.financialYear,
    quarter: meta.quarter,
    requiredStock,
    distribution,
    shortageMonths,
    explanation: EXPLANATION,
  };
}

/** Safe N/A result for the non-computed states (never a fabricated plan). */
function safeNA({ state, requiredStock, meta }) {
  return {
    mode: "AUTO_FORECAST",
    state,
    financialYear: meta.financialYear,
    quarter: meta.quarter,
    requiredStock,
    distribution: [],
    shortageMonths: [],
    explanation: EXPLANATION,
  };
}

/**
 * Predict the automatic forecast-driven replenishment allocation.
 *
 * @param {object} args
 * @param {number} args.currentStock - current inventory on hand
 * @param {number} args.requiredStock - max(0, quarterDemand - currentStock)
 * @param {string} args.quarter - working quarter, e.g. "Q2"
 * @param {Array<{month: string, qty: number, source: string}>} args.monthly
 *        The working quarter's three months in order (ACTUAL qty for actual
 *        months, FORECAST qty for forecast months, 0 for none).
 * @param {Date} args.now - server clock
 * @param {number} args.activeFyStart - FY start year (e.g. 2026)
 * @param {string} [args.financialYear] - "2026-27" style label
 * @returns {{mode:"AUTO_FORECAST", state:string, financialYear, quarter,
 *           requiredStock, distribution:Array, shortageMonths?:string[],
 *           explanation:string}}
 */
function predictReplenishment({ currentStock, requiredStock, quarter, monthly = [], now = new Date(), activeFyStart, financialYear }) {
  const meta = { financialYear, quarter };

  // Invalid stock position → safe N/A (never a fabricated plan).
  if (!Number.isFinite(currentStock) || currentStock < 0) {
    return safeNA({ state: "invalid_stock", requiredStock, meta });
  }

  const monthNames = WORKING_QUARTER_MONTHS[quarter] || [];
  if (monthNames.length === 0) {
    return safeNA({ state: "insufficient_forecast", requiredStock, meta });
  }

  // Required Stock is 0 → nothing to replenish. Always a clean all-zero plan
  // regardless of forecast availability (nothing to time).
  if (requiredStock <= 0) {
    return buildComputedDistribution(monthNames, monthNames.map(() => 0), 0, monthNames.map(() => "none"), meta);
  }

  // Map the quarter's monthly demand/source by month name (in quarter order).
  const demandByMonth = {};
  const sourceByMonth = {};
  const presentByMonth = {};
  monthly.forEach((m) => {
    if (monthNames.includes(m.month)) {
      demandByMonth[m.month] = m.qty;
      sourceByMonth[m.month] = m.source;
      presentByMonth[m.month] = true;
    }
  });

  // Any non-"none" month must carry a valid finite, non-negative demand.
  // A "none" month is simply absent forecast demand and contributes 0.
  const hasInvalidDemand = monthNames.some((month) => {
    if (!presentByMonth[month] || sourceByMonth[month] === "none") return false;
    const qty = demandByMonth[month];
    return !Number.isFinite(qty) || qty < 0;
  });
  if (hasInvalidDemand) {
    return safeNA({ state: "insufficient_forecast", requiredStock, meta });
  }

  // The prediction is forecast-driven: it needs at least one FORECAST month
  // in the working quarter. If none exists (all actual/none), there is no
  // forecast basis — N/A · Insufficient Forecast.
  const hasForecastMonth = monthNames.some((month) => sourceByMonth[month] === "forecast");
  if (!hasForecastMonth) {
    return safeNA({ state: "insufficient_forecast", requiredStock, meta });
  }

  // No forecast DEMAND at all (forecast present but sums to 0) → nothing for
  // the forecast to deplete against.
  const forecastDemand = monthNames.reduce(
    (s, month) => s + (sourceByMonth[month] === "forecast" ? demandByMonth[month] : 0),
    0
  );
  if (forecastDemand === 0) {
    return safeNA({ state: "no_forecast_demand", requiredStock, meta });
  }

  // ─── Stock-depletion simulation ────────────────────────────────────────────
  // A month is actionable (a replenishment target) when it is the current
  // month or later. Completed months are never targets, but their demand still
  // consumes stock in the projection (current stock is the position from which
  // the whole quarter's remaining plan is projected).
  const currentMonth = CALENDAR_MONTHS[now.getMonth()] || "January";
  const nowK = monthStartTime(currentMonth, activeFyStart);
  const isActionable = (month) => monthStartTime(month, activeFyStart) >= nowK;

  const sources = monthNames.map((month) => sourceByMonth[month] || "none");
  let runningStock = currentStock;
  const weights = monthNames.map((month) => {
    const demand = presentByMonth[month] ? demandByMonth[month] : 0;
    const stockBefore = Math.max(0, runningStock);
    const shortage = Math.max(0, demand - stockBefore);
    runningStock = stockBefore - demand; // may go negative
    return isActionable(month) ? shortage : 0; // completed months: never targets
  });

  // If no actionable month shows a shortage but stock still needs replenishing
  // (requiredStock > 0), the only honest timing is ASAP → the first actionable
  // month. (Reachable only when stock ran out in a completed month and no
  // actionable month has forward demand.)
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) {
    const firstActionable = monthNames.findIndex(isActionable);
    if (firstActionable >= 0) weights[firstActionable] = 1;
  }

  return buildComputedDistribution(monthNames, weights, requiredStock, sources, meta);
}

/**
 * Resolve the ACTIVE replenishment plan for a row.
 *
 * A saved MANUAL plan is authoritative and never auto-overwritten; its stored
 * quantities are recomputed against the CURRENT requiredStock (largest-
 * remainder) so the displayed sum always equals today's required stock. When
 * no saved plan exists, the current AUTO_FORECAST prediction is the active
 * plan. `autoPlan` is always attached so the UI can offer Reset → latest AUTO.
 *
 * @param {{savedPlan: object|null, autoPlan: object, requiredStock: number,
 *          workingQuarter: string}} args
 * @returns {object} the active replenishment plan (mode MANUAL or AUTO_FORECAST)
 */
function resolveActivePlan({ savedPlan, autoPlan, requiredStock, workingQuarter }) {
  const monthCount = (WORKING_QUARTER_MONTHS[workingQuarter] || []).length;
  if (savedPlan && Array.isArray(savedPlan.distribution) && savedPlan.distribution.length === monthCount) {
    const distribution = savedPlan.distribution;
    const quantities = computeAllocation(requiredStock, distribution.map((d) => d.percentage));
    return {
      mode: "MANUAL",
      state: autoPlan.state,
      financialYear: savedPlan.financialYear,
      quarter: savedPlan.quarter,
      requiredStock,
      distribution: distribution.map((d, i) => ({
        month: d.month,
        percentage: d.percentage,
        quantity: Number.isFinite(quantities[i]) ? quantities[i] : 0,
        source: d.source || "none",
      })),
      explanation: autoPlan.explanation,
    };
  }
  // No saved manual plan → the automatic forecast-driven prediction is active.
  return autoPlan;
}

module.exports = { predictReplenishment, resolveActivePlan, EXPLANATION };
