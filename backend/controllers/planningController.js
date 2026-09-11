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
 * GET /api/planning — Admin only. Query params: search, trend, stockRisk,
 * growthPct, confidence.
 *
 * Returns the fixed Active-FY operational timeline — Previous FY | Previous
 * FY | Active FY, derived entirely from the server clock (rolls forward
 * automatically). The Active FY is a per-month hybrid of actual + forecast;
 * PLAN and REQUIRED STOCK sit alongside it. Thin HTTP layer — all
 * aggregation and forecasting logic lives in services/planningService.js.
 * This controller never touches Material, Stock, or Sales directly.
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

/**
 * POST /api/planning/replenishment — Admin only.
 * Save a planner-controlled replenishment allocation. Body:
 *   { materialNo, financialYear, quarter, requiredStock, distribution: [{month, percentage, quantity, source}], depotId? }
 *
 * Recalculates quantities from percentages using the largest-remainder
 * algorithm (server-side source of truth), validates the result, and
 * upserts the ReplenishmentPlan document.
 */
async function saveReplenishmentPlan(req, res) {
  try {
    const { materialNo, financialYear, quarter, requiredStock, distribution, depotId } = req.body;

    // Basic presence checks.
    if (!materialNo || !financialYear || !quarter) {
      return res.status(400).json({ message: "materialNo, financialYear, and quarter are required." });
    }
    if (!Array.isArray(distribution) || distribution.length === 0) {
      return res.status(400).json({ message: "distribution must be a non-empty array." });
    }
    if (!Number.isFinite(requiredStock) || requiredStock < 0) {
      return res.status(400).json({ message: "requiredStock must be a non-negative number." });
    }

    const saved = await planningService.saveReplenishmentPlan({
      materialNo,
      financialYear,
      quarter,
      requiredStock,
      distribution,
      depotId,
      updatedBy: req.user?.username || "",
    });
    res.json(saved);
  } catch (err) {
    if (err.validation) {
      return res.status(400).json({ message: err.message });
    }
    console.error("[planningController.saveReplenishmentPlan]", err);
    res.status(500).json({ message: "Internal server error while saving replenishment allocation." });
  }
}

/**
 * GET /api/planning/replenishment — Admin only. Query params:
 *   materialNo, financialYear, quarter, depotId? (optional)
 *
 * Returns the saved allocation document, or 404 when none exists.
 */
async function loadReplenishmentPlan(req, res) {
  try {
    const { materialNo, financialYear, quarter, depotId } = req.query;
    if (!materialNo || !financialYear || !quarter) {
      return res.status(400).json({ message: "materialNo, financialYear, and quarter are required." });
    }
    const doc = await planningService.loadReplenishmentPlan({ materialNo, financialYear, quarter, depotId });
    if (!doc) {
      return res.status(404).json({ message: "No saved replenishment allocation found." });
    }
    res.json(doc);
  } catch (err) {
    console.error("[planningController.loadReplenishmentPlan]", err);
    res.status(500).json({ message: "Internal server error while loading replenishment allocation." });
  }
}

/**
 * POST /api/planning/replenishment/reset — Admin only.
 * Discard a saved manual replenishment allocation for a material's working
 * quarter. The persisted ReplenishmentPlan document is deleted, so on the next
 * load the active plan resolves back to the live AUTO_FORECAST prediction.
 * Body: { materialNo, financialYear, quarter, depotId? }
 */
async function resetReplenishmentPlan(req, res) {
  try {
    const { materialNo, financialYear, quarter, depotId } = req.body;
    if (!materialNo || !financialYear || !quarter) {
      return res.status(400).json({ message: "materialNo, financialYear, and quarter are required." });
    }
    const result = await planningService.resetReplenishmentPlan({ materialNo, financialYear, quarter, depotId });
    res.json(result);
  } catch (err) {
    console.error("[planningController.resetReplenishmentPlan]", err);
    res.status(500).json({ message: "Internal server error while resetting replenishment allocation." });
  }
}

/**
 * POST /api/planning/replenishment/apply-to-all — Admin only.
 * Apply a percentage distribution to ALL applicable materials for the current
 * financial year and quarter. Body:
 *   { financialYear: string, distribution: [{month, percentage, source?}] }
 *
 * Backend resolves the scope (all active, non-discontinued materials),
 * computes each material's requiredStock, applies percentages, validates,
 * and persists each as a MANUAL plan.
 * Returns { saved, affected, results: [{materialNo, status, error?}] }.
 */
async function applyToAllReplenishmentPlan(req, res) {
  try {
    const { financialYear, distribution } = req.body;
    if (!financialYear) {
      return res.status(400).json({ message: "financialYear is required." });
    }
    if (!Array.isArray(distribution) || distribution.length === 0) {
      return res.status(400).json({ message: "distribution must be a non-empty array." });
    }
    // Validate each distribution entry before calling the service.
    for (const entry of distribution) {
      if (!entry.month || !Number.isFinite(entry.percentage) || entry.percentage < 0 || entry.percentage > 100) {
        return res.status(400).json({ message: `Invalid distribution entry: ${JSON.stringify(entry)}.` });
      }
    }
    const pctSum = distribution.reduce((s, d) => s + d.percentage, 0);
    if (Math.abs(pctSum - 100) > 0.01) {
      return res.status(400).json({ message: `Percentages sum to ${pctSum}%, expected 100%.` });
    }
    const result = await planningService.applyToAllReplenishmentPlan({
      financialYear,
      distribution,
      updatedBy: req.user?.username || "",
    });
    res.json(result);
  } catch (err) {
    console.error("[planningController.applyToAllReplenishmentPlan]", err);
    res.status(500).json({ message: "Internal server error while applying distribution to all materials." });
  }
}

module.exports = { getPlanningData, getAvailableStartYears, saveReplenishmentPlan, loadReplenishmentPlan, resetReplenishmentPlan, applyToAllReplenishmentPlan };
