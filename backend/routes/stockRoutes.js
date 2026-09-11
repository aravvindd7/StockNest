const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const { listStock, getStockFilterValues, createStock, exportStock, resyncStockStatuses } = require("../controllers/stockController");
const { importStock, getImportHistory, viewImportHistory, removeImportHistory } = require("../controllers/stockImportController");

const router = express.Router();

// Every route here is Admin-only, same pattern as materialRoutes.js/depotRoutes.js.
router.use(requireAuth, requireRole("ADMIN"));

// ---- On-demand Material → Stock status backfill (admin action) ----
router.post("/resync-status", resyncStockStatuses);

// ---- Import history (fixed paths before ":id") ----
router.get("/import-history", getImportHistory);
router.post("/import-history/:id/view", viewImportHistory);
router.delete("/import-history/:id", removeImportHistory);

// ---- Bulk import: Append or Replace, processed directly after upload ----
router.post("/import", upload.single("file"), importStock);

// ---- Export (fixed path) ----
router.get("/export", exportStock);
router.get("/filter-values", getStockFilterValues);

// ---- Core ----
router.get("/", listStock);
router.post("/", createStock);

module.exports = router;
