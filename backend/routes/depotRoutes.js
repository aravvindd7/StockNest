const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const { listDepots, getDepotFilterValues, getDepotById, createDepot, updateDepot, deleteDepot, exportDepots } = require("../controllers/depotController");
const { importDepots, getImportHistory, viewImportHistory, removeImportHistory } = require("../controllers/depotImportController");

const router = express.Router();

// Every route here is Admin-only, same pattern as materialRoutes.js —
// requireAuth confirms the JWT, requireRole("ADMIN") enforces the role.
// The backend enforces this independently of the frontend sidebar/UI.
router.use(requireAuth, requireRole("ADMIN"));

// ---- Import history (fixed paths before ":id") ----
router.get("/import-history", getImportHistory);
router.post("/import-history/:id/view", viewImportHistory);
router.delete("/import-history/:id", removeImportHistory);

// ---- Bulk import: Append or Replace, processed directly after upload ----
router.post("/import", upload.single("file"), importDepots);

// ---- Export (fixed path before ":id") ----
router.get("/export", exportDepots);
router.get("/filter-values", getDepotFilterValues);

// ---- Core CRUD ----
router.get("/", listDepots);
router.post("/", createDepot);
router.get("/:id", getDepotById);
router.put("/:id", updateDepot);
router.delete("/:id", deleteDepot);

module.exports = router;
