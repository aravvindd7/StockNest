/**
 * Distribution Master business configuration — the single place for
 * Distribution business-rule values (alongside config/db.js).
 *
 * MINIMUM TRANSFER QUANTITY
 * A recommendation whose quantity would be below the minimum is not created
 * (it is never rounded up to meet the minimum); the engine reports it as a
 * filtered opportunity instead. Default 10 units, overridable globally with
 * the DISTRIBUTION_MIN_TRANSFER_QUANTITY environment variable (a whole
 * number ≥ 1; an invalid value falls back to the default with a warning).
 *
 * resolveMinTransferQuantity(materialNo) is the ONE lookup the engine uses,
 * so a future material-level override (e.g. a Material Master field or a
 * per-material settings collection) only changes this function — not the
 * recommendation engine.
 */
const DEFAULT_MIN_TRANSFER_QUANTITY = 10;

let warnedInvalid = false;

function getGlobalMinTransferQuantity() {
  const raw = process.env.DISTRIBUTION_MIN_TRANSFER_QUANTITY;
  if (raw === undefined || raw === "") return DEFAULT_MIN_TRANSFER_QUANTITY;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1) return value;
  if (!warnedInvalid) {
    console.warn(`[config/distribution] Ignoring invalid DISTRIBUTION_MIN_TRANSFER_QUANTITY="${raw}" — using ${DEFAULT_MIN_TRANSFER_QUANTITY}.`);
    warnedInvalid = true;
  }
  return DEFAULT_MIN_TRANSFER_QUANTITY;
}

/** Minimum transfer quantity for a material. Today: the global value for every material. */
// eslint-disable-next-line no-unused-vars
function resolveMinTransferQuantity(materialNo) {
  return getGlobalMinTransferQuantity();
}

module.exports = { DEFAULT_MIN_TRANSFER_QUANTITY, getGlobalMinTransferQuantity, resolveMinTransferQuantity };
