const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const { getStatus, runBacktest, generateForecast } = require("../controllers/forecastController");

const router = express.Router();

// Admin-only, same pattern as every other module — this is new
// infrastructure (Phase 4), not a change to any existing module's routes.
router.use(requireAuth, requireRole("ADMIN"));

router.get("/status", getStatus);
router.post("/backtest", runBacktest);
router.post("/generate", generateForecast);

module.exports = router;
