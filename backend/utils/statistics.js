/**
 * Stage 3: Statistical utilities for Safety Stock calculation.
 *
 * Provides deterministic percentile calculation using linear interpolation
 * (Type 7 quantile algorithm — R default, NumPy default, Excel PERCENTILE).
 */

/**
 * Calculate the p-th percentile of a numeric array using linear interpolation.
 *
 * @param {number[]} values - Array of numbers (will be sorted in place)
 * @param {number} p - Percentile (0.0 to 1.0)
 * @returns {number} - The calculated percentile value
 *
 * Example:
 *   percentile([5, 10, 15, 20, 25], 0.90) => 23.0
 *
 * Algorithm: Type 7 quantile (linear interpolation), matching NumPy default.
 * This is the most common percentile definition in statistics.
 */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("percentile requires a non-empty array");
  }

  if (p < 0 || p > 1 || !Number.isFinite(p)) {
    throw new Error("percentile p must be between 0 and 1");
  }

  // Validate all values are finite numbers
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new Error("percentile requires all values to be finite numbers");
    }
  }

  // Sort ascending (modifies in place, but caller should not rely on this)
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 1) {
    return sorted[0];
  }

  // Type 7 quantile: linear interpolation
  // Position: p * (n - 1)
  const pos = p * (n - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const weight = pos - lower;

  // Interpolate between sorted[lower] and sorted[upper]
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

module.exports = { percentile };
