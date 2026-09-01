const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { listInventory, getFilterOptions, getInventoryById } = require("../controllers/inventoryController");

const router = express.Router();

// Read-only inventory access — both ADMIN and USER, per Section 4 of the spec.
// No requireRole() here: authentication alone is sufficient.
router.get("/filters", requireAuth, getFilterOptions);
router.get("/:id", requireAuth, getInventoryById);
router.get("/", requireAuth, listInventory);

module.exports = router;
