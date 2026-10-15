const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const pipeline = require("../services/derivedDataPipeline");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

/**
 * GET /api/derived-status — Admin only. Freshness of the automatically
 * maintained forecast and recommendations: per-stage version, last successful
 * update and a simple status (current | updating | failed), plus the source
 * versions. Cheap (a few small documents) so pages can check it periodically
 * and refresh only when something actually changed.
 */
router.get("/", async (_req, res) => {
  try {
    res.json(await pipeline.getStatus());
  } catch (err) {
    console.error("[derivedRoutes.status]", err);
    res.status(500).json({ message: "Could not read the update status." });
  }
});

module.exports = router;
