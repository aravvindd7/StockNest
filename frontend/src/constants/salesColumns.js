/**
 * Mirrors backend/models/Sales.js's SALES_COLUMNS exactly — same 19 keys,
 * same order, same type. See constants/stockColumns.js for why this is a
 * separate frontend copy rather than a cross-boundary import.
 *
 * Sales Master's schema: full operational ERP fields (Identification/
 * Location/Product/Sales Values) PLUS the monthly-forecasting-prep
 * additions (Financial Year, Month, auto-derived Quarter and Period).
 * Quarter and Period are included here for display/export, but are NEVER
 * form inputs — see SALES_FORM_KEYS below.
 */
export const SALES_COLUMNS = [
  // Identification
  { key: "MatNo", label: "Material Number", type: "String" },
  { key: "Material", label: "Material Description", type: "String" },
  { key: "Page", label: "Page", type: "String" },
  { key: "MatGroupCode", label: "Material Group Code", type: "String" },
  { key: "MatGroupName", label: "Material Group Name", type: "String" },
  { key: "MatSubGroup", label: "Material Sub Group", type: "String" },
  // Location
  { key: "Plant", label: "Plant", type: "String" },
  // Time
  { key: "FinancialYear", label: "Financial Year", type: "String" },
  { key: "Month", label: "Month", type: "String" },
  { key: "Quarter", label: "Quarter", type: "String" }, // derived from Month
  { key: "Period", label: "Period", type: "String" }, // derived from FinancialYear+Month
  { key: "QtrWk", label: "QtrWk", type: "String" },
  // Product / business
  { key: "ProductionCycle", label: "Production Cycle", type: "String" },
  { key: "Status", label: "Status", type: "String" },
  { key: "Merged", label: "Merged", type: "String" },
  // Sales values
  { key: "SalesEA", label: "Sales EA", type: "Number" },
  { key: "SalesQty", label: "Sales Quantity", type: "Number" },
  { key: "SalesCV", label: "Sales CV", type: "Number" },
  { key: "NetSales", label: "Net Sales", type: "Number" },
];

/** Fields shown on the Add Sales form / expected in an Excel import — everything except Quarter and Period (both server-derived). */
export const SALES_FORM_KEYS = SALES_COLUMNS.filter((c) => !["Quarter", "Period"].includes(c.key)).map((c) => c.key);

/** The matching-key fields (Material + Plant + Financial Year + Month) — required on the Add Sales form. */
export const SALES_REQUIRED_KEYS = ["MatNo", "Material", "Plant", "FinancialYear", "Month"];

export const MONTHS_BY_QUARTER = {
  Q1: ["April", "May", "June"],
  Q2: ["July", "August", "September"],
  Q3: ["October", "November", "December"],
  Q4: ["January", "February", "March"],
};
export const ALL_MONTHS = Object.values(MONTHS_BY_QUARTER).flat();
export const QUARTERS = Object.keys(MONTHS_BY_QUARTER);
