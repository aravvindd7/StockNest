/**
 * SINGLE SOURCE OF TRUTH seed generator for Material, Stock, and Sales
 * Master. Replaces the three previously-separate scripts (seedMaterials.js,
 * seedStock.js, seedSales.js), which is what caused Planning Master to show
 * mostly zeros: Stock/Sales dummy data used fictional Material Numbers
 * (MAT001, MAT002, ...) that never matched Material Master's actual
 * NWA-prefixed numbers.
 *
 * This script defines ONE material list — clean, sequential MAT0001,
 * MAT0002, ... numbering, no NWA anywhere — and derives all three
 * datasets from it, so Stock and Sales are structurally guaranteed to
 * reference Material Numbers that exist in Material Master. No module
 * invents its own numbers.
 *
 * Run with: npm run seed:masterdata (after npm run seed, for the Admin/User accounts)
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const Sales = require("../models/Sales");
const { MONTHS_BY_QUARTER } = require("../utils/financialYear");

let _seed = 20260805;
function rand() {
  _seed = (_seed * 9301 + 49297) % 233280;
  return _seed / 233280;
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function pad(n, len) {
  return String(n).padStart(len, "0");
}

// ---------------------------------------------------------------------
// SOURCE OF TRUTH — every material this project's dummy data will ever
// reference is defined once, here. Category/costRange are generation
// aids only (folded into description/cost), never stored as separate
// fields, consistent with Material Master's 7-field schema.
// ---------------------------------------------------------------------
const CATEGORY_DEFS = {
  "Electrical Switches": {
    models: ["Nova", "Pearl", "Sleek"],
    names: ["One Way Switch 6A", "Two Way Switch 6A", "Bell Push Switch"],
    type: "FG", costRange: [18, 60],
  },
  Sockets: {
    models: ["Nova", "Pearl"],
    names: ["3-Pin Socket 6A", "5-Pin Socket 16A"],
    type: "FG", costRange: [25, 90],
  },
  "Modular Plates": {
    models: ["Sleek", "Classic"],
    names: ["1-Module Plate", "3-Module Plate"],
    type: "FG", costRange: [15, 55],
  },
  Fans: {
    models: ["AeroBreeze", "CoolAir"],
    names: ["Ceiling Fan 1200mm", "Exhaust Fan 150mm"],
    type: "FG", costRange: [650, 2400],
  },
  "Lighting Products": {
    models: ["Luminex", "BrightMax"],
    names: ["LED Bulb 9W", "LED Panel Light 18W"],
    type: "FG", costRange: [45, 350],
  },
  Cables: {
    models: ["FlexiCore", "SafeLine"],
    names: ["1.5 sq mm Wire (90m)", "2.5 sq mm Wire (90m)"],
    type: "FG", costRange: [900, 3200],
  },
  "Hardware Components": {
    models: ["DuraFix", "SteelGrip"],
    names: ["MCB 16A Single Pole", "Distribution Board 8-Way"],
    type: "FG", costRange: [80, 950],
  },
  "Raw Materials": {
    models: ["StdGrade"],
    names: ["PVC Granules 25kg", "Copper Wire Rod 50kg"],
    type: "RM", costRange: [120, 780],
  },
  "Finished Goods": {
    models: ["ReadyPack"],
    names: ["Switch Combo Kit", "Home Wiring Starter Kit"],
    type: "FG", costRange: [450, 1600],
  },
  "Electrical Accessories": {
    models: ["ClipFix", "SecureMount"],
    names: ["Cable Clip Pack", "Junction Box 4x4"],
    type: "FG", costRange: [12, 180],
  },
};

const PLANTS = [
  { name: "Chennai Plant", region: "South" },
  { name: "Coimbatore Plant", region: "South" },
  { name: "Pune Plant", region: "West" },
  { name: "Delhi Plant", region: "North" },
];
const STORAGE_LOCATIONS = ["WH-A01", "WH-A02", "WH-B01", "WH-C01"];
const STATUSES_STOCK = ["Active", "Active", "Active", "Hold"];
const DIVISIONS = ["Electrical", "Consumer Durables"];
const YEARS = [2024, 2025, 2026];
const QTRS = ["Q1", "Q2", "Q3", "Q4"];
const PCS = ["PC-1", "PC-2"];

/** Builds the single master material list — MAT0001, MAT0002, ... in insertion order. */
function buildMasterMaterials() {
  const list = [];
  let seq = 0;

  Object.entries(CATEGORY_DEFS).forEach(([category, def]) => {
    def.names.forEach((baseName) => {
      seq += 1;
      const model = pick(def.models);
      const [minCost, maxCost] = def.costRange;
      const invCost = +(randInt(minCost, maxCost) + rand()).toFixed(2);

      list.push({
        materialNo: `MAT${pad(seq, 4)}`,
        description: `${model} ${baseName}`,
        model,
        status: rand() < 0.08 ? "Discontinued" : "STD",
        invCost,
        moq: def.type === "RM" ? randInt(500, 5000) : randInt(50, 2000),
        type: def.type,
        category, // generation aid only — not persisted on Material
      });
    });
  });

  return list;
}

async function seedMaterialMaster(materials) {
  await Material.deleteMany({});
  const docs = materials.map(({ category, ...m }) => ({ ...m, isActive: true }));
  const created = await Material.insertMany(docs);
  console.log(`[seed] Material Master: ${created.length} materials (MAT0001-MAT${pad(created.length, 4)}).`);
}

