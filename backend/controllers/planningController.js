const planningService = require("../services/planningService");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { MONTHS_BY_QUARTER } = require("../utils/financialYear");

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

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const MONTH_ABBREV = { April: "Apr", May: "May", June: "Jun", July: "Jul", August: "Aug", September: "Sep", October: "Oct", November: "Nov", December: "Dec", January: "Jan", February: "Feb", March: "Mar" };

const WEEK_STATUS_LABEL = { CRITICAL: "Critical", HEALTHY: "Healthy", HIGH: "High Stock" };

/**
 * Build 5 export columns per FY group: Q1, Q2, Q3, Q4, Total.
 * Labels like "2024-25 Q1", "2024-25 Q2", ..., "2024-25 Total".
 */
function buildFYGroupColumns(groups) {
  const cols = [];
  for (const g of groups) {
    const prefix = g.viewYear.label;
    for (const q of QUARTERS) {
      cols.push({ key: `${prefix} ${q}`, label: `${prefix} ${q}` });
    }
    cols.push({ key: `${prefix} Total`, label: `${prefix} Total` });
  }
  return cols;
}

/**
 * Flatten FY group quarter/total values from a row's `years` map into a flat
 * object keyed by "2024-25 Q1", "2024-25 Total", etc.
 */
function flattenFYGroups(row, groups) {
  const flat = {};
  for (const g of groups) {
    const block = row.years?.[g.viewYear.value];
    const prefix = g.viewYear.label;
    for (const q of QUARTERS) {
      flat[`${prefix} ${q}`] = block?.quarters?.[q]?.qty ?? "";
    }
    flat[`${prefix} Total`] = block?.total ?? "";
  }
  return flat;
}

/**
 * Format a ReplenishmentPlan object as a text cell matching
 * PlanningTable's ReplenishmentPlanCell rendering.
 */
function formatReplenishmentPlan(plan) {
  if (!plan || plan.requiredStock === 0) return "—";
  if (plan.state === "insufficient_forecast" || plan.state === "invalid_stock") return "N/A · Insufficient Forecast";
  if (plan.state === "no_forecast_demand") return "No forecast demand";
  if (!plan.distribution || plan.distribution.length === 0) return "—";
  const pct = plan.distribution.map((d) => Math.round(d.percentage));
  const sum = pct.reduce((s, v) => s + v, 0);
  if (sum !== 100 && pct.length) pct[pct.length - 1] += 100 - sum;
  const summary = pct.map((p) => `${p}%`).join(" / ");
  const tag = plan.mode === "MANUAL" ? "MANUAL" : "AUTO";
  return `${summary} ${tag}`;
}

/**
 * Format Monthly Replenishment as a text cell matching PlanningTable's
 * MonthlyReplenishmentCell rendering — e.g. "Apr: 100 | May: 200 | Jun: 300".
 */
function formatMonthlyReplenishment(plan, workingQuarter) {
  if (!plan || plan.requiredStock === 0 || plan.state === "insufficient_forecast" || plan.state === "invalid_stock") return "—";
  const months = MONTHS_BY_QUARTER[workingQuarter];
  if (!months || !plan.distribution || plan.distribution.length === 0) return "—";
  return months.map((m, idx) => {
    const d = plan.distribution[idx];
    const val = d && Number.isFinite(d.quantity) && d.quantity != null ? Number(d.quantity) : "—";
    return `${MONTH_ABBREV[m] || m}: ${val}`;
  }).join(" | ");
}

/**
 * Format Week Coverage as a text cell matching PlanningTable's
 * WeekCoverageCell rendering — e.g. "2.5 weeks · Healthy".
 */
function formatWeekCoverage(wc) {
  if (!wc) return "N/A";
  if (wc.state === "invalid_stock") return "N/A";
  if (wc.state === "insufficient_forecast") return "N/A · Insufficient Forecast";
  if (wc.state === "no_forecast_demand") return "No forecast demand";
  const weeks = wc.weeks === 0 ? "0" : wc.weeks.toFixed(1);
  return `${weeks} weeks · ${WEEK_STATUS_LABEL[wc.status] || wc.status}`;
}

/**
 * Format a trend value as a text arrow matching PlanningTable's TrendArrow.
 */
function formatTrend(t) {
  if (t === "up") return "↗";
  if (t === "down") return "↘";
  if (t === "flat") return "→";
  return "";
}

/**
 * GET /api/planning/export — Admin only. Exports the filtered Planning
 * Master view as an .xlsx file. Reuses buildPlanningView with the same
 * query params to guarantee backend-as-source-of-truth.
 */
async function exportPlanningData(req, res) {
  try {
    const { search, trend, stockRisk } = req.query;
    const growthPct = readNumberFilter(req.query, "growthPct");
    const confidence = readNumberFilter(req.query, "confidence");

    const result = await planningService.buildPlanningView({ search, trend, stockRisk, growthPct, confidence });

    const currentQuarterLabel = result.currentQuarter?.label || "Q1";
    const hasForecastData = Boolean(result.hasForecastData);

    // Dynamic current-quarter columns
    const cqCols = [
      { key: "currentQuarterSales", label: `${currentQuarterLabel} Sales` },
      { key: "currentQuarterSalesToGo", label: `${currentQuarterLabel} Sales to Go` },
    ];

    // Sticky-right operational columns (mirrors PlanningTable STICKY_RIGHT)
    const rightCols = [
      { key: "plan", label: "Plan" },
      { key: "currentStock", label: "Current Stock" },
      { key: "requiredStock", label: "Required Stock" },
      ...cqCols,
      { key: "monthlyReplenishment", label: "Monthly Replenishment" },
      { key: "replenishmentPlan", label: "Replenishment Plan" },
      { key: "weekCoverage", label: "Week Coverage" },
      { key: "safetyStock", label: "Safety Stock" },
      { key: "trend", label: "Trend" },
    ];
    if (hasForecastData) {
      rightCols.push({ key: "confidence", label: "Forecast Confidence" });
    }

    const columns = [
      { key: "materialNo", label: "Material No" },
      { key: "materialName", label: "Material Name" },
      ...buildFYGroupColumns(result.groups),
      ...rightCols,
    ];

    const rows = result.data.map((row) => ({
      materialNo: row.materialNo,
      materialName: row.materialName,
      ...flattenFYGroups(row, result.groups),
      plan: row.planDemand ?? "",
      currentStock: row.currentStock ?? "",
      requiredStock: row.requiredStock ?? "",
      currentQuarterSales: row.currentQuarterSales ?? "",
      currentQuarterSalesToGo: row.currentQuarterSalesToGo ?? "",
      monthlyReplenishment: formatMonthlyReplenishment(row.replenishmentPlan, result.workingQuarter),
      replenishmentPlan: formatReplenishmentPlan(row.replenishmentPlan),
      weekCoverage: formatWeekCoverage(row.weekCoverage),
      safetyStock: row.safetyStock ?? "",
      trend: formatTrend(row.trend),
      confidence: row.confidence ?? "",
    }));

    const buffer = buildXlsxBuffer(columns, rows);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="planning_master.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("[planningController.exportPlanningData]", err);
    res.status(500).json({ message: "Export failed", error: err.message });
  }
}

module.exports = { getPlanningData, getAvailableStartYears, saveReplenishmentPlan, loadReplenishmentPlan, resetReplenishmentPlan, applyToAllReplenishmentPlan, exportPlanningData };
