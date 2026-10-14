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
const distributionRoutes = require("./routes/distributionRoutes");

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
// Distribution Master — Stage 1 read-only foundation (Admin only).
app.use("/api/distribution", distributionRoutes);

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

  // Startup backfill: synchronize every existing Stock record's Status to its
  // Material Master status (STD → Active, Discontinued/inactive → Discontinued).
  // Idempotent and non-destructive — only the Status field is written. Runs
  // before the API serves so the table never shows a stale status; a failure
  // is logged and the server still starts (statuses remain cross-reference-
  // hidden, and the admin POST /api/stock/resync-status can retry).
  try {
    const { syncStockStatusesFromMaterials } = require("./utils/stockStatusSync");
    const result = await syncStockStatusesFromMaterials();
    console.log(
      `[sync] Stock statuses backfilled from Material Master: +${result.updatedActive} Active, +${result.updatedDiscontinued} Discontinued`
    );
  } catch (err) {
    console.error("[sync] Stock status backfill failed (continuing startup):", err.message);
  }

  // Distribution Stage 4: physical stock movements need MongoDB transactions
  // (a replica set). Probe once at startup; without them the movement
  // endpoints fail closed with 503 (see utils/transactions.js).
  try {
    const { checkTransactionSupport, transactionStatus } = require("./utils/transactions");
    const ok = await checkTransactionSupport();
    console.log(ok
      ? "[transactions] MongoDB transactions available — Distribution stock movements enabled."
      : `[transactions] MongoDB transactions UNAVAILABLE (${transactionStatus().lastError}) — Distribution stock movement endpoints will return 503.`);
  } catch (err) {
    console.error("[transactions] Capability check failed (movement endpoints will return 503):", err.message);
  }

  app.listen(PORT, () => {
    console.log(`[server] StockNest API running on http://localhost:${PORT}`);
  });
}

start();

module.exports = app;
