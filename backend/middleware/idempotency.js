/**
 * Idempotency for Distribution Stage 4 write endpoints.
 *
 *   requireIdempotencyKey  — rejects a request without a valid Idempotency-Key header (400).
 *   executeIdempotent      — runs an action in a transaction and stores its
 *                            successful response under the key IN THAT SAME
 *                            transaction, so the write and its record commit
 *                            (or roll back) together.
 *
 * Same key + same request (method, route, resource id, body) → the stored
 * response is replayed (header Idempotent-Replay: true) and nothing runs again.
 * Same key + different request → 409. Two simultaneous requests with one key:
 * the second's record insert hits the unique index, its whole transaction
 * aborts, and it replays the first's stored result.
 */
const crypto = require("crypto");
const IdempotencyRecord = require("../models/IdempotencyRecord");
const { runInTransaction, DistributionError } = require("../utils/transactions");

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function requireIdempotencyKey(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (!key) {
    return res.status(400).json({ message: "This operation requires an Idempotency-Key header (8–128 characters: letters, digits, . _ : -).", code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ message: "Invalid Idempotency-Key: use 8–128 characters (letters, digits, . _ : -).", code: "IDEMPOTENCY_KEY_INVALID" });
  }
  req.idempotencyKey = key;
  return next();
}

/** Deterministic JSON (sorted keys) so logically identical bodies hash identically. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(scope, body) {
  return crypto.createHash("sha256").update(stableStringify({ scope, body: body || {} })).digest("hex");
}

function replayOrConflict(record, hash) {
  if (record.requestHash !== hash) {
    throw new DistributionError(409, "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different request. Use a new key for a new operation.", { originalScope: record.scope });
  }
  return { status: record.responseStatus, body: record.responseBody, replayed: true };
}

/**
 * @param {object}   p
 * @param {string}   p.key     Idempotency-Key
 * @param {string}   p.scope   e.g. "POST /transfers/:id/dispatch 65f…"
 * @param {object}   p.body    request body (part of the identity of the request)
 * @param {string}   p.actor
 * @param {Function} p.action  async (session) => { status, body }
 */
async function executeIdempotent({ key, scope, body, actor, action }) {
  const hash = requestHash(scope, body);
  const existing = await IdempotencyRecord.findOne({ key }).lean();
  if (existing) return replayOrConflict(existing, hash);

  try {
    return await runInTransaction(async (session) => {
      const result = await action(session);
      const responseBody = JSON.parse(JSON.stringify(result.body));
      await IdempotencyRecord.create([{ key, scope, requestHash: hash, responseStatus: result.status, responseBody, actor }], { session });
      return { status: result.status, body: responseBody, replayed: false };
    });
  } catch (err) {
    // A concurrent request with the same key may have committed first. Its result
    // is then the answer — whether this attempt lost the race on the key's unique
    // index or (after a write-conflict retry) saw the state that winner produced.
    const winner = await IdempotencyRecord.findOne({ key }).lean();
    if (winner) return replayOrConflict(winner, hash);
    throw err;
  }
}

module.exports = { requireIdempotencyKey, executeIdempotent, requestHash, stableStringify, KEY_PATTERN };
