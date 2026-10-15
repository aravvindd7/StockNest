/**
 * Change detection for the Monthly Replenishment Allocation editor — mirrors
 * isSameAllocation in backend/utils/replenishmentAllocation.js (kept in step
 * by backend/tests/replenishmentSaveUnchanged.test.js).
 *
 * Two allocations are the same when they cover the same months with the same
 * percentages to 0.01% (the precision that is persisted). Array order,
 * property order, extra fields and float noise are ignored; quantities are
 * not compared because they are always derived from the percentages and the
 * current Required Stock. A malformed allocation is never "the same".
 */
function allocationKey(distribution) {
  if (!Array.isArray(distribution) || distribution.length === 0) return null;
  const byMonth = new Map();
  for (const d of distribution) {
    if (!d || typeof d.month !== "string" || !Number.isFinite(d.percentage) || byMonth.has(d.month)) return null;
    byMonth.set(d.month, Math.round(d.percentage * 100));
  }
  return byMonth;
}

export function isSameAllocation(a, b) {
  const ka = allocationKey(a);
  const kb = allocationKey(b);
  if (!ka || !kb || ka.size !== kb.size) return false;
  for (const [month, pct] of ka) {
    if (kb.get(month) !== pct) return false;
  }
  return true;
}
