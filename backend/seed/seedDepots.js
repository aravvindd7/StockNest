/**
 * Seeds a handful of sample depots for testing the Depot Master UI.
 * Run with: npm run seed:depots
 *
 * This has no relationship to Material or Inventory — Depot Master is
 * intentionally a standalone module for now.
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Depot = require("../models/Depot");

const DEPOTS = [
  { depotId: "DEP001", depotName: "Chennai Central Depot" },
  { depotId: "DEP002", depotName: "Coimbatore Depot" },
  { depotId: "DEP003", depotName: "Bangalore Depot" },
  { depotId: "DEP004", depotName: "Madurai Depot" },
  { depotId: "DEP005", depotName: "Salem Depot" },
];

async function run() {
  await connectDB();

  await Depot.deleteMany({});
  const created = await Depot.insertMany(DEPOTS);
  console.log(`[seed] Created ${created.length} depots.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
