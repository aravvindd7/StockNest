const Sales = require("../models/Sales");
const { SALES_COLUMNS, USER_EDITABLE_KEYS } = require("../models/Sales");
const Material = require("../models/Material");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { buildMongoFilter, buildSort, getDistinctValues } = require("../utils/queryFilterBuilder");
const { deriveQuarter, derivePeriod, isValidMonth, isValidFinancialYear, MONTHS_BY_QUARTER } = require("../utils/financialYear");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SALES_SORTABLE_FIELDS = ["MatNo", "Material", "Plant", "FinancialYear", "Month", "Quarter", "SalesQty", "NetSales"];

// Every visible Sales Master column is filterable, derived from
// SALES_COLUMNS — same pattern as every other module in the Global ERP
// Filtering System. Sales Master still has no "Depot" field (only Plant)
// or day-level date, so those aren't filterable — nothing to filter on.
const SALES_FILTER_CONFIG = SALES_COLUMNS.map((c) => ({
  dbField: c.key,
  type: c.type === "Number" ? "number" : "text",
}));

/**
 * GET /api/sales — Admin only. The full operational Sales Master record
 * list — the Detailed Records view's data source, and what Export/Import/
 * Add Sales all work against. This is the "what happened" record store;
 * GET /api/sales/summary (below) is a derived, read-oriented view on top
 * of it for the Quarterly Summary tab, not a replacement for this.
 */
async function listSales(req, res) {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ MatNo: rx }, { Material: rx }, { Plant: rx }];
    }
    Object.assign(query, buildMongoFilter(req.query, SALES_FILTER_CONFIG));

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const sort = req.query.sortBy
      ? buildSort(req.query, SALES_SORTABLE_FIELDS, "FinancialYear")
      : { FinancialYear: -1, Quarter: 1, Month: 1, Plant: 1 };

    const [data, total] = await Promise.all([
      Sales.find(query).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum),
      Sales.countDocuments(query),
    ]);

    res.json({
      data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("[salesController.listSales]", err);
    res.status(500).json({ message: "Internal server error while fetching sales records." });
  }
}

const SALES_FILTERABLE_FIELDS = new Set(SALES_FILTER_CONFIG.filter((f) => f.type === "text").map((f) => f.dbField));
/** GET /api/sales/filter-values?field=MatNo&search= — live options for a column filter popup. */
async function getSalesFilterValues(req, res) {
  try {
    const { field, search } = req.query;
    if (!SALES_FILTERABLE_FIELDS.has(field)) {
      return res.status(400).json({ message: `Field "${field}" is not filterable.` });
    }
    const values = await getDistinctValues(Sales, field, search);
    res.json({ values: values.map(String) });
  } catch (err) {
    console.error("[salesController.getSalesFilterValues]", err);
    res.status(500).json({ message: "Internal server error while fetching filter values." });
  }
}

/**
 * GET /api/sales/summary — Admin only. The Sales Master main table's data
 * source: one row per Material + Financial Year, with Q1-Q4 sums —
 * Section 3's "Material | Financial Year | Q1 | Q2 | Q3 | Q4" layout.
 * Quarterly totals are a live MongoDB aggregation over the monthly rows
 * (grouped by the already-derived Quarter field), never a separately
 * stored value — this is what makes monthly-to-quarterly consistency
 * structural rather than something that needs checking (Section 5).
 */
