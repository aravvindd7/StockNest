const Stock = require("../models/Stock");
const { STOCK_COLUMNS } = require("../models/Stock");
const Material = require("../models/Material");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { buildMongoFilter, buildSort, getDistinctValues } = require("../utils/queryFilterBuilder");
const {
  STOCK_STATUS_DISCONTINUED,
  deriveStockStatus,
  syncStockStatusesFromMaterials,
} = require("../utils/stockStatusSync");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Material numbers that are soft-deactivated (isActive: false) OR marked
 * Discontinued in Material Master. Stock Master's Status field is kept in
 * sync with this (see utils/stockStatusSync.js), so the default hide can
 * filter on Status directly; this cross-reference is kept as a belt-and-
 * suspenders safety net for any not-yet-migrated row. Material numbers are
 * normalized (trim + uppercase) so Stock's MatNo matches Material's
 * materialNo.
 */
async function getInactiveMaterialNos() {
  const materials = await Material.find({ $or: [{ isActive: false }, { status: "Discontinued" }] })
    .select("materialNo")
    .lean();
  return materials.map((m) => String(m.materialNo || "").trim().toUpperCase()).filter(Boolean);
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

    // Hide discontinued stock by default (only Active/Discontinued are valid
    // visible statuses after sync); the showInactive=true override restores
    // the full historical view. Status is the primary signal, with the
    // Material cross-reference as a safety net for not-yet-migrated rows.
    const showInactive = req.query.showInactive === "true";
    if (!showInactive) {
      query.Status = { $ne: STOCK_STATUS_DISCONTINUED };
      const inactiveNos = await getInactiveMaterialNos();
      if (inactiveNos.length > 0) query.MatNo = { $nin: inactiveNos };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const sort = req.query.sortBy ? buildSort(req.query, STOCK_SORTABLE_FIELDS, "StockDate") : { StockDate: -1, PlantName: 1 };

    const [data, total] = await Promise.all([
      Stock.find(query).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum),
      Stock.countDocuments(query),
    ]);

    res.json({
      data,
      showInactive,
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

    const payload = buildStockPayload(body);
    // Status is always derived from Material Master when the material exists —
    // any incoming Status value is ignored. STD → Active; Discontinued or
    // inactive → Discontinued. Unknown materials keep whatever Status was
    // supplied (nothing to derive from, never fabricated).
    const matNo = String(body.MatNo || "").trim().toUpperCase();
    const material = matNo ? await Material.findOne({ materialNo: matNo }).select("status isActive").lean() : null;
    if (material) payload.Status = deriveStockStatus(material);

    const stock = await Stock.create(payload);
    res.status(201).json({ stock });
  } catch (err) {
    console.error("[stockController.createStock]", err);
    res.status(500).json({ message: "Internal server error while creating the stock record." });
  }
}

/**
 * POST /api/stock/resync-status — Admin only. On-demand re-run of the
 * Material Master → Stock Master status backfill (also run at startup). Safe
 * and idempotent: only the Status field changes; quantities and all other
 * columns are untouched.
 */
async function resyncStockStatuses(_req, res) {
  try {
    const result = await syncStockStatusesFromMaterials();
    res.json({ message: "Stock Master statuses synchronized from Material Master.", ...result });
  } catch (err) {
    console.error("[stockController.resyncStockStatuses]", err);
    res.status(500).json({ message: "Internal server error while resynchronizing stock statuses." });
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

    // Same discontinued-material exclusion as listStock, so the export matches
    // exactly what the table shows (showInactive=true → full historical set).
    const showInactive = req.query.showInactive === "true";
    if (!showInactive) {
      query.Status = { $ne: STOCK_STATUS_DISCONTINUED };
      const inactiveNos = await getInactiveMaterialNos();
      if (inactiveNos.length > 0) query.MatNo = { $nin: inactiveNos };
    }

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

module.exports = {
  listStock,
  getStockFilterValues,
  createStock,
  exportStock,
  resyncStockStatuses,
  buildStockPayload,
  validateStockInput,
};
