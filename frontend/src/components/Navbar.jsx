import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

function initialsOf(name) {
  if (!name) return "?";
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

export default function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
      <button
        className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:border-primary hover:text-primary lg:hidden"
        onClick={onMenuClick}
        aria-label="Toggle menu"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <div>
        <h1 className="font-display text-lg font-bold text-[#1B2338]">Inventory Dashboard</h1>
        <p className="text-xs text-gray-500">
          Signed in as <span className="font-semibold">{user?.role === "ADMIN" ? "Administrator" : "User"}</span>
        </p>
      </div>

      <div className="ml-auto flex items-center gap-4">
        <span
          className={`hidden rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide sm:inline-block ${
            user?.role === "ADMIN" ? "bg-primary/10 text-primary" : "bg-accent/10 text-accent"
          }`}
        >
          {user?.role}
        </span>

        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-bold font-display text-white">
            {initialsOf(user?.username)}
          </div>
          <div className="hidden leading-tight md:block">
            <div className="text-sm font-semibold">{user?.username}</div>
            <div className="text-[11px] text-gray-500">{user?.email}</div>
          </div>
        </div>

        <button onClick={handleLogout} className="sn-btn-ghost sm:!px-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 5v1a3 3 0 01-3 3H6a3 3 0 01-3-3V6a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}
