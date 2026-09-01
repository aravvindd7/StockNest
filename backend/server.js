require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const materialRoutes = require("./routes/materialRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const depotRoutes = require("./routes/depotRoutes");
const stockRoutes = require("./routes/stockRoutes");
const salesRoutes = require("./routes/salesRoutes");
const planningRoutes = require("./routes/planningRoutes");
const forecastRoutes = require("./routes/forecastRoutes");

const app = express();

// ---- Core middleware ----
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// ---- Health check ----
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "stocknest-backend" });
});

// ---- Routes ----
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/depots", depotRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/planning", planningRoutes);
// Phase 4: new, isolated infrastructure — the ML forecasting engine.
// Does not modify any existing route below or above it.
app.use("/api/forecast", forecastRoutes);

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ---- Centralized error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error." });
});

const PORT = process.env.PORT || 5001;

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`[server] StockNest API running on http://localhost:${PORT}`);
  });
}

start();

module.exports = app;
