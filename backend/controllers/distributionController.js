const distributionService = require("../services/distributionService");
const depotDemandService = require("../services/depotDemandService");
const depotSafetyStockService = require("../services/depotSafetyStockService");
const recommendationEngine = require("../services/distributionRecommendationService");
const { resolveActivePlantMapping } = require("../services/depotPlantMappingService");
const mlServiceClient = require("../services/mlServiceClient");
const DepotSafetyStock = require("../models/DepotSafetyStock");
const { buildMongoFilter, buildSort } = require("../utils/queryFilterBuilder");

/**
 * Distribution Master HTTP layer — thin wrappers over the Distribution
 * services, same split as Planning Master. Recommendations and transfers
 * are read-only (Stage 1); Stage 2 adds depot demand, depot safety stock
 * and forecast evaluation. Depot ↔ Plant mapping CRUD/import lives in
 * depotPlantMappingController.js.
 */

/** GET /api/distribution/recommendations — Admin only. Column filters, search, sortBy/sortDir, page/limit. */
async function listRecommendations(req, res) {
  try {
    res.json(await distributionService.listRecommendations(req.query));
  } catch (err) {
    console.error("[distributionController.listRecommendations]", err);
    res.status(500).json({ message: "Internal server error while fetching distribution recommendations." });
  }
}

/** GET /api/distribution/recommendations/:id — Admin only. */
async function getRecommendationById(req, res) {
  try {
    const recommendation = await distributionService.getRecommendationById(req.params.id);
    if (!recommendation) return res.status(404).json({ message: "Distribution recommendation not found." });
    res.json({ recommendation });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: "Invalid recommendation id." });
    console.error("[distributionController.getRecommendationById]", err);
    res.status(500).json({ message: "Internal server error while fetching the distribution recommendation." });
  }
}

/** GET /api/distribution/transfers — Admin only. Column filters, search, sortBy/sortDir, page/limit. */
async function listTransfers(req, res) {
  try {
    res.json(await distributionService.listTransfers(req.query));
  } catch (err) {
    console.error("[distributionController.listTransfers]", err);
    res.status(500).json({ message: "Internal server error while fetching distribution transfers." });
  }
}

/** GET /api/distribution/transfers/:id — Admin only. */
async function getTransferById(req, res) {
  try {
    const transfer = await distributionService.getTransferById(req.params.id);
    if (!transfer) return res.status(404).json({ message: "Distribution transfer not found." });
    res.json({ transfer });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: "Invalid transfer id." });
    console.error("[distributionController.getTransferById]", err);
    res.status(500).json({ message: "Internal server error while fetching the distribution transfer." });
  }
}

// ---- Stage 2: depot demand, depot safety stock, forecast evaluation ----

/**
 * GET /api/distribution/demand — Admin only. Read-only Material × Depot ×
 * Month forecast demand from stored ForecastPredictions via the active
 * Depot ↔ Plant mapping, with an `integrity` report. Query: materialNo,
 * depotId (comma lists), horizonMonths.
 */
async function getDepotDemand(req, res) {
  try {
    res.json(await depotDemandService.getDepotDemand(req.query));
  } catch (err) {
    console.error("[distributionController.getDepotDemand]", err);
    res.status(500).json({ message: "Internal server error while calculating depot demand." });
  }
}

const SAFETY_STOCK_FILTER_CONFIG = [
  { dbField: "materialNo", type: "text" },
  { dbField: "depotId", type: "text" },
  { dbField: "status", type: "text" },
  { dbField: "safetyStock", type: "number" },
];
const SAFETY_STOCK_SORTABLE_FIELDS = ["materialNo", "depotId", "safetyStock", "status", "calculatedAt"];

