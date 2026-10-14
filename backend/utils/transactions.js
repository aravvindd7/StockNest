/**
 * MongoDB transaction support — Distribution Stage 4.
 *
 * Physical stock movements must be atomic, which needs a replica set (a
 * standalone mongod rejects transactions). The capability is probed once at
 * startup (server.js) by committing a no-op transaction, and every Stage 4
 * write endpoint is guarded by requireTransactions: without transactions they
 * fail CLOSED with 503 — there is deliberately no non-transactional fallback.
 */
const mongoose = require("mongoose");

let supported = null; // null = not probed yet
let lastError = null;

/** Commits a no-op transaction; caches and returns whether transactions work. */
async function checkTransactionSupport() {
  try {
    await mongoose.connection.transaction(async (session) => {
      await mongoose.connection.db.collection("distributioncounters").findOne({ _id: "__txn_probe__" }, { session });
    });
    supported = true;
    lastError = null;
  } catch (err) {
    supported = false;
    lastError = err.codeName || err.message;
  }
  return supported;
}

function transactionStatus() {
  return { supported, lastError };
}

/** Express middleware: 503 unless transactions are available (probes lazily if never checked). */
async function requireTransactions(req, res, next) {
  try {
    if (supported === null) await checkTransactionSupport();
  } catch {
    supported = false;
  }
  if (!supported) {
    return res.status(503).json({
      message: "Distribution stock movements require MongoDB transactions (a replica set), which are not available. No changes were made.",
      code: "TRANSACTIONS_UNAVAILABLE",
      detail: lastError,
    });
  }
  return next();
}

/**
 * Runs fn(session) in a transaction (Mongoose retries transient errors such as
 * write conflicts — fn must therefore re-read everything it uses). Any thrown
 * error aborts and rolls back the whole transaction. Returns fn's result.
 */
async function runInTransaction(fn) {
  let result;
  await mongoose.connection.transaction(async (session) => {
    result = await fn(session);
  });
  return result;
}

/** Test hook. */
function setTransactionSupportForTests(value, error = null) {
  supported = value;
  lastError = error;
}

/** A business-rule failure with an HTTP status (thrown inside a transaction, it rolls everything back). */
class DistributionError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = {
  checkTransactionSupport,
  transactionStatus,
  requireTransactions,
  runInTransaction,
  setTransactionSupportForTests,
  DistributionError,
};
