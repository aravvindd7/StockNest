const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const { getPlanningData, getAvailableStartYears } = require("../controllers/planningController");

const router = express.Router();

// Admin-only, same pattern as every other master module. Planning Master
// is deliberately read-only — no POST/PUT/DELETE here at all, since it
// never owns data (see planningController.js's top comment).
router.use(requireAuth, requireRole("ADMIN"));

router.get("/years", getAvailableStartYears);
router.get("/", getPlanningData);

module.exports = router;