/** GET /api/distribution/safety-stock — Admin only. Material × Depot safety stock (read-only). */
async function listDepotSafetyStock(req, res) {
  try {
    const filter = buildMongoFilter(req.query, SAFETY_STOCK_FILTER_CONFIG);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const sort = buildSort(req.query, SAFETY_STOCK_SORTABLE_FIELDS, "materialNo");
    if (!req.query.sortBy) sort.depotId = 1;
    const [data, total] = await Promise.all([
      DepotSafetyStock.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      DepotSafetyStock.countDocuments(filter),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (err) {
    console.error("[distributionController.listDepotSafetyStock]", err);
    res.status(500).json({ message: "Internal server error while fetching depot safety stock." });
  }
}

/**
 * POST /api/distribution/safety-stock/refresh — Admin only, explicit trigger.
 * Recalculates depot safety stock from a fresh ML backtest. Writes only the
 * depotsafetystocks collection.
 */
async function refreshDepotSafetyStock(req, res) {
  try {
    res.json(await depotSafetyStockService.refreshDepotSafetyStock());
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ message: err.message });
    console.error("[distributionController.refreshDepotSafetyStock]", err);
    res.status(502).json({ message: "Could not refresh depot safety stock — the ML service backtest failed or is unavailable." });
  }
}

/**
 * GET /api/distribution/forecast-evaluation — Admin only. Runs the ML
 * backtest with comparison baselines and, using the active mapping,
 * depot-level accuracy. Evidence for model selection only.
 */
async function getForecastEvaluation(req, res) {
  try {
    const { plantToDepot, inactiveOnlyPlants, mappingsToUnknownDepots } = await resolveActivePlantMapping();
    const evaluation = await mlServiceClient.requestBacktestEvaluation({ depotMapping: Object.fromEntries(plantToDepot) });
    res.json({
      mapping: {
        activePlants: plantToDepot.size,
        inactiveOnlyPlants: [...inactiveOnlyPlants.keys()].sort(),
        mappingsToUnknownDepots,
        depotLevelAccuracy: plantToDepot.size > 0 ? "included" : "unavailable — no active depot-plant mappings",
      },
      evaluation,
    });
  } catch (err) {
    console.error("[distributionController.getForecastEvaluation]", err);
    res.status(502).json({ message: "Could not run the forecast evaluation — the ML service is unavailable or failed." });
  }
}

// ---- Stage 3: recommendation generation ----

const GENERATE_OPTIONS = ["horizonMonths", "materialNo", "dryRun", "allowMissingSafetyStock"];

/** Validates the generate request body; returns { options } or { errors }. */
function parseGenerateBody(body) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return { errors: ["Request body must be a JSON object."] };
  const errors = [];
  const unknown = Object.keys(body).filter((k) => !GENERATE_OPTIONS.includes(k));
  if (unknown.length) errors.push(`Unknown option(s): ${unknown.join(", ")}. Allowed: ${GENERATE_OPTIONS.join(", ")}.`);

  const options = {};
  if (body.horizonMonths !== undefined) {
    const h = body.horizonMonths;
    if (!Number.isInteger(h) || h < 1 || h > recommendationEngine.MAX_HORIZON_MONTHS) {
      errors.push(`horizonMonths must be a whole number from 1 to ${recommendationEngine.MAX_HORIZON_MONTHS}.`);
    } else options.horizonMonths = h;
  }
  if (body.materialNo !== undefined) {
    const list = Array.isArray(body.materialNo) ? body.materialNo : typeof body.materialNo === "string" ? body.materialNo.split(",") : null;
    const cleaned = list ? list.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean) : [];
    if (!list || !cleaned.length || cleaned.length !== list.length) errors.push("materialNo must be a non-empty string, comma list or array of material numbers.");
    else options.materialNos = cleaned;
  }
  ["dryRun", "allowMissingSafetyStock"].forEach((k) => {
    if (body[k] !== undefined) {
      if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`);
      else options[k] = body[k];
    }
  });
  return errors.length ? { errors } : { options };
}

/**
 * POST /api/distribution/recommendations/generate — Admin only.
 * Body (all optional): { horizonMonths (default 3), materialNo, dryRun, allowMissingSafetyStock }.
 * Creates PENDING DistributionRecommendations for one generation run (or, with
 * dryRun, returns what would be created without writing anything).
 */
async function generateRecommendations(req, res) {
  const { options, errors } = parseGenerateBody(req.body);
  if (errors) return res.status(400).json({ message: "Invalid generation request.", errors });
  try {
    const result = await recommendationEngine.generateRecommendations(options, { user: req.user.username });
    res.status(result.dryRun ? 200 : 201).json(result);
  } catch (err) {
    if (err.status === 409 || err.status === 422) return res.status(err.status).json({ message: err.message });
    console.error("[distributionController.generateRecommendations]", err);
    res.status(500).json({ message: "Internal server error while generating distribution recommendations." });
  }
}

module.exports = {
  generateRecommendations,
  parseGenerateBody,
  listRecommendations,
  getRecommendationById,
  listTransfers,
  getTransferById,
  getDepotDemand,
  listDepotSafetyStock,
  refreshDepotSafetyStock,
  getForecastEvaluation,
};
