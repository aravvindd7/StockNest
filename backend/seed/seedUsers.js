/**
 * Creates (or resets) the Admin and User seed accounts.
 * Run with: npm run seed   (from the backend/ directory, after `npm install`)
 *
 * Credentials come from .env (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD /
 * SEED_USER_EMAIL / SEED_USER_PASSWORD) so real passwords never live in code.
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");

async function upsertUser({ username, email, password, role }) {
  const passwordHash = await User.hashPassword(password);

  const user = await User.findOneAndUpdate(
    { email },
    { username, email, passwordHash, role, isActive: true },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`[seed] ${role} account ready: ${user.email}`);
}

async function run() {
  await connectDB();

  const {
    SEED_ADMIN_EMAIL,
    SEED_ADMIN_PASSWORD,
    SEED_USER_EMAIL,
    SEED_USER_PASSWORD,
  } = process.env;

  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || !SEED_USER_EMAIL || !SEED_USER_PASSWORD) {
    console.error(
      "[seed] Missing SEED_* variables. Copy .env.example to .env and fill in seed credentials."
    );
    process.exit(1);
  }

  await upsertUser({
    username: "admin",
    email: SEED_ADMIN_EMAIL,
    password: SEED_ADMIN_PASSWORD,
    role: "ADMIN",
  });

  await upsertUser({
    username: "employee",
    email: SEED_USER_EMAIL,
    password: SEED_USER_PASSWORD,
    role: "USER",
  });

  console.log("[seed] Done.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
