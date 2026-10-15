const mongoose = require("mongoose");
const service = require("../services/distributionTransferService");
const { executeIdempotent } = require("../middleware/idempotency");
const { DistributionError } = require("../utils/transactions");
const { PRIORITY_VALUES } = require("../models/DistributionRecommendation");

const BULK_APPROVAL_LIMIT = 500;

/**
 * Distribution Stage 4 HTTP layer — recommendation review and the transfer
 * lifecycle. Every write here is admin-only, requires transactions
 * (requireTransactions → 503 otherwise) and an Idempotency-Key header, and
 * runs as one atomic transaction (middleware/idempotency.executeIdempotent).
 */

// Per-action request bodies: unknown fields, wrong types and missing required fields are rejected (400).
const FIELD = {
  int: (min) => ({ type: "int", min }),
  str: () => ({ type: "string" }),
  // Non-empty list; `item` returns { value } or { error }, `normalize` checks/orders the whole list.
  list: (item, { max, normalize }) => ({ type: "list", item, max, normalize }),
};

const priorityItem = (v) => (typeof v === "string" && PRIORITY_VALUES.includes(v.trim().toUpperCase())
  ? { value: v.trim().toUpperCase() }
  : { error: `must be one of ${PRIORITY_VALUES.join(", ")}` });
const versionedIdItem = (v) => {
  const ok = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "id" || k === "version")
    && typeof v.id === "string" && mongoose.Types.ObjectId.isValid(v.id) && Number.isInteger(v.version) && v.version >= 0;
  return ok ? { value: { id: v.id, version: v.version } } : { error: "must be { id: <recommendation id>, version: <whole number ≥ 0> }" };
};
// Canonical order so the same selection always hashes to the same idempotent request.
const uniquePriorities = (list) => ({ value: PRIORITY_VALUES.filter((p) => list.includes(p)) });
const uniqueIds = (list) => (new Set(list.map((r) => r.id)).size !== list.length
  ? { error: "contains the same recommendation more than once" }
  : { value: [...list].sort((a, b) => a.id.localeCompare(b.id)) });
const SCHEMAS = {
  approveRecommendation: { approvedQuantity: FIELD.int(1), reviewNotes: FIELD.str(), expectedVersion: FIELD.int(0) },
  rejectRecommendation: { reviewNotes: { ...FIELD.str(), required: true }, expectedVersion: FIELD.int(0) },
  approveRecommendationsBulk: {
    priorities: { ...FIELD.list(priorityItem, { max: PRIORITY_VALUES.length, normalize: uniquePriorities }), required: true },
    recommendations: { ...FIELD.list(versionedIdItem, { max: BULK_APPROVAL_LIMIT, normalize: uniqueIds }), required: true },
  },
  createTransfer: {
    materialNo: { ...FIELD.str(), required: true },
    sourceDepotId: { ...FIELD.str(), required: true },
    destinationDepotId: { ...FIELD.str(), required: true },
    requestedQuantity: { ...FIELD.int(1), required: true },
    reason: { ...FIELD.str(), required: true },
    notes: FIELD.str(),
  },
  approveTransfer: { approvedQuantity: FIELD.int(1), notes: FIELD.str(), expectedVersion: FIELD.int(0) },
  dispatchTransfer: { dispatchedQuantity: FIELD.int(1), notes: FIELD.str(), expectedVersion: FIELD.int(0) },
  markInTransit: { notes: FIELD.str(), expectedVersion: FIELD.int(0) },
  receiveTransfer: { receivedQuantity: { ...FIELD.int(0), required: true }, discrepancyReason: FIELD.str(), notes: FIELD.str(), expectedVersion: FIELD.int(0) },
  cancelTransfer: { cancellationReason: { ...FIELD.str(), required: true }, expectedVersion: FIELD.int(0) },
};

function parseBody(body, schema) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return { errors: ["Request body must be a JSON object."] };
  const errors = [];
  const unknown = Object.keys(body).filter((k) => !(k in schema));
  if (unknown.length) errors.push(`Unknown field(s): ${unknown.join(", ")}. Allowed: ${Object.keys(schema).join(", ")}.`);
  const values = {};
  Object.entries(schema).forEach(([name, rule]) => {
    const v = body[name];
    if (v === undefined || v === null || (rule.type === "string" && typeof v === "string" && !v.trim())) {
      if (rule.required) errors.push(`${name} is required.`);
      return;
    }
    if (rule.type === "list") {
      if (!Array.isArray(v) || v.length === 0) return errors.push(`${name} must be a non-empty list.`);
      if (v.length > rule.max) return errors.push(`${name} may contain at most ${rule.max} entries.`);
      const items = v.map(rule.item);
      const bad = items.findIndex((r) => r.error);
      if (bad >= 0) return errors.push(`${name}[${bad}] ${items[bad].error}.`);
      const normalized = rule.normalize(items.map((r) => r.value));
      if (normalized.error) return errors.push(`${name} ${normalized.error}.`);
      values[name] = normalized.value;
      return undefined;
    }
    if (rule.type === "int") {
      if (!Number.isInteger(v) || v < rule.min) errors.push(`${name} must be a whole number ≥ ${rule.min}.`);
      else values[name] = v;
    } else if (typeof v !== "string") errors.push(`${name} must be a string.`);
    else values[name] = v.trim();
  });
  return errors.length ? { errors } : { values };
}

