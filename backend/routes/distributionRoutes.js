const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  listRecommendations,
  getPendingRecommendationSummary,
  getRecommendationById,
  listTransfers,
  getTransferById,
  getDepotDemand,
  listDepotSafetyStock,
  refreshDepotSafetyStock,
  getForecastEvaluation,
  generateRecommendations,
} = require("../controllers/distributionController");
const {
  listMappings,
  getMappingById,
  createMapping,
  updateMapping,
  importMappings,
  getImportHistory,
  viewImportHistory,
} = require("../controllers/depotPlantMappingController");
const {
  approveRecommendation,
  rejectRecommendation,
  approveRecommendationsBulk,
  createTransfer,
  approveTransfer,
  dispatchTransfer,
  markInTransit,
  receiveTransfer,
  cancelTransfer,
  listTransferMovements,
} = require("../controllers/distributionTransferController");
const { requireTransactions } = require("../utils/transactions");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { recordsSourceChange } = require("../middleware/sourceChange");

// Source-data events (one per successful operation) → automatic forecast /
// recommendation updates. Recommendation review (approve/reject/bulk) and
// transfer approval raise none: they act on the current run, and a run must
// never trigger itself.
const stockChanged = recordsSourceChange("stock"); // dispatch / receipt move physical stock
const commitmentsChanged = recordsSourceChange("transfers"); // open commitments created / released
const mappingChanged = recordsSourceChange("depotPlantMapping");
const safetyStockChanged = recordsSourceChange("depotSafetyStock");

const router = express.Router();

// Admin-only, same pattern as every other master module — requireAuth
// confirms the JWT, requireRole("ADMIN") enforces the role.
router.use(requireAuth, requireRole("ADMIN"));

// ---- Recommendations & transfers (Stage 1 read-only; Stage 3 adds generation) ----
router.post("/recommendations/generate", generateRecommendations);
router.get("/recommendations", listRecommendations);
router.get("/recommendations/pending-summary", getPendingRecommendationSummary);
router.get("/recommendations/:id", getRecommendationById);
router.get("/transfers", listTransfers);
router.get("/transfers/:id/movements", listTransferMovements);
router.get("/transfers/:id", getTransferById);

// ---- Stage 4: review & transfer lifecycle — transactional (503 without
// transactions) and idempotent (Idempotency-Key header required) ----
const stage4Write = [requireTransactions, requireIdempotencyKey];
router.post("/recommendations/:id/approve", stage4Write, approveRecommendation);
router.post("/recommendations/:id/reject", stage4Write, rejectRecommendation);
router.post("/recommendations/approve-bulk", stage4Write, approveRecommendationsBulk);
router.post("/transfers", stage4Write, commitmentsChanged, createTransfer);
router.post("/transfers/:id/approve", stage4Write, approveTransfer);
router.post("/transfers/:id/dispatch", stage4Write, stockChanged, dispatchTransfer);
router.post("/transfers/:id/in-transit", stage4Write, markInTransit);
router.post("/transfers/:id/receive", stage4Write, stockChanged, receiveTransfer);
router.post("/transfers/:id/cancel", stage4Write, commitmentsChanged, cancelTransfer);

// ---- Depot ↔ Plant mapping (Stage 2) — fixed paths before ":id" ----
router.get("/plant-mappings/import-history", getImportHistory);
router.post("/plant-mappings/import-history/:id/view", mappingChanged, viewImportHistory);
router.post("/plant-mappings/import", upload.single("file"), mappingChanged, importMappings);
router.get("/plant-mappings", listMappings);
router.post("/plant-mappings", mappingChanged, createMapping);
router.get("/plant-mappings/:id", getMappingById);
router.put("/plant-mappings/:id", mappingChanged, updateMapping);

// ---- Depot demand, safety stock, forecast evaluation (Stage 2) ----
router.get("/demand", getDepotDemand);
router.get("/safety-stock", listDepotSafetyStock);
router.post("/safety-stock/refresh", safetyStockChanged, refreshDepotSafetyStock);
router.get("/forecast-evaluation", getForecastEvaluation);

module.exports = router;
