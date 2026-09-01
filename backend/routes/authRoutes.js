const express = require("express");
const { login, me, logout } = require("../controllers/authController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// Public
router.post("/login", login);

// Authenticated
router.get("/me", requireAuth, me);
router.post("/logout", requireAuth, logout);

module.exports = router;
