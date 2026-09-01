const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Verifies the JWT sent in the Authorization header ("Bearer <token>").
 * On success, attaches the authenticated user's { userId, username, role }
 * to req.user and calls next(). This is the gate every protected route
 * must pass through before role checks or business logic run.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ message: "Unauthorized: missing or malformed token." });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const message =
        err.name === "TokenExpiredError"
          ? "Unauthorized: session expired, please log in again."
          : "Unauthorized: invalid token.";
      return res.status(401).json({ message });
    }

    // Re-check the user still exists and is active on every request.
    // A valid-looking token for a deactivated/deleted account must not work.
    const user = await User.findById(payload.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Unauthorized: account not found or deactivated." });
    }

    req.user = { userId: user._id.toString(), username: user.username, role: user.role };
    next();
  } catch (err) {
    console.error("[authMiddleware] Unexpected error:", err);
    res.status(500).json({ message: "Internal server error during authentication." });
  }
}

module.exports = { requireAuth };