async function seedStockMaster(materials) {
  await Stock.deleteMany({});
  const rows = [];

  materials.forEach((material, idx) => {
    const rowCount = randInt(1, 2); // 1-2 stock locations per material
    for (let r = 0; r < rowCount; r += 1) {
      const plant = pick(PLANTS);
      const storageLocation = pick(STORAGE_LOCATIONS);
      const stockDate = new Date(2026, 6, randInt(1, 20));
      const totalStockQty = randInt(50, 800);
      const sitQty = randInt(0, 100);
      const sihQty = Math.max(0, totalStockQty - sitQty);
      const unitValue = material.invCost || randInt(15, 900);

      rows.push({
        PlantGroup: plant.region,
        PlantSort: String(PLANTS.indexOf(plant) + 1),
        PlantName: plant.name,
        MatNo: material.materialNo,
        Material: material.description,
        MatSubGroup: material.type === "RM" ? "Raw Material" : "Finished Goods",
        MaterialGroup: material.model,
        Division: pick(DIVISIONS),
        StockDate: stockDate,
        MatShortName: material.description.slice(0, 24),
        MatUnit: "PCS",
        UnitCase: String(randInt(6, 48)),
        Page: String(randInt(1, 20)),
        MatGroupUnit: "PCS",
        MatOrder: String(idx * 2 + r + 1),
        fcast_Active: "Y",
        trendMatSubGroup: material.type === "RM" ? "Raw Material" : "Finished Goods",
        Active: "Y",
        Consignment: rand() < 0.2 ? "Y" : "N",
        ConsTran: "N",
        Defect: String(randInt(0, 5)),
        NonDefect: String(totalStockQty - randInt(0, 5)),
        TotalStock: totalStockQty,
        SIT: sitQty,
        SIH: sihQty,
        TotalStockQty: totalStockQty,
        SITQTY: sitQty,
        SIHQty: sihQty,
        TotalStockCV: +(totalStockQty * unitValue).toFixed(2),
        SIHCV: +(sihQty * unitValue).toFixed(2),
        SITCV: +(sitQty * unitValue).toFixed(2),
        Period: "2026-07",
        CasePlanningYN: "Y",
        MatGroup: material.model,
        createdOn: new Date(2026, 6, randInt(1, 20)),
        StockVal: +(totalStockQty * unitValue).toFixed(2),
        StorageLocation: storageLocation,
        Qtr: "Q3",
        PC: `PC-${randInt(1, 9)}`,
        Year: 2026,
        RegionName: plant.region,
        Merged: "N",
        Status: pick(STATUSES_STOCK),
      });
    }
  });

  const created = await Stock.insertMany(rows);
  console.log(`[seed] Stock Master: ${created.length} records, all referencing existing Material Numbers.`);
}

async function seedSalesMaster(materials) {
  await Sales.deleteMany({});
  const rows = [];

  materials.forEach((material, idx) => {
    // Different materials get different demand levels and patterns, so
    // Planning Master's trend arrows show a realistic mix.
    const baseQty = 60 + idx * 6;
    const plant = PLANTS[idx % PLANTS.length];
    const pc = PCS[idx % PCS.length];
    const unitValue = material.invCost || randInt(15, 900);

    YEARS.forEach((year, yearIdx) => {
      const financialYear = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;

      QTRS.forEach((qtr) => {
        const yearBase = baseQty + yearIdx * 18; // gentle year-over-year growth
        const quarterQty = Math.max(15, Math.round(yearBase + randInt(-30, 45)));

        // Split the quarter's total across its 3 months with mild
        // variation, so Planning Service's monthly->quarterly aggregation
        // (and Sales Master's expandable monthly breakdown) has realistic
        // month-to-month movement rather than a flat 1/3 split every time.
        const m1 = Math.round(quarterQty * (0.3 + rand() * 0.1));
        const m2 = Math.round(quarterQty * (0.3 + rand() * 0.1));
        const m3 = Math.max(1, quarterQty - m1 - m2); // remainder, so months always sum exactly to the quarter total

        MONTHS_BY_QUARTER[qtr].forEach((month, mIdx) => {
          const salesQty = [m1, m2, m3][mIdx];
          const salesEA = randInt(1, 20);

          rows.push({
            MatNo: material.materialNo,
            Material: material.description,
            Page: String(randInt(1, 20)),
            MatGroupCode: material.model.toUpperCase(),
            MatGroupName: material.model,
            MatSubGroup: material.type === "RM" ? "Raw Material" : "Finished Goods",
            Plant: plant.name,
            FinancialYear: financialYear,
            Month: month,
            Quarter: qtr, // derived, stored once at seed time — same rule Add Sales/Import both follow
            Period: `${financialYear}-${month}`, // derived, same principle as Quarter
            QtrWk: `${qtr}-W${randInt(1, 13)}`,
            ProductionCycle: pc,
            Status: rand() < 0.85 ? "Active" : "Hold",
            Merged: "N",
            SalesEA: salesEA,
            SalesQty: salesQty,
            SalesCV: +(salesQty * unitValue).toFixed(2),
            NetSales: +(salesQty * unitValue * 0.95).toFixed(2),
          });
        });
      });
    });
  });

  const created = await Sales.insertMany(rows);
  console.log(`[seed] Sales Master: ${created.length} monthly records across ${YEARS.join("/")}, all referencing existing Material Numbers.`);
}

async function run() {
  await connectDB();

  const materials = buildMasterMaterials();

  await seedMaterialMaster(materials);
  await seedStockMaster(materials);
  await seedSalesMaster(materials);

  console.log(
    `[seed] Done. Material/Stock/Sales Master all share Material Numbers ` +
      `MAT0001-MAT${pad(materials.length, 4)} — Planning Master should now show real quarterly data.`
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
