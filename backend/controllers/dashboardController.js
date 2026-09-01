const Material = require("../models/Material");
const Branch = require("../models/Branch");
const Warehouse = require("../models/Warehouse");
const Inventory = require("../models/Inventory");
const DatasetHistory = require("../models/DatasetHistory");

/**
 * GET /api/dashboard/summary — both ADMIN and USER, tailored per role.
 * Now backed by real aggregations (Material/Inventory models landed in
 * Steps 12-13) instead of the Step 1-11 mock numbers.
 */
async function getSummary(req, res) {
  try {
    const [
      totalProducts,
      totalBranches,
      totalWarehouses,
      inventoryAgg,
    ] = await Promise.all([
      Material.countDocuments({ isActive: true }),
      Branch.countDocuments({ isActive: true }),
      Warehouse.countDocuments({ isActive: true }),
      Inventory.aggregate([
        {
          $lookup: { from: "materials", localField: "materialId", foreignField: "_id", as: "material" },
        },
        { $unwind: "$material" },
        { $match: { "material.isActive": true } },
        {
          $group: {
            _id: null,
            totalAvailableStock: { $sum: "$availableStock" },
            inventoryValue: { $sum: { $multiply: ["$availableStock", "$unitCost"] } },
            lowStockItems: { $sum: { $cond: [{ $eq: ["$stockStatus", "LOW STOCK"] }, 1, 0] } },
            outOfStockItems: { $sum: { $cond: [{ $eq: ["$stockStatus", "OUT OF STOCK"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const inv = inventoryAgg[0] || { totalAvailableStock: 0, inventoryValue: 0, lowStockItems: 0, outOfStockItems: 0 };

    const common = {
      totalProducts,
      totalAvailableStock: inv.totalAvailableStock,
      lowStockItems: inv.lowStockItems,
      outOfStockItems: inv.outOfStockItems,
      totalBranches,
      totalWarehouses,
      inventoryValue: Math.round(inv.inventoryValue * 100) / 100,
    };

    if (req.user.role !== "ADMIN") {
      return res.json({ role: "USER", kpis: common });
    }

    const [activeMaterials, discontinuedMaterials, totalImportBatches] = await Promise.all([
      Material.countDocuments({ isActive: true, status: "STD" }),
      Material.countDocuments({ isActive: true, status: "Discontinued" }),
      DatasetHistory.countDocuments({ module: "material" }),
    ]);

    res.json({
      role: "ADMIN",
      kpis: {
        ...common,
        totalMaterials: totalProducts,
        activeMaterials,
        discontinuedMaterials,
        totalImportBatches,
      },
    });
  } catch (err) {
    console.error("[dashboardController.getSummary]", err);
    res.status(500).json({ message: "Internal server error while fetching dashboard summary." });
  }
}

module.exports = { getSummary };
