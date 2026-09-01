const mongoose = require("mongoose");
const Depot = require("../models/Depot");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { buildMongoFilter, buildSort, getDistinctValues } = require("../utils/queryFilterBuilder");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEPOT_SORTABLE_FIELDS = ["depotId", "depotName", "createdAt"];

// Every visible Depot Master column is filterable. Location/Region/Status
// aren't — Depot Master was deliberately locked to depotId + depotName in
// an earlier update, so there's no such data to filter on.
const DEPOT_FILTER_CONFIG = [
  { dbField: "depotId", type: "text" },
  { dbField: "depotName", type: "text" },
];

/**
 * GET /api/depots — Admin only.
 * search matches depotId/depotName; depotId and depotName also support
 * Excel-style multiselect (comma-separated) via the global column filter
 * system. Depot Master has no Location/Region/Status fields (it's
 * intentionally limited to depotId + depotName), so those filters
 * mentioned in the upgrade spec aren't implemented — there's no data to
 * filter on without adding fields Depot Master was explicitly locked to
 * exclude in an earlier update.
 */
async function listDepots(req, res) {
  try {
    const { search, page = 1, limit = 100 } = req.query;
    const query = {};

    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ depotId: rx }, { depotName: rx }];
    }
    Object.assign(
      query,
      buildMongoFilter(req.query, DEPOT_FILTER_CONFIG)
    );

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const sort = buildSort(req.query, DEPOT_SORTABLE_FIELDS, "depotId");

    const [data, total] = await Promise.all([
      Depot.find(query).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum),
      Depot.countDocuments(query),
    ]);

    res.json({
      data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("[depotController.listDepots]", err);
    res.status(500).json({ message: "Internal server error while fetching depots." });
  }
}

const DEPOT_FILTERABLE_FIELDS = new Set(DEPOT_FILTER_CONFIG.map((f) => f.dbField));
/** GET /api/depots/filter-values?field=depotId&search= — live options for a column filter popup. */
async function getDepotFilterValues(req, res) {
  try {
    const { field, search } = req.query;
    if (!DEPOT_FILTERABLE_FIELDS.has(field)) {
      return res.status(400).json({ message: `Field "${field}" is not filterable.` });
    }
    const values = await getDistinctValues(Depot, field, search);
    res.json({ values });
  } catch (err) {
    console.error("[depotController.getDepotFilterValues]", err);
    res.status(500).json({ message: "Internal server error while fetching filter values." });
  }
}

/** GET /api/depots/:id */
async function getDepotById(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid depot id." });
    }
    const depot = await Depot.findById(req.params.id);
    if (!depot) return res.status(404).json({ message: "Depot not found." });
    res.json({ depot });
  } catch (err) {
    console.error("[depotController.getDepotById]", err);
    res.status(500).json({ message: "Internal server error while fetching the depot." });
  }
}

function validateDepotInput(body) {
  const errors = [];
  if (!String(body.depotId || "").trim()) errors.push("Depot ID is required.");
  if (!String(body.depotName || "").trim()) errors.push("Depot Name is required.");
  return errors;
}

/**
 * POST /api/depots — Admin only.
 * Validates required fields, checks Depot ID uniqueness at the
 * application level (fast, friendly error message), and relies on the
 * MongoDB unique index as the authoritative enforcement (Section 2 —
 * uniqueness must not depend on frontend validation alone).
 */
async function createDepot(req, res) {
  try {
    const body = req.body || {};
    const errors = validateDepotInput(body);
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const depotId = String(body.depotId).trim().toUpperCase();
    const existing = await Depot.findOne({ depotId });
    if (existing) {
      return res.status(409).json({ message: "A depot with this Depot ID already exists." });
    }

    const depot = await Depot.create({
      depotId,
      depotName: String(body.depotName).trim(),
    });

    res.status(201).json({ depot });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "A depot with this Depot ID already exists." });
    }
    console.error("[depotController.createDepot]", err);
    res.status(500).json({ message: "Internal server error while creating the depot." });
  }
}

/**
 * PUT /api/depots/:id — Admin only.
 * Depot ID is editable (with uniqueness re-checked) rather than locked,
 * since nothing yet references depotId as a foreign key (Section 7 — no
 * inventory relationship exists in this implementation). If/when Inventory
 * starts referencing depotId, revisit this to decide whether it should
 * become immutable like Material.materialNo.
 */
async function updateDepot(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid depot id." });
    }

    const body = req.body || {};
    const errors = validateDepotInput(body);
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const depot = await Depot.findById(req.params.id);
    if (!depot) return res.status(404).json({ message: "Depot not found." });

    const newDepotId = String(body.depotId).trim().toUpperCase();
    if (newDepotId !== depot.depotId) {
      const existing = await Depot.findOne({ depotId: newDepotId, _id: { $ne: depot._id } });
      if (existing) {
        return res.status(409).json({ message: "A depot with this Depot ID already exists." });
      }
    }

    depot.depotId = newDepotId;
    depot.depotName = String(body.depotName).trim();

    await depot.save();
    res.json({ depot });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "A depot with this Depot ID already exists." });
    }
    console.error("[depotController.updateDepot]", err);
    res.status(500).json({ message: "Internal server error while updating the depot." });
  }
}

/**
 * DELETE /api/depots/:id — Admin only. Hard delete for now — there is no
 * Inventory relationship yet to protect against (Section 8/"Important
 * future compatibility"). When Inventory starts referencing depotId, add
 * a check here that blocks deletion of a depot still in use.
 */
async function deleteDepot(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid depot id." });
    }
    const depot = await Depot.findById(req.params.id);
    if (!depot) return res.status(404).json({ message: "Depot not found." });

    await depot.deleteOne();
    res.json({ message: "Depot deleted.", depotId: depot.depotId });
  } catch (err) {
    console.error("[depotController.deleteDepot]", err);
    res.status(500).json({ message: "Internal server error while deleting the depot." });
  }
}

/** GET /api/depots/export — the active Depot Master dataset as a real .xlsx file. */
async function exportDepots(req, res) {
  try {
    const { search } = req.query;
    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ depotId: rx }, { depotName: rx }];
    }
    Object.assign(
      query,
      buildMongoFilter(req.query, DEPOT_FILTER_CONFIG)
    );

    const depots = await Depot.find(query).sort("depotId").lean();
    const columns = [
      { key: "depotId", label: "Depot ID" },
      { key: "depotName", label: "Depot Name" },
    ];
    const buffer = buildXlsxBuffer(columns, depots);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="depot_master.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("[depotController.exportDepots]", err);
    res.status(500).json({ message: "Internal server error while exporting depots." });
  }
}

module.exports = { listDepots, getDepotFilterValues, getDepotById, createDepot, updateDepot, deleteDepot, exportDepots };
