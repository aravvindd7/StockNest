import { Routes, Route, Navigate } from "react-router-dom";

import Login from "../pages/Login";
import Dashboard from "../pages/Dashboard";
import Inventory from "../pages/Inventory";
import Products from "../pages/Products";
import Branches from "../pages/Branches";
import Warehouses from "../pages/Warehouses";
import Reports from "../pages/Reports";
import MaterialMaster from "../pages/MaterialMaster";
import ImportMaterials from "../pages/ImportMaterials";
import ImportHistory from "../pages/ImportHistory";
import DepotMaster from "../pages/DepotMaster";
import ImportDepots from "../pages/ImportDepots";
import DepotImportHistory from "../pages/DepotImportHistory";
import StockMaster from "../pages/StockMaster";
import ImportStock from "../pages/ImportStock";
import StockImportHistory from "../pages/StockImportHistory";
import SalesMaster from "../pages/SalesMaster";
import ImportSales from "../pages/ImportSales";
import SalesImportHistory from "../pages/SalesImportHistory";
import PlanningMaster from "../pages/PlanningMaster";
import DistributionMaster from "../pages/DistributionMaster";
import Unauthorized from "../pages/Unauthorized";

import ProtectedRoute from "../components/ProtectedRoute";
import RoleBasedRoute from "../components/RoleBasedRoute";
import DashboardLayout from "../components/DashboardLayout";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/unauthorized" element={<Unauthorized />} />

      {/* Everything below requires a valid session */}
      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/products" element={<Products />} />
          <Route path="/branches" element={<Branches />} />
          <Route path="/warehouses" element={<Warehouses />} />
          <Route path="/reports" element={<Reports />} />

          {/* Admin-only — order matches the required Admin nav: Material, Depot, Stock, Sales, Planning */}
          <Route element={<RoleBasedRoute allowedRoles={["ADMIN"]} />}>
            <Route path="/material-master" element={<MaterialMaster />} />
            <Route path="/material-master/import" element={<ImportMaterials />} />
            <Route path="/material-master/import-history" element={<ImportHistory />} />

            <Route path="/depot-master" element={<DepotMaster />} />
            <Route path="/depot-master/import" element={<ImportDepots />} />
            <Route path="/depot-master/import-history" element={<DepotImportHistory />} />

            <Route path="/stock-master" element={<StockMaster />} />
            <Route path="/stock-master/import" element={<ImportStock />} />
            <Route path="/stock-master/import-history" element={<StockImportHistory />} />

            <Route path="/sales-master" element={<SalesMaster />} />
            <Route path="/sales-master/import" element={<ImportSales />} />
            <Route path="/sales-master/import-history" element={<SalesImportHistory />} />

            <Route path="/planning-master" element={<PlanningMaster />} />
            <Route path="/distribution-master" element={<DistributionMaster />} />
          </Route>
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
