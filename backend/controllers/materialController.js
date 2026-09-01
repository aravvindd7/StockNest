const mongoose = require("mongoose");
const Material = require("../models/Material");
const { buildXlsxBuffer } = require("../utils/xlsxExport");
const { buildMongoFilter, getDistinctValues } = require("../utils/queryFilterBuilder");

// Every visible Material Master column is filterable ("Filtering
// Philosophy": if a user can see a column, they can filter it). Status/
// Type get "text" too — its default "Select Values" mode behaves as a
// dropdown for these small enums, while Contains/Starts With still work
// if ever useful. Description isn't part of the 7 business fields'
// dedicated dropdown data but is still text-filterable like the rest.
const MATERIAL_FILTER_CONFIG = [
  { dbField: "materialNo", type: "text" },
  { dbField: "description", type: "text" },
  { dbField: "model", type: "text" },
  { dbField: "status", type: "text" },
  { dbField: "type", type: "text" },
  { dbField: "invCost", type: "number" },
  { dbField: "moq", type: "number" },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SORTABLE_FIELDS = new Set(["materialNo", "description", "model", "status", "invCost", "moq", "type", "updatedAt"]);

/**
 * GET /api/materials — Admin only.
 * Query params: search (materialNo/description/model), status, type,
 * materialNo, model (each comma-separated for multiselect), priceMin,
 * priceMax (on invCost), page, limit, sortBy, sortDir.
 */
async function listMaterials(req, res) {
  try {
    const {
      search,
      page = 1,
      limit = 25,
      sortBy = "materialNo",
      sortDir = "asc",
    } = req.query;

    const query = { isActive: true };

    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
    }

    // Global column-filter system (Excel-style multiselect via comma-
    // separated values). A plain single value (e.g. from the existing
    // Status dropdown) works the same way — splitting "STD" on "," just
    // yields ["STD"], so this one code path covers both UIs.
    Object.assign(
      query,
      buildMongoFilter(req.query, MATERIAL_FILTER_CONFIG)
    );

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
    const sortField = SORTABLE_FIELDS.has(sortBy) ? sortBy : "materialNo";
    const sortDirection = sortDir === "desc" ? -1 : 1;

    const [data, total] = await Promise.all([
      Material.find(query)
        .sort({ [sortField]: sortDirection, _id: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Material.countDocuments(query),
    ]);

    res.json({
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    console.error("[materialController.listMaterials]", err);
    res.status(500).json({ message: "Internal server error while fetching materials." });
  }
}

/** GET /api/materials/filters — Status/Type are fixed enums; also returns distinct Models as a search aid. */
async function getMaterialFilterOptions(_req, res) {
  try {
    const { STATUS_VALUES, TYPE_VALUES } = require("../models/Material");
    const models = await Material.distinct("model", { isActive: true, model: { $ne: "" } });
    res.json({
      statuses: STATUS_VALUES,
      types: TYPE_VALUES,
      models: models.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error("[materialController.getMaterialFilterOptions]", err);
    res.status(500).json({ message: "Internal server error while fetching filter options." });
  }
}

/**
 * GET /api/materials/filter-values?field=materialNo&search=MAT — Admin only.
 * Live distinct-value lookup that feeds a column filter popup's checkbox
 * list. Shared shape reused by every module (see queryFilterBuilder.js).
 */
const MATERIAL_FILTERABLE_FIELDS = new Set(MATERIAL_FILTER_CONFIG.filter((f) => f.type === "text").map((f) => f.dbField));
async function getMaterialFilterValues(req, res) {
  try {
    const { field, search } = req.query;
    if (!MATERIAL_FILTERABLE_FIELDS.has(field)) {
      return res.status(400).json({ message: `Field "${field}" is not filterable.` });
    }
    const values = await getDistinctValues(Material, field, search, { isActive: true });
    res.json({ values });
  } catch (err) {
    console.error("[materialController.getMaterialFilterValues]", err);
    res.status(500).json({ message: "Internal server error while fetching filter values." });
  }
}

/** GET /api/materials/:id */
async function getMaterialById(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid material id." });
    }
    const material = await Material.findById(req.params.id);
    if (!material || !material.isActive) {
      return res.status(404).json({ message: "Material not found." });
    }
    res.json({ material });
  } catch (err) {
    console.error("[materialController.getMaterialById]", err);
    res.status(500).json({ message: "Internal server error while fetching the material." });
  }
}

/**
 * POST /api/materials — Admin only.
 * Workflow per Section 14: frontend validation -> backend validation ->
 * duplicate Material No check -> save -> (frontend refreshes the table).
 */
async function createMaterial(req, res) {
  try {
    const body = req.body || {};
    const errors = validateMaterialInput(body, { isCreate: true });
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const materialNo = String(body.materialNo).trim().toUpperCase();
    const existing = await Material.findOne({ materialNo, isActive: true });
    if (existing) {
      return res.status(409).json({ message: `Material No "${materialNo}" already exists.` });
    }

    const material = await Material.create({
      materialNo,
      description: body.description.trim(),
      model: (body.model || "").trim(),
      status: body.status,
      invCost: Number(body.invCost),
      moq: Number(body.moq),
      type: body.type,
    });

    res.status(201).json({ material });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Material No already exists." });
    }
    console.error("[materialController.createMaterial]", err);
    res.status(500).json({ message: "Internal server error while creating the material." });
  }
}

/**
 * PUT /api/materials/:id — Admin only.
 * Material No is intentionally ignored even if present in the body —
 * it is not editable after creation (Section 15).
 */
async function updateMaterial(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid material id." });
    }

    const body = req.body || {};
    const errors = validateMaterialInput(body, { isCreate: false });
    if (errors.length) return res.status(400).json({ message: "Validation failed.", errors });

    const material = await Material.findById(req.params.id);
    if (!material || !material.isActive) {
      return res.status(404).json({ message: "Material not found." });
    }

    material.description = body.description.trim();
    material.model = (body.model || "").trim();
    material.status = body.status;
    material.invCost = Number(body.invCost);
    material.moq = Number(body.moq);
    material.type = body.type;

    await material.save();
    res.json({ material });
  } catch (err) {
    console.error("[materialController.updateMaterial]", err);
    res.status(500).json({ message: "Internal server error while updating the material." });
  }
}

/**
 * DELETE /api/materials/:id — Admin only. Soft delete (isActive: false)
 * per Section 16's preference over hard-destroying the record.
 */
async function deleteMaterial(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid material id." });
    }
    const material = await Material.findById(req.params.id);
    if (!material || !material.isActive) {
      return res.status(404).json({ message: "Material not found." });
    }
    material.isActive = false;
    await material.save();
    res.json({ message: "Material deactivated.", materialId: material._id });
  } catch (err) {
    console.error("[materialController.deleteMaterial]", err);
    res.status(500).json({ message: "Internal server error while deleting the material." });
  }
}

