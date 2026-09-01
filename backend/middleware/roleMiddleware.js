/**
 * Restricts a route to one or more roles. Must run AFTER requireAuth,
 * since it reads req.user.role set by the JWT middleware.
 *
 * Usage: router.delete("/materials/:id", requireAuth, requireRole("ADMIN"), handler);
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized: no authenticated user on request." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Forbidden: you do not have permission to perform this action.",
      });
    }

    next();
  };
}

module.exports = { requireRole };
