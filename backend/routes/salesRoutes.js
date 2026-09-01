const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const { listSales, getSalesFilterValues, getSalesSummary, getSalesMonthlyBreakdown, createSales, exportSales } = require("../controllers/salesController");
const { importSales, getImportHistory, viewImportHistory, removeImportHistory } = require("../controllers/salesImportController");

const router = express.Router();

// Every route here is Admin-only, same pattern as materialRoutes.js/depotRoutes.js/stockRoutes.js.
router.use(requireAuth, requireRole("ADMIN"));

// ---- Import history (fixed paths before ":id") ----
router.get("/import-history", getImportHistory);
router.post("/import-history/:id/view", viewImportHistory);
router.delete("/import-history/:id", removeImportHistory);

// ---- Bulk import: Append or Replace, processed directly after upload ----
router.post("/import", upload.single("file"), importSales);

// ---- Export (fixed path) ----
router.get("/export", exportSales);
router.get("/filter-values", getSalesFilterValues);

// ---- Aggregated views for the Sales Master main table (Phase 1) ----
router.get("/summary", getSalesSummary);
router.get("/monthly", getSalesMonthlyBreakdown);

// ---- Core ----
router.get("/", listSales);
router.post("/", createSales);

module.exports = router;
