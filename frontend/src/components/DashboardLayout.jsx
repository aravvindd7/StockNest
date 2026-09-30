import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Navbar from "./Navbar";

const SIDEBAR_STORAGE_KEY = "stocknest_sidebar_collapsed";

function getInitialCollapsedState() {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored === "true";
  } catch {
    return false;
  }
}

/**
 * Shared shell used by both Admin and User (Section 6 of the spec).
 * The sidebar's own content differs by role (see Sidebar.jsx); the
 * layout wrapping it is identical for everyone.
 */
export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getInitialCollapsedState);

  // Persist sidebar collapse state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // localStorage unavailable, ignore
    }
  }, [sidebarCollapsed]);

  const toggleSidebar = () => setSidebarCollapsed((v) => !v);

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onNavigate={() => setSidebarOpen(false)}
        onToggleCollapse={toggleSidebar}
      />

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`transition-all duration-200 ${
          sidebarCollapsed ? "lg:pl-16" : "lg:pl-64"
        }`}
      >
        <Navbar onMenuClick={() => setSidebarOpen((v) => !v)} />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
