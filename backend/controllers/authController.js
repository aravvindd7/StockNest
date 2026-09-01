const jwt = require("jsonwebtoken");
const User = require("../models/User");

function signToken(user) {
  const payload = {
    userId: user._id.toString(),
    username: user.username,
    role: user.role,
  };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  });
}

/**
 * POST /api/auth/login
 * Body: { identifier, password }  — identifier is username OR email.
 * The role is never taken from the request; it is read from the
 * matched user document in the database.
 */
async function login(req, res) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: "Username/email and password are required." });
    }

    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase().trim() }, { username: identifier.trim() }],
    }).select("+passwordHash");

    // Same generic message whether the user doesn't exist or the password
    // is wrong, so login attempts can't be used to enumerate valid accounts.
    const invalidMsg = "Invalid credentials.";

    if (!user || !user.isActive) {
      return res.status(401).json({ message: invalidMsg });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: invalidMsg });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        userId: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("[authController.login]", err);
    res.status(500).json({ message: "Internal server error during login." });
  }
}

/**
 * GET /api/auth/me
 * Protected — requires a valid JWT. Returns the current user's profile,
 * re-fetched from the database (not just decoded from the token) so
 * role/active-status changes take effect immediately.
 */
async function me(req, res) {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Unauthorized: account not found or deactivated." });
    }
    res.json({ user });
  } catch (err) {
    console.error("[authController.me]", err);
    res.status(500).json({ message: "Internal server error." });
  }
}

/**
 * POST /api/auth/logout
 * JWTs are stateless, so "logout" is primarily a client-side action
 * (discard the token). This endpoint exists for a consistent API and
 * as the place to add token-blacklisting later if needed.
 */
async function logout(_req, res) {
  res.json({ message: "Logged out. Discard the token on the client." });
}

module.exports = { login, me, logout };
