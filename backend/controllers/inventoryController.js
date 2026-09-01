const mongoose = require("mongoose");
const Inventory = require("../models/Inventory");
const Branch = require("../models/Branch");
const Warehouse = require("../models/Warehouse");
const { STOCK_STATUSES } = require("../models/Inventory");

const SORTABLE_FIELDS = {
  materialNo: "material.materialNo",
  description: "material.description",
  branch: "branch.name",
  warehouse: "warehouse.name",
  currentStock: "currentStock",
  reservedStock: "reservedStock",
  availableStock: "availableStock",
  damagedStock: "damagedStock",
  returnedStock: "returnedStock",
  reorderLevel: "reorderLevel",
  maximumCapacity: "maximumCapacity",
  inventoryValue: "inventoryValue",
  stockStatus: "stockStatus",
  lastRestocked: "lastRestocked",
  lastUpdated: "updatedAt",
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GET /api/inventory
 * Accessible to both ADMIN and USER (read-only, branch-wise inventory view).
 *
 * Query params (all optional):
 *   materialNo, description, model  -> partial, case-insensitive match on Material fields
 *   branch                                        -> exact match on Branch.name
 *   warehouse                                      -> exact match on Warehouse.name
 *   stockStatus                                    -> exact match, one of STOCK_STATUSES
 *   minQty, maxQty                                 -> range on availableStock
 *   search                                          -> free-text across materialNo/description/model
 *   page (default 1), limit (default 25)
 *   sortBy (default "materialNo"), sortDir ("asc" | "desc", default "asc")
 */
async function listInventory(req, res) {
  try {
    const {
      materialNo,
      description,
      model,
      branch,
      warehouse,
      stockStatus,
      minQty,
      maxQty,
      search,
      page = 1,
      limit = 25,
      sortBy = "materialNo",
      sortDir = "asc",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));

    const pipeline = [
      {
        $lookup: {
          from: "materials",
          localField: "materialId",
          foreignField: "_id",
          as: "material",
        },
      },
      { $unwind: "$material" },
      {
        $lookup: {
          from: "branches",
          localField: "branchId",
          foreignField: "_id",
          as: "branch",
        },
      },
      { $unwind: "$branch" },
      {
        $lookup: {
          from: "warehouses",
          localField: "warehouseId",
          foreignField: "_id",
          as: "warehouse",
        },
      },
      { $unwind: "$warehouse" },
      {
        $addFields: {
          inventoryValue: { $multiply: ["$availableStock", "$unitCost"] },
        },
      },
    ];

    // ---- Build $match stage from filters ----
    const match = { "material.isActive": true, "branch.isActive": true };

    if (materialNo) match["material.materialNo"] = { $regex: escapeRegex(materialNo), $options: "i" };
    if (description) match["material.description"] = { $regex: escapeRegex(description), $options: "i" };
    if (model) match["material.model"] = { $regex: escapeRegex(model), $options: "i" };
    if (branch) match["branch.name"] = branch;
    if (warehouse) match["warehouse.name"] = warehouse;
    if (stockStatus) {
      if (!STOCK_STATUSES.includes(stockStatus)) {
        return res.status(400).json({ message: `Invalid stockStatus. Expected one of: ${STOCK_STATUSES.join(", ")}` });
      }
      match.stockStatus = stockStatus;
    }

    if (minQty !== undefined || maxQty !== undefined) {
      match.availableStock = {};
      if (minQty !== undefined && minQty !== "") match.availableStock.$gte = Number(minQty);
      if (maxQty !== undefined && maxQty !== "") match.availableStock.$lte = Number(maxQty);
      if (Object.keys(match.availableStock).length === 0) delete match.availableStock;
    }

    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      match.$or = [
        { "material.materialNo": rx },
        { "material.description": rx },
        { "material.model": rx },
        { "branch.name": rx },
      ];
    }

    pipeline.push({ $match: match });

    // ---- Sorting ----
    const sortField = SORTABLE_FIELDS[sortBy] || SORTABLE_FIELDS.materialNo;
    const sortDirection = sortDir === "desc" ? -1 : 1;
    pipeline.push({ $sort: { [sortField]: sortDirection, _id: 1 } });

    // ---- Pagination + total count in one round trip ----
    pipeline.push({
      $facet: {
        data: [
          { $skip: (pageNum - 1) * limitNum },
          { $limit: limitNum },
          {
            $project: {
              _id: 1,
              materialId: "$material._id",
              materialNo: "$material.materialNo",
              description: "$material.description",
              model: "$material.model",
              branch: "$branch.name",
              branchId: "$branch._id",
              warehouse: "$warehouse.name",
              warehouseId: "$warehouse._id",
              currentStock: 1,
              reservedStock: 1,
              availableStock: 1,
              damagedStock: 1,
              returnedStock: 1,
              reorderLevel: 1,
              maximumCapacity: 1,
              unitCost: 1,
              inventoryValue: 1,
              stockStatus: 1,
              lastRestocked: 1,
              lastUpdated: "$updatedAt",
            },
          },
        ],
        totalCount: [{ $count: "count" }],
        // KPI-style aggregates computed over the FILTERED set (before pagination)
        summary: [
          {
            $group: {
              _id: null,
              totalRecords: { $sum: 1 },
              distinctMaterials: { $addToSet: "$material._id" },
              distinctBranches: { $addToSet: "$branch._id" },
              totalAvailableStock: { $sum: "$availableStock" },
              totalReservedStock: { $sum: "$reservedStock" },
              totalInventoryValue: { $sum: "$inventoryValue" },
              lowStockCount: {
                $sum: { $cond: [{ $eq: ["$stockStatus", "LOW STOCK"] }, 1, 0] },
              },
              outOfStockCount: {
                $sum: { $cond: [{ $eq: ["$stockStatus", "OUT OF STOCK"] }, 1, 0] },
              },
              overstockCount: {
                $sum: { $cond: [{ $eq: ["$stockStatus", "OVERSTOCK"] }, 1, 0] },
              },
            },
          },
        ],
      },
    });

    const [result] = await Inventory.aggregate(pipeline);

    const total = result.totalCount[0]?.count || 0;
    const s = result.summary[0];
    const summary = s
      ? {
          totalRecords: s.totalRecords,
          distinctMaterials: s.distinctMaterials.length,
          distinctBranches: s.distinctBranches.length,
          totalAvailableStock: s.totalAvailableStock,
          totalReservedStock: s.totalReservedStock,
          totalInventoryValue: Math.round(s.totalInventoryValue * 100) / 100,
          lowStockCount: s.lowStockCount,
          outOfStockCount: s.outOfStockCount,
          overstockCount: s.overstockCount,
        }
      : {
          totalRecords: 0,
          distinctMaterials: 0,
          distinctBranches: 0,
          totalAvailableStock: 0,
          totalReservedStock: 0,
          totalInventoryValue: 0,
          lowStockCount: 0,
          outOfStockCount: 0,
          overstockCount: 0,
        };

    res.json({
      data: result.data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
      summary,
    });
  } catch (err) {
    console.error("[inventoryController.listInventory]", err);
    res.status(500).json({ message: "Internal server error while fetching inventory." });
  }
}

