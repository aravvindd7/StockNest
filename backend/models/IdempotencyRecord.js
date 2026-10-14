const mongoose = require("mongoose");

/**
 * IdempotencyRecord — Distribution Stage 4.
 *
 * Every Stage 4 write endpoint requires an Idempotency-Key header. The
 * successful result is stored here in the SAME transaction as the write, so
 * either both exist or neither does:
 *   same key + same request (endpoint, resource and body) → original result replayed
 *   same key + different request                           → 409
 * A failed request stores nothing, so a retry simply runs again.
 */
const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    scope: { type: String, required: true }, // e.g. "POST /transfers/:id/dispatch :: <id>"
    requestHash: { type: String, required: true },
    responseStatus: { type: Number, required: true },
    responseBody: { type: mongoose.Schema.Types.Mixed, required: true },
    actor: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

module.exports = mongoose.model("IdempotencyRecord", idempotencyRecordSchema);
