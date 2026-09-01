const mongoose = require("mongoose");

/**
 * Sales Master — CORRECTION PASS after the Phase 1 monthly upgrade went
 * too far and dropped operational ERP fields entirely. This restores
 * them, while KEEPING the useful parts of Phase 1: Month, Financial Year,
 * and auto-derived Quarter (all still never manually entered).
 *
 * Sales Master's purpose is "what happened" (detailed historical
 * records) — distinct from Planning Master's "what should we do"
 * (forecast/decision support). This schema is deliberately a full
 * operational ERP record shape again, not a slimmed-down analytics shape.
 *
 * Two fields are auto-derived and NEVER accepted as user/import input:
 *   - Quarter, from Month (via utils/financialYear.js's deriveQuarter)
 *   - Period, from Financial Year + Month (via derivePeriod) — a display/
 *     reference convenience, same non-manual-entry principle as Quarter
 * QtrWk (week-within-quarter) has no underlying week-level data source
 * in this schema, so it's preserved as an optional free-text field, same
 * as before the monthly upgrade — not auto-derived, just carried through
 * if a source system supplies it.
 */
const SALES_COLUMNS = [
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
  { key: "Quarter", label: "Quarter", type: "String" }, // derived from Month, never entered
  { key: "Period", label: "Period", type: "String" }, // derived from FinancialYear+Month, never entered
  { key: "QtrWk", label: "QtrWk", type: "String" }, // optional, no week-level source data
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

if (SALES_COLUMNS.length !== 19) {
  throw new Error(`SALES_COLUMNS must have exactly 19 entries, found ${SALES_COLUMNS.length}.`);
}

/**
 * Duplicate-prevention key for Append imports: Material Number + Plant +
 * Financial Year + Month. Isolated here (via utils/salesMatcher.js, which
 * reads this) so the rule can change in one place if the business
 * definition of "the same record" changes later.
 */
const MATCH_FIELDS = ["MatNo", "Plant", "FinancialYear", "Month"];

// Columns an admin can type into the Add Sales form / an Excel import can
// supply. Quarter and Period are excluded — both computed, never input.
const USER_EDITABLE_KEYS = SALES_COLUMNS.filter((c) => !["Quarter", "Period"].includes(c.key)).map((c) => c.key);

const schemaShape = {};
SALES_COLUMNS.forEach(({ key, type }) => {
  if (type === "Number") schemaShape[key] = { type: Number, default: 0 };
  else schemaShape[key] = { type: String, trim: true, default: "" };
});

const salesSchema = new mongoose.Schema(schemaShape, { timestamps: true });

// Matching-key compound index covers both the Append duplicate-detection
// lookup and the most common filter combination.
salesSchema.index({ MatNo: 1, Plant: 1, FinancialYear: 1, Month: 1 });
// Quarter-level lookups are exactly what Planning Service and the Sales
// Master Quarterly Summary view do on every request.
salesSchema.index({ MatNo: 1, FinancialYear: 1, Quarter: 1 });
salesSchema.index({ SalesQty: 1 });

module.exports = mongoose.model("Sales", salesSchema);
module.exports.SALES_COLUMNS = SALES_COLUMNS;
module.exports.MATCH_FIELDS = MATCH_FIELDS;
module.exports.USER_EDITABLE_KEYS = USER_EDITABLE_KEYS;
