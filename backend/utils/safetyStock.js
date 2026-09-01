/**
 * Safety Stock is not a field that exists anywhere in the current schema
 * (Stock Master tracks quantities/values, not a safety-stock threshold).
 * Rather than invent a stored value, this computes a standard planning
 * heuristic — half of average quarterly demand — from Sales Master's own
 * history, so it's derived from real data rather than fabricated.
 *
 * Isolated here (Section "Future Compatibility") so it's a one-function
 * swap once a real Safety Stock value is captured somewhere (e.g. a field
 * added to Material or Stock Master) instead of computed on the fly.
 */
function computeSafetyStock(quarterlySalesQtyValues) {
  const nonZero = quarterlySalesQtyValues.filter((v) => v > 0);
  if (nonZero.length === 0) return 0;
  const avg = nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length;
  return Math.round(avg * 0.5);
}

module.exports = { computeSafetyStock };
