import api from "./api";

/**
 * Distribution Master API (backend: routes/distributionRoutes.js). Every
 * function maps 1:1 to an existing endpoint — request and response shapes
 * are the backend's own.
 *
 * Stage 4 writes (review + transfer lifecycle) REQUIRE an Idempotency-Key
 * header. Callers pass one key per user submission and reuse it when that
 * same submission is retried, so a retry after a lost response is replayed
 * by the server instead of applied twice (see newIdempotencyKey).
 */

/** Drops empty params so the backend never receives `field=` filters. */
function clean(params = {}) {
  const out = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) out[k] = v;
  });
  return out;
}

/** A fresh Idempotency-Key (backend accepts 8–128 chars of letters, digits, . _ : -). */
export function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `ui-${crypto.randomUUID()}`;
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const withKey = (key) => ({ headers: { "Idempotency-Key": key } });

// ─── Reads ───────────────────────────────────────────────────────────────────

/** GET /distribution/recommendations → { data, pagination } */
export async function fetchRecommendations(params) {
  const { data } = await api.get("/distribution/recommendations", { params: clean(params) });
  return data;
}

/** GET /distribution/recommendations/:id → recommendation */
export async function fetchRecommendation(id) {
  const { data } = await api.get(`/distribution/recommendations/${id}`);
  return data.recommendation;
}

/** GET /distribution/transfers → { data, pagination } */
export async function fetchTransfers(params) {
  const { data } = await api.get("/distribution/transfers", { params: clean(params) });
  return data;
}

/** GET /distribution/transfers/:id (Mongo _id) → transfer */
export async function fetchTransfer(id) {
  const { data } = await api.get(`/distribution/transfers/${id}`);
  return data.transfer;
}

/** Looks a transfer up by its business ID (TRF-000001) through the list filter. */
export async function fetchTransferByTransferId(transferId) {
  const { data } = await api.get("/distribution/transfers", { params: { transferId, limit: 1 } });
  return data.data[0] || null;
}

/** GET /distribution/transfers/:id/movements → StockMovement ledger entries */
export async function fetchTransferMovements(id) {
  const { data } = await api.get(`/distribution/transfers/${id}/movements`);
  return data.data;
}

/** GET /distribution/plant-mappings (all) → mapping rows */
export async function fetchPlantMappings() {
  const { data } = await api.get("/distribution/plant-mappings", { params: { limit: 500 } });
  return data.data;
}

/** Record count only, for KPI tiles (uses the list endpoint's pagination.total). */
export async function countRecommendations(params) {
  const { pagination } = await fetchRecommendations({ ...params, limit: 1 });
  return pagination.total;
}

export async function countTransfers(params) {
  const { pagination } = await fetchTransfers({ ...params, limit: 1 });
  return pagination.total;
}

// ─── Generation / analysis ───────────────────────────────────────────────────

/**
 * POST /distribution/recommendations/generate.
 * dryRun: true computes the full current analysis (positions, unfulfilled
 * shortages, filtered opportunities) WITHOUT writing anything.
 */
export async function generateRecommendations(options = {}) {
  const { data } = await api.post("/distribution/recommendations/generate", options);
  return data;
}

// ─── Stage 4 writes (Idempotency-Key required) ───────────────────────────────

/** POST /recommendations/:id/approve { approvedQuantity?, reviewNotes?, expectedVersion? } → { recommendation, transfer } */
export async function approveRecommendation(id, body, key) {
  const { data } = await api.post(`/distribution/recommendations/${id}/approve`, body, withKey(key));
  return data;
}

/** POST /recommendations/:id/reject { reviewNotes, expectedVersion? } → { recommendation } */
export async function rejectRecommendation(id, body, key) {
  const { data } = await api.post(`/distribution/recommendations/${id}/reject`, body, withKey(key));
  return data;
}

/**
 * Transfer lifecycle actions — POST /transfers/:id/{action}.
 *   approve    { approvedQuantity?, notes?, expectedVersion? }
 *   dispatch   { dispatchedQuantity?, notes?, expectedVersion? }
 *   in-transit { notes?, expectedVersion? }
 *   receive    { receivedQuantity, discrepancyReason?, notes?, expectedVersion? }
 *   cancel     { cancellationReason, expectedVersion? }
 * → { transfer, movements?, transitLoss? }
 */
export async function transferAction(id, action, body, key) {
  const { data } = await api.post(`/distribution/transfers/${id}/${action}`, body, withKey(key));
  return data;
}

// ─── Filter options for column filters (reuses existing master endpoints) ────

const STATIC_OPTIONS = {
  priority: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  recommendationStatus: ["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"],
  transferStatus: ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT", "RECEIVED", "CANCELLED"],
};

/** Builds a getFilterOptions(field, search) for DataTable column filters. */
export function createDistributionFilterOptions(statusKind) {
  return async function getFilterOptions(field, search) {
    const q = String(search || "").toUpperCase();
    if (field === "status" || field === "priority") {
      const list = field === "priority" ? STATIC_OPTIONS.priority : STATIC_OPTIONS[statusKind];
      return list.filter((v) => v.includes(q));
    }
    if (field === "sourceDepotId" || field === "destinationDepotId") {
      const { data } = await api.get("/depots/filter-values", { params: { field: "depotId", search: search || undefined } });
      return data.values;
    }
    if (field === "materialNo") {
      const { data } = await api.get("/materials/filter-values", { params: { field: "materialNo", search: search || undefined } });
      return data.values;
    }
    return [];
  };
}

export const DISTRIBUTION_OPTIONS = STATIC_OPTIONS;
