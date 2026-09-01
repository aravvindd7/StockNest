const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");

const {
  listMaterials,
  getMaterialFilterOptions,
  getMaterialFilterValues,
  getMaterialById,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  exportMaterials,
} = require("../controllers/materialController");

const {
  importMaterials,
  getImportHistory,
  viewImportHistory,
  removeImportHistory,
} = require("../controllers/materialImportController");

const router = express.Router();

// Every route here is Admin-only per Section 5's authorization flow —
// requireAuth confirms the JWT, requireRole("ADMIN") enforces the role.
router.use(requireAuth, requireRole("ADMIN"));

// ---- Import history (fixed paths before the ":id" routes below) ----
router.get("/import-history", getImportHistory);
router.post("/import-history/:id/view", viewImportHistory); // restore as active
router.delete("/import-history/:id", removeImportHistory);

// ---- Bulk import: single request, processed directly after upload.
// Body must include 'mode' (APPEND or REPLACE) alongside the file. No
// column-mapping/preview step — the file must have the exact required
// headers (Material No, Description, Model, STD/Discontinued, Inv Cost,
// MOQ, FG/RM); rows are validated and imported in one round trip.
router.post("/import", upload.single("file"), importMaterials);

// ---- Filters + export (fixed paths before ":id") ----
router.get("/filters", getMaterialFilterOptions);
router.get("/filter-values", getMaterialFilterValues);
router.get("/export", exportMaterials);

// ---- Core CRUD ----
router.get("/", listMaterials);
router.post("/", createMaterial);
router.get("/:id", getMaterialById);
router.put("/:id", updateMaterial);
router.delete("/:id", deleteMaterial);

module.exports = router;
