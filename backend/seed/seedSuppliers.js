/**
 * Seeds Suppliers. Standalone — not part of seed:all. Material Master no
 * longer references suppliers (simplified to 7 fields); kept in case a
 * future module needs supplier data.
 * Run with: npm run seed:suppliers
 */
require("dotenv").config({ override: true });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Supplier = require("../models/Supplier");

const SUPPLIERS = [
  { name: "Nova Electricals Pvt Ltd", contactPerson: "R. Venkatesh", email: "sales@novaelectricals.example", phone: "+91-44-2345-6789", address: "Guindy Industrial Estate, Chennai" },
  { name: "Pearl Switchgear Co.", contactPerson: "S. Anitha", email: "orders@pearlswitchgear.example", phone: "+91-44-2233-4455", address: "Ambattur, Chennai" },
  { name: "AeroBreeze Fans Ltd", contactPerson: "K. Manoharan", email: "info@aerobreeze.example", phone: "+91-422-234-5566", address: "Peelamedu, Coimbatore" },
  { name: "Luminex Lighting Solutions", contactPerson: "V. Priyanka", email: "contact@luminex.example", phone: "+91-422-345-6677", address: "Gandhipuram, Coimbatore" },
  { name: "FlexiCore Cables Pvt Ltd", contactPerson: "A. Suresh Kumar", email: "sales@flexicore.example", phone: "+91-452-223-4456", address: "SIDCO Industrial Estate, Madurai" },
  { name: "SteelGrip Hardware Works", contactPerson: "M. Rajalakshmi", email: "orders@steelgrip.example", phone: "+91-427-234-5567", address: "Hasthampatti, Salem" },
  { name: "DuraFix Components Ltd", contactPerson: "P. Karthikeyan", email: "info@durafix.example", phone: "+91-431-234-5678", address: "Thillai Nagar, Tiruchirappalli" },
  { name: "SafeLine Wires & Cables", contactPerson: "N. Deepa", email: "sales@safeline.example", phone: "+91-44-4567-8901", address: "Perungudi, Chennai" },
  { name: "BrightMax Electricals", contactPerson: "T. Ravichandran", email: "contact@brightmax.example", phone: "+91-422-456-7788", address: "Saibaba Colony, Coimbatore" },
  { name: "SecureMount Accessories", contactPerson: "L. Kavitha", email: "orders@securemount.example", phone: "+91-452-334-5567", address: "Anna Nagar, Madurai" },
];

async function run() {
  await connectDB();
  await Supplier.deleteMany({});
  const created = await Supplier.insertMany(SUPPLIERS.map((s) => ({ ...s, isActive: true })));
  console.log(`[seed] Created ${created.length} suppliers.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
