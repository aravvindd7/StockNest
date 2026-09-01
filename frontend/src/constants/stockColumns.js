/**
 * Mirrors backend/models/Stock.js's STOCK_COLUMNS exactly — same 43 keys,
 * same order, same type. Kept as a separate frontend copy (rather than
 * importing across the frontend/backend boundary, which isn't possible in
 * a Vite app) so the table and Add Stock form always render in the exact
 * spec-mandated column order. If the backend list ever changes, update
 * this file to match.
 */
export const STOCK_COLUMNS = [
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

/** The four fields Append import matching is based on (Section 9) — required on the Add Stock form. */
export const STOCK_REQUIRED_KEYS = ["PlantName", "MatNo", "StockDate", "StorageLocation"];
