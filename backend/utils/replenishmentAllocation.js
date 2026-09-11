/**
 * Monthly Replenishment Allocation — planner-controlled timing of Required
 * Stock replenishment across the three months of the working quarter.
 *
 * The planner allocates percentages; this module converts them to integer
 * quantities that sum EXACTLY to Required Stock using a deterministic
 * largest-remainder algorithm (no rounding gaps, always reproducible).
 *
 * This is NOT demand distribution: it controls WHEN the already-calculated
 * Required Stock is replenished, not how much is demanded.
 *
 * Business example:
 *   Q2 Demand = 839, Current Stock = 648, Required Stock = 191
 *   Planner allocates 20% / 40% / 40% → 38 + 76 + 77 = 191 exactly.
 */

const REQUIRED_STOCK_MONTHS = ["July", "August", "September", "October", "November", "December", "January", "February", "March", "April", "May", "June"];

const WORKING_QUARTER_MONTHS = {
  Q1: ["April", "May", "June"],
  Q2: ["July", "August", "September"],
  Q3: ["October", "November", "December"],
  Q4: ["January", "February", "March"],
};

/**
 * Convert percentage allocations to integer quantities that sum exactly
 * to `requiredStock`. Uses the largest-remainder method: floor each
 * share, then distribute leftover units to months with the highest
 * fractional remainders (deterministic tie-break: first in array).
 *
 * When requiredStock is 0, all quantities are 0 regardless of percentages.
 *
 * @param {number} requiredStock - The total units to distribute (non-negative finite integer)
 * @param {number[]} percentages - Array of 3 finite percentages (0-100, sum = 100)
 * @returns {number[]} Array of integer quantities (same length as percentages)
 */
function computeAllocation(requiredStock, percentages) {
  if (!Number.isFinite(requiredStock) || requiredStock < 0) {
    return percentages.map(() => 0);
  }
  if (requiredStock === 0 || percentages.length === 0) {
    return percentages.map(() => 0);
  }

  const n = percentages.length;
  const exactShares = percentages.map((p) => (requiredStock * p) / 100);
  const floored = exactShares.map(Math.floor);
  let remaining = requiredStock - floored.reduce((s, v) => s + v, 0);

  // Distribute leftover units to months with the largest fractional part.
  const remainders = exactShares.map((v, i) => ({ index: i, remainder: v - Math.floor(v) }));
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < remaining && i < n; i++) {
    floored[remainders[i].index] += 1;
  }

  return floored;
}

/**
 * Build a default (temporary, not saved) equal-split allocation for a
 * working quarter. Splits 33.33 / 33.33 / 33.34 so percentages sum to
 * exactly 100.
 *
 * @param {string} quarter - e.g. "Q2"
 * @param {number} requiredStock - current required stock value
 * @returns {Array<{month: string, percentage: number, quantity: number, source: string}>}
 */
function computeDefaultAllocation(quarter, requiredStock) {
  const months = WORKING_QUARTER_MONTHS[quarter] || [];
  const n = months.length;
  if (n === 0) return [];

  const basePct = Math.floor((100 / n) * 100) / 100; // 33.33
  const remainderPct = Math.round((100 - basePct * (n - 1)) * 100) / 100; // 33.34
  const percentages = months.map((_, i) => (i === n - 1 ? remainderPct : basePct));
  const quantities = computeAllocation(requiredStock, percentages);

  return months.map((month, i) => ({
    month,
    percentage: percentages[i],
    quantity: quantities[i],
    source: "none", // source will be set by the caller from the planSeries
  }));
}

/**
 * Validate a distribution array for correctness:
 *   - Each entry: valid month (0-100, finite), quantity (>= 0, finite),
 *     and percentage sum = 100%.
 *   - Quantities sum = requiredStock (tolerance 0 for integer allocation).
 *
 * @param {Array<{month: string, percentage: number, quantity: number}>} distribution
 * @param {number} requiredStock
 * @returns {{valid: boolean, error?: string}}
 */
function validateDistribution(distribution, requiredStock) {
  if (!Array.isArray(distribution) || distribution.length === 0) {
    return { valid: false, error: "Distribution must be a non-empty array." };
  }

  let pctSum = 0;
  let qtySum = 0;

  for (let i = 0; i < distribution.length; i++) {
    const entry = distribution[i];
    const { month, percentage, quantity } = entry;

    if (!REQUIRED_STOCK_MONTHS.includes(month)) {
      return { valid: false, error: `Invalid month: "${month}".` };
    }
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return { valid: false, error: `Invalid percentage for ${month}: ${percentage}.` };
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      return { valid: false, error: `Invalid quantity for ${month}: ${quantity}.` };
    }
    pctSum += percentage;
    qtySum += quantity;
  }

  // Percentage sum must be exactly 100 (within rounding tolerance for floats).
  if (Math.abs(pctSum - 100) > 0.01) {
    return { valid: false, error: `Percentages sum to ${pctSum}%, expected 100%.` };
  }
  // Integer allocation must sum exactly to requiredStock.
  if (qtySum !== requiredStock) {
    return { valid: false, error: `Quantities sum to ${qtySum}, expected ${requiredStock}.` };
  }

  return { valid: true };
}

module.exports = {
  computeAllocation,
  computeDefaultAllocation,
  validateDistribution,
  REQUIRED_STOCK_MONTHS,
  WORKING_QUARTER_MONTHS,
};
