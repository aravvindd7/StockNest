const Stock = require("../models/Stock");
const { STOCK_COLUMNS } = require("../models/Stock");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { buildMongoFilter, buildSort, getDistinctValues } = require("../utils/queryFilterBuilder");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOCK_SORTABLE_FIELDS = ["MatNo", "Material", "PlantName", "StockDate", "TotalStockQty", "StorageLocation"];

// Every visible Stock Master column is filterable ("Filtering Philosophy:
// if a user can see a column, they can filter it") — derived programmatically
// from STOCK_COLUMNS rather than hand-listing all 43 fields, so this can
// never drift out of sync with the table/model. Date-type columns
// (StockDate, createdOn) are excluded: the spec's Filter Types section only
// defines Text/Dropdown/Numeric behavior, no Date filter. "Depot" in the
// upgrade spec maps to Stock's own PlantName field, the closest existing
// concept — Stock Master has no separate Depot reference.
const STOCK_FILTER_CONFIG = STOCK_COLUMNS.filter((c) => c.type !== "Date").map((c) => ({
  dbField: c.key,
  type: c.type === "Number" ? "number" : "text",
}));

/**
 * GET /api/stock — Admin only. Optional free-text `search` across
 * PlantName/MatNo/Material, plus pagination. Also supports the global
 * column-filter system across every non-Date column (see STOCK_FILTER_CONFIG).
 * Safety Stock and Stock Status (Low/Over/Available) aren't implemented —
 * Safety Stock is a Planning-only computed heuristic (not a Stock Master
 * field), and the spec itself marks Stock Status as "future compatibility."
 */
async function listStock(req, res) {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ PlantName: rx }, { MatNo: rx }, { Material: rx }];
    }
    Object.assign(query, buildMongoFilter(req.query, STOCK_FILTER_CONFIG));

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const sort = req.query.sortBy ? buildSort(req.query, STOCK_SORTABLE_FIELDS, "StockDate") : { StockDate: -1, PlantName: 1 };

    const [data, total] = await Promise.all([
      Stock.find(query).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum),
      Stock.countDocuments(query),
    ]);

    res.json({
      data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("[stockController.listStock]", err);
    res.status(500).json({ message: "Internal server error while fetching stock records." });
  }
}

const STOCK_FILTERABLE_FIELDS = new Set(STOCK_FILTER_CONFIG.filter((f) => f.type === "text").map((f) => f.dbField));
/** GET /api/stock/filter-values?field=MatNo&search= — live options for a column filter popup. */
async function getStockFilterValues(req, res) {
  try {
    const { field, search } = req.query;
    if (!STOCK_FILTERABLE_FIELDS.has(field)) {
      return res.status(400).json({ message: `Field "${field}" is not filterable.` });
    }
    const values = await getDistinctValues(Stock, field, search);
    res.json({ values });
  } catch (err) {
    console.error("[stockController.getStockFilterValues]", err);
    res.status(500).json({ message: "Internal server error while fetching filter values." });
  }
}

/** Required: the four fields used for matching (Section 9); everything else is optional. */
function validateStockInput(body) {
  const errors = [];
  if (!String(body.PlantName || "").trim()) errors.push("PlantName is required.");
  if (!String(body.MatNo || "").trim()) errors.push("MatNo is required.");
  if (!body.StockDate) errors.push("StockDate is required.");
  if (!String(body.StorageLocation || "").trim()) errors.push("StorageLocation is required.");
  return errors;
}

/** Builds a clean Stock document payload from request body, defaulting missing optional fields. */
function buildStockPayload(body) {
  const payload = {};
  STOCK_COLUMNS.forEach(({ key, type }) => {
    const raw = body[key];
    if (type === "Number") payload[key] = raw === undefined || raw === "" ? 0 : Number(raw);
    else if (type === "Date") payload[key] = raw ? new Date(raw) : undefined;
    else payload[key] = raw === undefined || raw === null ? "" : String(raw);
  });
  return payload;
}

/** POST /api/stock — Admin only. Manually add one Stock record (Section 7). */
async function createStock(req, res) {
  try {
    const body = req.body || {};
    const errors = validateStockInput(body);
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const stock = await Stock.create(buildStockPayload(body));
    res.status(201).json({ stock });
  } catch (err) {
    console.error("[stockController.createStock]", err);
    res.status(500).json({ message: "Internal server error while creating the stock record." });
  }
}

/** GET /api/stock/export — the active Stock Master dataset as a real .xlsx file, exactly 43 columns. */
async function exportStock(req, res) {
  try {
    const { search } = req.query;
    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ PlantName: rx }, { MatNo: rx }, { Material: rx }];
    }
    Object.assign(query, buildMongoFilter(req.query, STOCK_FILTER_CONFIG));

    const records = await Stock.find(query).sort({ StockDate: -1, PlantName: 1 }).lean();
    const buffer = buildXlsxBuffer(STOCK_COLUMNS, records);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="stock_master.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("[stockController.exportStock]", err);
    res.status(500).json({ message: "Internal server error while exporting stock records." });
  }
}

module.exports = { listStock, getStockFilterValues, createStock, exportStock, buildStockPayload, validateStockInput };
