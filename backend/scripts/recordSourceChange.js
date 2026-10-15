/**
 * Records a source-data change made OUTSIDE the backend API (mongosh, a data
 * fix-up or migration script), so the automatic forecast / recommendation
 * pipeline knows the derived data is stale. Server-side only — not exposed to
 * the frontend or any HTTP route.
 *
 *   node scripts/recordSourceChange.js sales
 *   node scripts/recordSourceChange.js stock depotSafetyStock
 *
 * Valid sources: sales, stock, materials, depots, depotPlantMapping,
 * depotSafetyStock, transfers. Run it once, after the change has completed
 * (one run per logical change, not per row). This process only records the
 * change; the running StockNest server notices it at its next periodic check
 * (every 5 minutes) and regenerates what depends on it.
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const pipeline = require("../services/derivedDataPipeline");

async function main() {
  const sources = process.argv.slice(2);
  const unknown = sources.filter((s) => !pipeline.SOURCES.includes(s));
  if (!sources.length || unknown.length) {
    console.error(`Usage: node scripts/recordSourceChange.js <source> [...]\nValid sources: ${pipeline.SOURCES.join(", ")}${unknown.length ? `\nUnknown: ${unknown.join(", ")}` : ""}`);
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGO_URI);
  await pipeline.recordSourceChange(sources, { reason: `script: ${sources.join(", ")}` });
  const { sources: versions } = await pipeline.readState();
  console.log(`Recorded change to ${sources.join(", ")}. Current versions: ${JSON.stringify(versions)}. The server will update derived data at its next check.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Could not record the source change:", err.message);
  process.exit(1);
});
