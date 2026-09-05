const planningService = require("../services/planningService");

/**
 * GET /api/planning/years — Admin only.
 * Returns { years: [...], currentFY } — options include current, historical,
 * and future (forecast) financial years with flags.
 */
async function getAvailableStartYears(_req, res) {
  try {
    const result = await planningService.getAvailableStartYears();
    res.json(result);
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
 * GET /api/planning — Admin only. Query params: search, viewYears
 * (comma-separated FY start years, e.g. "2025,2026,2027"), trend,
 * stockRisk, growthPct, confidence.
 *
 * Returns the 3-slot FY comparison — three independent, user-selectable FY
 * column groups. Defaults (when viewYears is absent) to Previous | Current
 * | Next-Forecast FY. Thin HTTP layer — all aggregation and forecasting
 * logic lives in services/planningService.js. This controller never touches
 * Material, Stock, or Sales directly.
 */
async function getPlanningData(req, res) {
  try {
    const { search, viewYears, trend, stockRisk } = req.query;
    const growthPct = readNumberFilter(req.query, "growthPct");
    const confidence = readNumberFilter(req.query, "confidence");

    const parsedYears = viewYears
      ? String(viewYears).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
      : undefined;

    const result = await planningService.buildPlanningView({
      search, trend, stockRisk, growthPct, confidence, viewYears: parsedYears,
    });
    res.json(result);
  } catch (err) {
    console.error("[planningController.getPlanningData]", err);
    res.status(500).json({ message: "Internal server error while building the planning view." });
  }
}

module.exports = { getPlanningData, getAvailableStartYears };
