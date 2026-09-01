import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const COMMON_LINKS = [
  { to: "/dashboard", label: "Dashboard", icon: "M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" },
  { to: "/inventory", label: "Inventory", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
  { to: "/products", label: "Products", icon: "M7 7h10M7 12h10M7 17h6" },
  { to: "/branches", label: "Branches", icon: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1m-6 4h1m4 0h1" },
  { to: "/warehouses", label: "Warehouses", icon: "M3 9.75L12 4l9 5.75V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.75z" },
  { to: "/reports", label: "Reports", icon: "M9 17V9m4 8V5m4 12v-6M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" },
];

export default function Sidebar({ open, onNavigate }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const linkClasses = ({ isActive }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
      isActive ? "bg-accent/15 text-white" : "text-[#AFBBDA] hover:bg-white/5 hover:text-white"
    }`;

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-64 transform bg-gradient-to-b from-navy to-navy-2 transition-transform lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-primary text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4m0-14v14m9-14v10l-9 4" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="font-display text-[17px] font-bold text-white">StockNest</div>
          <div className="text-[10.5px] uppercase tracking-wide text-[#8493B8]">Enterprise Inventory</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-4">
        <div className="mb-1 mt-1 px-3 text-[10.5px] font-semibold uppercase tracking-wide text-[#5C6B93]">
          Main
        </div>
        {COMMON_LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} className={linkClasses} onClick={onNavigate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
            </svg>
            <span>{link.label}</span>
          </NavLink>
        ))}

        {isAdmin && (
          <>
            <div className="mb-1 mt-5 px-3 text-[10.5px] font-semibold uppercase tracking-wide text-[#5C6B93]">
              Admin
            </div>
            <NavLink to="/material-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              <span>Material Master</span>
            </NavLink>
            <NavLink to="/depot-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 9.75L12 4l9 5.75V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1V9.75z" />
              </svg>
              <span>Depot Master</span>
            </NavLink>
            <NavLink to="/stock-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <span>Stock Master</span>
            </NavLink>
            <NavLink to="/sales-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V9m4 8V5m4 12v-6M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <span>Sales Master</span>
            </NavLink>
            <NavLink to="/planning-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>Planning Master</span>
            </NavLink>
            <NavLink to="/distribution-master" className={linkClasses} onClick={onNavigate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.83V8.065a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
              </svg>
              <span>Distribution Master</span>
            </NavLink>
          </>
        )}
      </nav>
    </aside>
  );
}
