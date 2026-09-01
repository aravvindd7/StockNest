const mongoose = require("mongoose");

/**
 * The 43 Stock Master fields, in the exact order specified. This single
 * source of truth drives the Mongoose schema, the Excel import/export
 * column order, and (mirrored) the frontend table/form — keep this list
 * as the one place to add/reorder a column if that's ever needed.
 *
 * Type choices: Date for the two clearly-date fields (StockDate,
 * createdOn); Number for fields that are unambiguously quantities/values
 * (stock counts, CV figures, StockVal, Year); String for everything else,
 * including flag-like fields (Active, Consignment, Defect, CasePlanningYN,
 * etc.) since the real-world Excel data for those could be "Y"/"N",
 * "Active"/"Inactive", or similar — String is the safe, flexible choice
 * per the spec's "do not make the schema unnecessarily rigid" guidance.
 */
const STOCK_COLUMNS = [
  { key: "PlantGroup", label: "PlantGroup", type: "String" },
  { key: "PlantSort", label: "PlantSort", type: "String" },
  { key: "PlantName", label: "PlantName", type: "String" },
  { key: "MatNo", label: "MatNo", type: "String" },
  { key: "Material", label: "Material", type: "String" },
  { key: "MatSubGroup", label: "MatSubGroup", type: "String" },
  { key: "MaterialGroup", label: "MaterialGroup", type: "String" },
  { key: "Division", label: "Division", type: "String" },
  { key: "StockDate", label: "StockDate", type: "Date" },
  { key: "MatShortName", label: "MatShortName", type: "String" },
  { key: "MatUnit", label: "MatUnit", type: "String" },
  { key: "UnitCase", label: "UnitCase", type: "String" },
  { key: "Page", label: "Page", type: "String" },
  { key: "MatGroupUnit", label: "MatGroupUnit", type: "String" },
  { key: "MatOrder", label: "MatOrder", type: "String" },
  { key: "fcast_Active", label: "fcast_Active", type: "String" },
  { key: "trendMatSubGroup", label: "trendMatSubGroup", type: "String" },
  { key: "Active", label: "Active", type: "String" },
  { key: "Consignment", label: "Consignment", type: "String" },
  { key: "ConsTran", label: "ConsTran", type: "String" },
  { key: "Defect", label: "Defect", type: "String" },
  { key: "NonDefect", label: "NonDefect", type: "String" },
  { key: "TotalStock", label: "TotalStock", type: "Number" },
  { key: "SIT", label: "SIT", type: "Number" },
  { key: "SIH", label: "SIH", type: "Number" },
  { key: "TotalStockQty", label: "TotalStockQty", type: "Number" },
  { key: "SITQTY", label: "SITQTY", type: "Number" },
  { key: "SIHQty", label: "SIHQty", type: "Number" },
  { key: "TotalStockCV", label: "TotalStockCV", type: "Number" },
  { key: "SIHCV", label: "SIHCV", type: "Number" },
  { key: "SITCV", label: "SITCV", type: "Number" },
  { key: "Period", label: "Period", type: "String" },
  { key: "CasePlanningYN", label: "CasePlanningYN", type: "String" },
  { key: "MatGroup", label: "MatGroup", type: "String" },
  { key: "createdOn", label: "createdOn", type: "Date" },
  { key: "StockVal", label: "StockVal", type: "Number" },
  { key: "StorageLocation", label: "StorageLocation", type: "String" },
  { key: "Qtr", label: "Qtr", type: "String" },
  { key: "PC", label: "PC", type: "String" },
  { key: "Year", label: "Year", type: "Number" },
  { key: "RegionName", label: "RegionName", type: "String" },
  { key: "Merged", label: "Merged", type: "String" },
  { key: "Status", label: "Status", type: "String" },
];

// Sanity check at module-load time — this schema only makes sense with
// exactly 43 columns; fail loudly rather than silently importing wrong data.
if (STOCK_COLUMNS.length !== 43) {
  throw new Error(`STOCK_COLUMNS must have exactly 43 entries, found ${STOCK_COLUMNS.length}.`);
}

/** The four fields used to decide whether an imported row matches an existing Stock record (Section 9). */
const MATCH_FIELDS = ["PlantName", "MatNo", "StockDate", "StorageLocation"];

const schemaShape = {};
STOCK_COLUMNS.forEach(({ key, type }) => {
  if (type === "Number") schemaShape[key] = { type: Number, default: 0 };
  else if (type === "Date") schemaShape[key] = { type: Date };
  else schemaShape[key] = { type: String, trim: true, default: "" };
});

const stockSchema = new mongoose.Schema(schemaShape, { timestamps: true });

// Non-unique — matching/dedup is handled at the application level
// (utils/stockMatcher.js), not enforced as a DB constraint, since the
// business rule for "same record" may evolve (Section 9's explicit ask
// to keep this isolated and easy to change).
stockSchema.index({ PlantName: 1, MatNo: 1, StockDate: 1, StorageLocation: 1 });
// Every Stock column is now filterable (Global ERP Filtering System); the
// compound index above covers Material/Depot/Date-style queries via
// prefix matching. TotalStockQty ("Current Stock") gets its own index
// since numeric range filters can't benefit from that compound index's
// prefix — this is the one Stock filter most likely to run against a
// large, otherwise-unfiltered dataset (e.g. "find all low-stock items").
stockSchema.index({ TotalStockQty: 1 });

module.exports = mongoose.model("Stock", stockSchema);
module.exports.STOCK_COLUMNS = STOCK_COLUMNS;
module.exports.MATCH_FIELDS = MATCH_FIELDS;
