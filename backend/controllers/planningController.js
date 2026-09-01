const planningService = require("../services/planningService");

/**
 * GET /api/planning/years — Admin only.
 * Thin HTTP layer — all logic lives in services/planningService.js.
 */
async function getAvailableStartYears(_req, res) {
  try {
    const years = await planningService.getAvailableStartYears();
    res.json({ years });
  } catch (err) {
    console.error("[planningController.getAvailableStartYears]", err);
    res.status(500).json({ message: "Internal server error while fetching available financial years." });
  }
}

/** Reads the same Op/Value/Min/Max shape buildMongoFilter uses, so Planning's numeric filters behave identically to every other module's. */
function readNumberFilter(query, key) {
  const op = query[`${key}Op`];
  const value = query[`${key}Value`];
  const min = query[`${key}Min`];
  const max = query[`${key}Max`];
  if ((op && value !== undefined && value !== "") || min !== undefined || max !== undefined) {
    return { op, value, min, max };
  }
  return undefined;
}

/**
 * GET /api/planning — Admin only. Query params: search, startYear.
 * Thin HTTP layer — all aggregation and forecasting logic lives in
 * services/planningService.js. This controller never touches Material,
 * Stock, or Sales directly.
 */
async function getPlanningData(req, res) {
  try {
    const { search, startYear, trend, stockRisk } = req.query;
    const growthPct = readNumberFilter(req.query, "growthPct");
    const confidence = readNumberFilter(req.query, "confidence");

    const result = await planningService.buildPlanningView({ search, startYear, trend, stockRisk, growthPct, confidence });
    res.json(result);
  } catch (err) {
    console.error("[planningController.getPlanningData]", err);
    res.status(500).json({ message: "Internal server error while building the planning view." });
  }
}

module.exports = { getPlanningData, getAvailableStartYears };
