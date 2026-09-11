const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const {
  getPlanningData,
  getAvailableStartYears,
  saveReplenishmentPlan,
  loadReplenishmentPlan,
  resetReplenishmentPlan,
  applyToAllReplenishmentPlan,
} = require("../controllers/planningController");

const router = express.Router();

// Admin-only, same pattern as every other master module. Planning Master
// computes its view read-only — the single exception is the planner's
// Monthly Replenishment Allocation, which persists an explicit user choice
// (see ReplenishmentPlan model).
router.use(requireAuth, requireRole("ADMIN"));

// Fixed paths BEFORE the root GET so "/replenishment" is never shadowed.
router.get("/replenishment", loadReplenishmentPlan);
router.post("/replenishment", saveReplenishmentPlan);
router.post("/replenishment/reset", resetReplenishmentPlan);
router.post("/replenishment/apply-to-all", applyToAllReplenishmentPlan);

router.get("/years", getAvailableStartYears);
router.get("/", getPlanningData);

module.exports = router;
