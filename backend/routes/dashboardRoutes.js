const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { getSummary } = require("../controllers/dashboardController");

const router = express.Router();

// Both ADMIN and USER can view dashboard KPIs; content is tailored inside the controller.
router.get("/summary", requireAuth, getSummary);

module.exports = router;
