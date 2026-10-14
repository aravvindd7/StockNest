/**
 * Distribution Master — Stage 1 data/API foundation (read-only).
 *
 * Lists and fetches DistributionRecommendation and DistributionTransfer
 * records, plus the reference check every later write path (recommendation
 * generation, transfer creation) must pass. Nothing here generates
 * recommendations, forecasts demand, creates transfers or touches Stock
 * Master — those are later stages.
 *
 * Distribution consumes the existing masters as its sources of truth and
 * never copies them: Material Master (materialNo), Depot Master (depotId),
 * Stock Master (current stock), Sales Master (history), ForecastErrorStats
 * (safety stock) and the ML forecasting service (future demand).
 */
const mongoose = require("mongoose");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DistributionTransfer = require("../models/DistributionTransfer");
const Material = require("../models/Material");
const Depot = require("../models/Depot");
const { buildMongoFilter, buildSort, escapeRegex } = require("../utils/queryFilterBuilder");

const RECOMMENDATION_FILTER_CONFIG = [
  { dbField: "materialNo", type: "text" },
  { dbField: "sourceDepotId", type: "text" },
  { dbField: "destinationDepotId", type: "text" },
  { dbField: "status", type: "text" },
  { dbField: "priority", type: "text" },
  { dbField: "generationRunId", type: "text" },
  { dbField: "recommendedQuantity", type: "number" },
  { dbField: "destinationShortage", type: "number" },
  { dbField: "sourceSurplus", type: "number" },
];
const RECOMMENDATION_SORTABLE_FIELDS = [
  "generatedAt", "materialNo", "sourceDepotId", "destinationDepotId", "priority", "status",
  "recommendedQuantity", "destinationShortage", "sourceSurplus", "createdAt",
];

const TRANSFER_FILTER_CONFIG = [
  { dbField: "transferId", type: "text" },
  { dbField: "materialNo", type: "text" },
  { dbField: "sourceDepotId", type: "text" },
  { dbField: "destinationDepotId", type: "text" },
  { dbField: "status", type: "text" },
  { dbField: "requestedQuantity", type: "number" },
];
const TRANSFER_SORTABLE_FIELDS = [
  "requestedAt", "transferId", "materialNo", "sourceDepotId", "destinationDepotId", "status",
  "requestedQuantity", "createdAt",
];

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 100));
  return { page, limit };
}

async function paginate(Model, filter, sort, { page, limit }) {
  const [data, total] = await Promise.all([
    Model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

/** Free-text search across the identifier columns, combined with the shared column filters. */
function buildListFilter(query, filterConfig, searchFields) {
  const filter = buildMongoFilter(query, filterConfig);
  if (query.search) {
    const rx = { $regex: escapeRegex(String(query.search)), $options: "i" };
    filter.$or = searchFields.map((f) => ({ [f]: rx }));
  }
  return filter;
}

async function listRecommendations(query = {}) {
  const filter = buildListFilter(query, RECOMMENDATION_FILTER_CONFIG, ["materialNo", "sourceDepotId", "destinationDepotId", "reason"]);
  const sort = buildSort(query, RECOMMENDATION_SORTABLE_FIELDS, "generatedAt");
  if (!RECOMMENDATION_SORTABLE_FIELDS.includes(query.sortBy)) sort.generatedAt = -1; // default/fallback: newest first
  return paginate(DistributionRecommendation, filter, sort, pageParams(query));
}

async function listTransfers(query = {}) {
  const filter = buildListFilter(query, TRANSFER_FILTER_CONFIG, ["transferId", "materialNo", "sourceDepotId", "destinationDepotId"]);
  const sort = buildSort(query, TRANSFER_SORTABLE_FIELDS, "requestedAt");
  if (!TRANSFER_SORTABLE_FIELDS.includes(query.sortBy)) sort.requestedAt = -1;
  return paginate(DistributionTransfer, filter, sort, pageParams(query));
}

/** Returns null for an unknown id; throws a 400-tagged error for a malformed one. */
async function getById(Model, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid id.");
    err.status = 400;
    throw err;
  }
  return Model.findById(id).lean();
}

const getRecommendationById = (id) => getById(DistributionRecommendation, id);
const getTransferById = (id) => getById(DistributionTransfer, id);

/**
 * Confirms a material + depot route refers to real master data before any
 * later stage writes a recommendation or transfer. The material must be an
 * active, non-discontinued Material Master record (the same operational rule
 * Planning and Sales import use); both depots must exist in Depot Master and
 * differ. Returns a list of human-readable errors (empty = valid).
 */
async function validateReferences({ materialNo, sourceDepotId, destinationDepotId }) {
  const errors = [];
  const mat = String(materialNo || "").trim().toUpperCase();
  const src = String(sourceDepotId || "").trim().toUpperCase();
  const dst = String(destinationDepotId || "").trim().toUpperCase();

  if (!mat) errors.push("Material No is required.");
  if (!src) errors.push("Source depot is required.");
  if (!dst) errors.push("Destination depot is required.");
  if (src && dst && src === dst) errors.push("Source and destination depot must be different.");
  if (errors.length) return errors;

  const [material, depots] = await Promise.all([
    Material.findOne({ materialNo: mat, isActive: true }).select("materialNo status").lean(),
    Depot.find({ depotId: { $in: [src, dst] } }).select("depotId").lean(),
  ]);
  if (!material) errors.push(`Material "${mat}" does not exist in Material Master.`);
  else if (material.status === "Discontinued") errors.push(`Material "${mat}" is discontinued.`);

  const found = new Set(depots.map((d) => d.depotId));
  if (!found.has(src)) errors.push(`Source depot "${src}" does not exist in Depot Master.`);
  if (!found.has(dst)) errors.push(`Destination depot "${dst}" does not exist in Depot Master.`);
  return errors;
}

module.exports = {
  listRecommendations,
  listTransfers,
  getRecommendationById,
  getTransferById,
  validateReferences,
  RECOMMENDATION_SORTABLE_FIELDS,
  TRANSFER_SORTABLE_FIELDS,
};
