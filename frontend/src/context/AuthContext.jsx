import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { loginRequest, logoutRequest } from "../services/authService";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem("sn_user");
    return stored ? JSON.parse(stored) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem("sn_token"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // If api.js sees a 401 anywhere in the app, it fires this event —
  // sync React state so the UI redirects to /login immediately.
  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
      setToken(null);
    };
    window.addEventListener("sn:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("sn:unauthorized", handleUnauthorized);
  }, []);

  const login = useCallback(async (identifier, password) => {
    setLoading(true);
    setError(null);
    try {
      const { token: newToken, user: newUser } = await loginRequest(identifier, password);
      localStorage.setItem("sn_token", newToken);
      localStorage.setItem("sn_user", JSON.stringify(newUser));
      setToken(newToken);
      setUser(newUser);
      return true;
    } catch (err) {
      setError(err.response?.data?.message || "Login failed. Please try again.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Logout is best-effort on the server side; always clear locally.
    }
    localStorage.removeItem("sn_token");
    localStorage.removeItem("sn_user");
    setToken(null);
    setUser(null);
  }, []);

  const value = {
    user,
    token,
    isAuthenticated: !!token && !!user,
    loading,
    error,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an <AuthProvider>.");
  return ctx;
}
