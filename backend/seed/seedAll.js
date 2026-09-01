/**
 * Runs every seed script in the required order: users -> materials -> inventory
 * Run with: npm run seed:all
 *
 * Note: seedSuppliers.js still exists but is no longer part of this chain —
 * Material Master was simplified to 7 fields (no supplier reference). It's
 * left in place in case a future module needs supplier data.
 *
 * Each script connects/disconnects its own Mongoose connection and exits
 * the process on completion, so we shell out to each one as a child
 * process rather than importing/calling them in-process.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const scripts = ["seedUsers.js", "seedMasterData.js", "seedInventory.js", "seedDepots.js"];

for (const script of scripts) {
  console.log(`\n[seed:all] Running ${script}...`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[seed:all] ${script} failed (exit code ${result.status}). Stopping.`);
    process.exit(result.status || 1);
  }
}

console.log("\n[seed:all] All seed scripts completed successfully.");