/** GET /api/materials/export — the active Material Master dataset as a real .xlsx file. */
async function exportMaterials(req, res) {
  try {
    const { search } = req.query;

    const query = { isActive: true };
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ materialNo: rx }, { description: rx }, { model: rx }];
    }
    Object.assign(
      query,
      buildMongoFilter(req.query, MATERIAL_FILTER_CONFIG)
    );

    const materials = await Material.find(query).sort("materialNo").lean();

    const columns = [
      { key: "materialNo", label: "Material No" },
      { key: "description", label: "Description" },
      { key: "model", label: "Model" },
      { key: "status", label: "STD/Discontinued" },
      { key: "invCost", label: "Inv Cost" },
      { key: "moq", label: "MOQ" },
      { key: "type", label: "FG/RM" },
    ];

    const buffer = buildXlsxBuffer(columns, materials);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="material_master.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("[materialController.exportMaterials]", err);
    res.status(500).json({ message: "Internal server error while exporting materials." });
  }
}

/** Shared validation for create/update (Section 14's rules), limited to the 7 business fields. */
function validateMaterialInput(body, { isCreate }) {
  const errors = [];
  if (isCreate && !String(body.materialNo || "").trim()) errors.push("Material No is required.");
  if (!String(body.description || "").trim()) errors.push("Description is required.");

  const { STATUS_VALUES, TYPE_VALUES } = require("../models/Material");
  if (!STATUS_VALUES.includes(body.status)) errors.push(`Status must be one of: ${STATUS_VALUES.join(", ")}.`);
  if (!TYPE_VALUES.includes(body.type)) errors.push(`Type must be one of: ${TYPE_VALUES.join(", ")}.`);

  const cost = Number(body.invCost);
  if (body.invCost === undefined || body.invCost === "" || Number.isNaN(cost) || cost < 0) {
    errors.push("Inv Cost must be a non-negative number.");
  }

  const moq = Number(body.moq);
  if (body.moq === undefined || body.moq === "" || Number.isNaN(moq) || moq <= 0) {
    errors.push("MOQ must be a positive number.");
  }

  return errors;
}

module.exports = {
  listMaterials,
  getMaterialFilterOptions,
  getMaterialFilterValues,
  getMaterialById,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  exportMaterials,
};