async function getSalesSummary(req, res) {
  try {
    const { search, FinancialYear, Plant, MaterialGroup, ProductionCycle } = req.query;
    const match = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      match.$or = [{ MatNo: rx }, { Material: rx }];
    }
    if (FinancialYear) match.FinancialYear = { $in: String(FinancialYear).split(",").filter(Boolean) };
    if (Plant) match.Plant = { $in: String(Plant).split(",").filter(Boolean) };
    if (MaterialGroup) match.MaterialGroup = { $in: String(MaterialGroup).split(",").filter(Boolean) };
    if (ProductionCycle) match.ProductionCycle = { $in: String(ProductionCycle).split(",").filter(Boolean) };

    const rows = await Sales.aggregate([
      { $match: match },
      {
        $group: {
          _id: { MatNo: "$MatNo", FinancialYear: "$FinancialYear", Quarter: "$Quarter" },
          Material: { $first: "$Material" },
          qty: { $sum: "$SalesQty" },
        },
      },
      {
        $group: {
          _id: { MatNo: "$_id.MatNo", FinancialYear: "$_id.FinancialYear" },
          Material: { $first: "$Material" },
          quarters: { $push: { quarter: "$_id.Quarter", qty: "$qty" } },
        },
      },
      { $sort: { "_id.MatNo": 1, "_id.FinancialYear": 1 } },
    ]);

    const data = rows.map((r) => {
      const byQuarter = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
      r.quarters.forEach((q) => {
        if (byQuarter[q.quarter] !== undefined) byQuarter[q.quarter] = q.qty;
      });
      const total = byQuarter.Q1 + byQuarter.Q2 + byQuarter.Q3 + byQuarter.Q4;
      return {
        materialNo: r._id.MatNo,
        materialName: r.Material,
        financialYear: r._id.FinancialYear,
        ...byQuarter,
        total,
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("[salesController.getSalesSummary]", err);
    res.status(500).json({ message: "Internal server error while building the sales summary." });
  }
}

/**
 * GET /api/sales/monthly?materialNo=&financialYear=&quarter= — Admin only.
 * The expandable-quarter-detail data source (Section 3) — fetched only
 * when a quarter cell is clicked, not embedded in the summary response.
 */
async function getSalesMonthlyBreakdown(req, res) {
  try {
    const { materialNo, financialYear, quarter } = req.query;
    if (!materialNo || !financialYear || !quarter) {
      return res.status(400).json({ message: "materialNo, financialYear, and quarter are all required." });
    }

    const rows = await Sales.aggregate([
      { $match: { MatNo: materialNo, FinancialYear: financialYear, Quarter: quarter } },
      { $group: { _id: "$Month", qty: { $sum: "$SalesQty" } } },
    ]);

    const byMonth = Object.fromEntries(rows.map((r) => [r._id, r.qty]));
    const months = (MONTHS_BY_QUARTER[quarter] || []).map((month) => ({ month, qty: byMonth[month] || 0 }));
    const total = months.reduce((sum, m) => sum + m.qty, 0);

    res.json({ materialNo, financialYear, quarter, months, total });
  } catch (err) {
    console.error("[salesController.getSalesMonthlyBreakdown]", err);
    res.status(500).json({ message: "Internal server error while building the monthly breakdown." });
  }
}

/**
 * Validates Add Sales input (Phase 1 Section 2's rules, reused for both
 * manual entry and Excel import row validation via the same underlying
 * checks): Material Number must exist in Material Master, Financial Year
 * format, Month is a real month, numeric fields are numeric. Quarter is
 * deliberately NOT validated as input — it's never accepted from the
 * caller, only derived.
 */
async function validateSalesInput(body) {
  const errors = [];
  const matNo = String(body.MatNo || "").trim().toUpperCase();

  if (!matNo) errors.push("Material Number is required.");
  else {
    const exists = await Material.exists({ materialNo: matNo, isActive: true });
    if (!exists) errors.push(`Material Number "${matNo}" does not exist in Material Master.`);
  }

  if (!String(body.Material || "").trim()) errors.push("Material Name is required.");
  if (!String(body.Plant || "").trim()) errors.push("Plant is required.");

  if (!isValidFinancialYear(body.FinancialYear)) errors.push('Financial Year must be in "YYYY-YY" format, e.g. "2025-26".');

  const month = String(body.Month || "").trim();
  if (!month) errors.push("Month is required.");
  else if (!isValidMonth(month)) errors.push(`"${month}" is not a recognized month name.`);

  ["SalesEA", "SalesQty", "SalesCV", "NetSales"].forEach((field) => {
    if (body[field] !== undefined && body[field] !== "" && Number.isNaN(Number(body[field]))) {
      errors.push(`${field} must be numeric.`);
    }
  });

  return errors;
}

/** Builds a clean Sales document payload, auto-deriving Quarter and Period — neither is ever accepted as input. */
function buildSalesPayload(body) {
  const payload = {};
  USER_EDITABLE_KEYS.forEach((key) => {
    const col = SALES_COLUMNS.find((c) => c.key === key);
    const raw = body[key];
    if (col.type === "Number") payload[key] = raw === undefined || raw === "" ? 0 : Number(raw);
    else payload[key] = raw === undefined || raw === null ? "" : String(raw).trim();
  });
  payload.MatNo = payload.MatNo.toUpperCase();
  payload.Quarter = deriveQuarter(payload.Month);
  payload.Period = derivePeriod(payload.FinancialYear, payload.Month);
  return payload;
}

/** POST /api/sales — Admin only. Manually add one Sales record. */
async function createSales(req, res) {
  try {
    const body = req.body || {};
    const errors = await validateSalesInput(body);
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const sales = await Sales.create(buildSalesPayload(body));
    res.status(201).json({ sales });
  } catch (err) {
    console.error("[salesController.createSales]", err);
    res.status(500).json({ message: "Internal server error while creating the sales record." });
  }
}

/** GET /api/sales/export — the full operational Sales Master dataset as a real .xlsx file, exactly 19 columns. */
async function exportSales(req, res) {
  try {
    const { search } = req.query;
    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ MatNo: rx }, { Material: rx }, { Plant: rx }];
    }
    Object.assign(query, buildMongoFilter(req.query, SALES_FILTER_CONFIG));

    const records = await Sales.find(query).sort({ FinancialYear: -1, Quarter: 1, Month: 1, Plant: 1 }).lean();
    const buffer = buildXlsxBuffer(SALES_COLUMNS, records);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="sales_master.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("[salesController.exportSales]", err);
    res.status(500).json({ message: "Internal server error while exporting sales records." });
  }
}

module.exports = {
  listSales,
  getSalesFilterValues,
  getSalesSummary,
  getSalesMonthlyBreakdown,
  createSales,
  exportSales,
  buildSalesPayload,
  validateSalesInput,
};
