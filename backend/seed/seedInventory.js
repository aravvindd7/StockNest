/**
 * Seeds Branches, Warehouses, and Inventory records for the materials
 * already created by seedMasterData.js. Run order:
 *   npm run seed              (users)
 *   npm run seed:masterdata   (Material + Stock + Sales, single source of truth)
 *   npm run seed:inventory    (this file — branches, warehouses, stock)
 * or just: npm run seed:all
 *
 * This file no longer creates Materials itself — that's seedMasterData.js's
 * job now (previously seedMaterials.js). Re-running this script is safe —
 * it clears and re-seeds Branches/Warehouses/Inventory each time, without
 * touching Materials, Stock, Sales, or Users.
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Branch = require("../models/Branch");
const Warehouse = require("../models/Warehouse");
const Material = require("../models/Material");
const Inventory = require("../models/Inventory");

let _seed = 20260721;
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

const BRANCHES = [
  { name: "Chennai", code: "BR-CHN", city: "Chennai" },
  { name: "Coimbatore", code: "BR-CBE", city: "Coimbatore" },
  { name: "Madurai", code: "BR-MDU", city: "Madurai" },
  { name: "Salem", code: "BR-SLM", city: "Salem" },
  { name: "Trichy", code: "BR-TRZ", city: "Tiruchirappalli" },
];

const WAREHOUSES = [
  { name: "WH-North", code: "WH-N" },
  { name: "WH-South", code: "WH-S" },
  { name: "WH-Central", code: "WH-C" },
  { name: "WH-East", code: "WH-E" },
  { name: "WH-Cold-Storage", code: "WH-CS" },
];

async function seedBranchesAndWarehouses() {
  await Branch.deleteMany({});
  await Warehouse.deleteMany({});

  const branches = await Branch.insertMany(BRANCHES.map((b) => ({ ...b, isActive: true })));
  const warehouses = await Warehouse.insertMany(WAREHOUSES.map((w) => ({ ...w, isActive: true })));

  console.log(`[seed] Created ${branches.length} branches, ${warehouses.length} warehouses.`);
  return { branches, warehouses };
}

async function seedInventoryRecords(materials, branches, warehouses) {
  await Inventory.deleteMany({});

  const records = [];

  for (const material of materials) {
    // Discontinued materials are unlikely to still be stocked everywhere —
    // give them fewer branch listings than active/STD materials.
    const branchCount = material.status === "Discontinued" ? randInt(0, 2) : randInt(2, 5);
    const shuffled = [...branches].sort(() => rand() - 0.5).slice(0, branchCount);

    for (const branch of shuffled) {
      const warehouse = pick(warehouses);
      const reorderLevel = randInt(15, 50);
      const maximumCapacity = reorderLevel + randInt(150, 400);

      const roll = rand();
      let currentStock;
      if (roll < 0.08) currentStock = randInt(0, 5);
      else if (roll < 0.22) currentStock = randInt(6, reorderLevel + 10);
      else if (roll < 0.92) currentStock = randInt(reorderLevel + 20, Math.max(reorderLevel + 30, maximumCapacity - 20));
      else currentStock = maximumCapacity + randInt(20, 150);

      const reservedStock = Math.min(currentStock, randInt(0, 20));
      const damagedStock = randInt(0, 5);
      const returnedStock = randInt(0, 4);
      // Inventory carries its own unitCost (can drift from the material's
      // master invCost over time/location); seed it near the master cost.
      const unitCost = +(material.invCost * (0.95 + rand() * 0.1)).toFixed(2);

      records.push({
        materialId: material._id,
        branchId: branch._id,
        warehouseId: warehouse._id,
        currentStock,
        reservedStock,
        damagedStock,
        returnedStock,
        reorderLevel,
        maximumCapacity,
        unitCost,
        lastRestocked: new Date(Date.now() - randInt(0, 45) * 86400000),
      });
    }
  }

  const batchSize = 50;
  let insertedCount = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    await Inventory.create(batch);
    insertedCount += batch.length;
  }

  console.log(`[seed] Created ${insertedCount} inventory records across ${branches.length} branches.`);
}

async function run() {
  await connectDB();

  const materials = await Material.find({ isActive: true });
  if (materials.length === 0) {
    console.error("[seed] No materials found. Run `npm run seed:materials` first.");
    process.exit(1);
  }

  const { branches, warehouses } = await seedBranchesAndWarehouses();
  await seedInventoryRecords(materials, branches, warehouses);

  console.log("[seed] Inventory seeding complete.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
