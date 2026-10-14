/**
 * Distribution Master status lifecycles — the single source of truth for
 * which statuses exist and which moves between them are legal. The models
 * enforce these on save, and later stages' services (approve, dispatch,
 * receive, ...) go through the same maps, so the workflow rule lives in
 * exactly one place.
 *
 * Recommendation (a generated, explainable suggestion — never a stock move):
 *   PENDING → APPROVED | REJECTED | SUPERSEDED   (all three are terminal)
 *
 * Transfer (the actual inter-depot business transaction):
 *   REQUESTED → APPROVED → DISPATCHED → IN_TRANSIT → RECEIVED
 *   REQUESTED | APPROVED → CANCELLED
 * Cancellation is only possible before goods leave the source depot; once
 * DISPATCHED, the stock is physically moving and must be received (a return
 * would be a new, reverse transfer).
 */
const RECOMMENDATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"];
const RECOMMENDATION_INITIAL_STATUS = "PENDING";
const RECOMMENDATION_TRANSITIONS = {
  PENDING: ["APPROVED", "REJECTED", "SUPERSEDED"],
  APPROVED: [],
  REJECTED: [],
  SUPERSEDED: [],
};

const TRANSFER_STATUSES = ["REQUESTED", "APPROVED", "DISPATCHED", "IN_TRANSIT", "RECEIVED", "CANCELLED"];
const TRANSFER_INITIAL_STATUS = "REQUESTED";
const TRANSFER_TRANSITIONS = {
  REQUESTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["IN_TRANSIT"],
  IN_TRANSIT: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
};

/** True when `from → to` is a legal move in `transitions`. A no-op (same status) is not a transition. */
function canTransition(transitions, from, to) {
  return Array.isArray(transitions[from]) && transitions[from].includes(to);
}

module.exports = {
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_INITIAL_STATUS,
  RECOMMENDATION_TRANSITIONS,
  TRANSFER_STATUSES,
  TRANSFER_INITIAL_STATUS,
  TRANSFER_TRANSITIONS,
  canTransition,
};
