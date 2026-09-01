import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Frontend-side gate for role-restricted pages (e.g. Material Master).
 * This is a UX convenience only — the real enforcement lives in the
 * backend's requireRole middleware. Even if someone bypasses this
 * component, every protected API call is still checked server-side.
 */
export default function RoleBasedRoute({ allowedRoles }) {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
