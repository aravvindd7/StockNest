import { useState } from "react";
import { useLocation, useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * One login form for everyone. There is no "Login as Admin / Login as User"
 * choice — the backend determines the role from the matched user record.
 */
export default function Login() {
  const { login, loading, error, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  if (isAuthenticated) {
    const dest = location.state?.from?.pathname || "/dashboard";
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const success = await login(identifier, password);
    if (success) {
      navigate(location.state?.from?.pathname || "/dashboard", { replace: true });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-navy to-navy-2 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-primary text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4m0-14v14m9-14v10l-9 4" />
            </svg>
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-white">StockNest</h1>
            <p className="text-sm text-[#8493B8]">Enterprise Inventory Management</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <h2 className="mb-1 font-display text-lg font-bold text-[#1B2338]">Sign in</h2>
          <p className="mb-6 text-sm text-gray-500">Enter your credentials to access the dashboard.</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                Username or Email
              </label>
              <input
                type="text"
                required
                autoFocus
                className="sn-input"
                placeholder="you@company.com"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                Password
              </label>
              <input
                type="password"
                required
                className="sn-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="sn-btn-primary mt-2 w-full justify-center py-2.5 disabled:opacity-60">
              {loading ? "Signing in…" : "Login"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-[#8493B8]">
          Role is determined securely by the server — there is no role selector here.
        </p>
      </div>
    </div>
  );
}