function sendError(res, err, label) {
  if (err instanceof DistributionError) {
    return res.status(err.status).json({ message: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(422).json({ message: "The change breaks a Distribution rule; nothing was changed.", code: "VALIDATION_FAILED", errors: Object.values(err.errors).map((e) => e.message) });
  }
  if (err instanceof mongoose.Error.VersionError) {
    return res.status(409).json({ message: "The record was changed concurrently; nothing was changed. Reload and retry.", code: "STALE_VERSION" });
  }
  console.error(`[distributionTransferController.${label}]`, err);
  return res.status(500).json({ message: "Internal server error — the operation was rolled back; nothing was changed." });
}

/** Builds an Express handler: validate body → run the service action atomically + idempotently. */
function action(label, { schema, scope, successStatus = 200, run }) {
  return async (req, res) => {
    const parsed = parseBody(req.body, SCHEMAS[schema]);
    if (parsed.errors) return res.status(400).json({ message: "Invalid request.", code: "INVALID_REQUEST", errors: parsed.errors });
    try {
      const ctx = { actor: req.user.username, idempotencyKey: req.idempotencyKey };
      const result = await executeIdempotent({
        key: req.idempotencyKey,
        scope: `${scope} ${req.params.id || ""}`.trim(),
        body: parsed.values,
        actor: ctx.actor,
        action: async (session) => ({ status: successStatus, body: await run(req.params.id, parsed.values, ctx, session) }),
      });
      if (result.replayed) res.set("Idempotent-Replay", "true");
      return res.status(result.status).json(result.body);
    } catch (err) {
      return sendError(res, err, label);
    }
  };
}

const approveRecommendation = action("approveRecommendation", {
  schema: "approveRecommendation", scope: "POST /recommendations/:id/approve", run: (id, v, ctx, s) => service.approveRecommendation(id, v, ctx, s),
});
const rejectRecommendation = action("rejectRecommendation", {
  schema: "rejectRecommendation", scope: "POST /recommendations/:id/reject", run: (id, v, ctx, s) => service.rejectRecommendation(id, v, ctx, s),
});
const approveRecommendationsBulk = action("approveRecommendationsBulk", {
  schema: "approveRecommendationsBulk", scope: "POST /recommendations/approve-bulk", run: (_id, v, ctx, s) => service.approveRecommendationsBulk(v, ctx, s),
});
const createTransfer = action("createTransfer", {
  schema: "createTransfer", scope: "POST /transfers", successStatus: 201, run: (_id, v, ctx, s) => service.createManualTransfer(v, ctx, s),
});
const approveTransfer = action("approveTransfer", {
  schema: "approveTransfer", scope: "POST /transfers/:id/approve", run: (id, v, ctx, s) => service.approveTransfer(id, v, ctx, s),
});
const dispatchTransfer = action("dispatchTransfer", {
  schema: "dispatchTransfer", scope: "POST /transfers/:id/dispatch", run: (id, v, ctx, s) => service.dispatchTransfer(id, v, ctx, s),
});
const markInTransit = action("markInTransit", {
  schema: "markInTransit", scope: "POST /transfers/:id/in-transit", run: (id, v, ctx, s) => service.markInTransit(id, v, ctx, s),
});
const receiveTransfer = action("receiveTransfer", {
  schema: "receiveTransfer", scope: "POST /transfers/:id/receive", run: (id, v, ctx, s) => service.receiveTransfer(id, v, ctx, s),
});
const cancelTransfer = action("cancelTransfer", {
  schema: "cancelTransfer", scope: "POST /transfers/:id/cancel", run: (id, v, ctx, s) => service.cancelTransfer(id, v, ctx, s),
});

/** GET /api/distribution/transfers/:id/movements — the transfer's StockMovement ledger entries (read-only). */
async function listTransferMovements(req, res) {
  try {
    res.json({ data: await service.listMovements(req.params.id) });
  } catch (err) {
    sendError(res, err, "listTransferMovements");
  }
}

module.exports = {
  approveRecommendation,
  rejectRecommendation,
  approveRecommendationsBulk,
  createTransfer,
  approveTransfer,
  dispatchTransfer,
  markInTransit,
  receiveTransfer,
  cancelTransfer,
  listTransferMovements,
  parseBody,
  SCHEMAS,
};