/**
 * GET /api/inventory/filters
 * Returns distinct values used to populate the filter dropdowns
 * (categories, branches, warehouses, stock statuses) without the
 * frontend having to guess or hardcode them.
 */
async function getFilterOptions(_req, res) {
  try {
    const [branches, warehouses] = await Promise.all([
      Branch.find({ isActive: true }).select("name").sort("name"),
      Warehouse.find({ isActive: true }).select("name").sort("name"),
    ]);

    res.json({
      branches: branches.map((b) => b.name),
      warehouses: warehouses.map((w) => w.name),
      stockStatuses: STOCK_STATUSES,
    });
  } catch (err) {
    console.error("[inventoryController.getFilterOptions]", err);
    res.status(500).json({ message: "Internal server error while fetching filter options." });
  }
}

/**
 * GET /api/inventory/:id
 * Single inventory record with material/branch/warehouse populated —
 * used for a future row-detail view.
 */
async function getInventoryById(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid inventory record id." });
    }

    const record = await Inventory.findById(req.params.id)
      .populate("materialId")
      .populate("branchId")
      .populate("warehouseId");

    if (!record) {
      return res.status(404).json({ message: "Inventory record not found." });
    }

    res.json({ record });
  } catch (err) {
    console.error("[inventoryController.getInventoryById]", err);
    res.status(500).json({ message: "Internal server error while fetching the inventory record." });
  }
}

module.exports = { listInventory, getFilterOptions, getInventoryById };
