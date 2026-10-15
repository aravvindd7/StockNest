/**
 * Distribution Master — Stage 3: recommendation engine.
 *
 * Deterministic, explainable rules (no ML) that compare, per Material × Depot:
 *   stock             — Stock Master, latest snapshot per Material × Plant,
 *                       summed over the plants mapped to the depot:
 *                         stock in hand  (SIHQty)       — physically present
 *                         current stock  (TotalStockQty = SIH + stock in transit)
 *   forecast demand   — existing ForecastPredictions via depotDemandService
 *                       (Stage 2), summed over the recommendation horizon
 *   safety stock      — DepotSafetyStock (Stage 2)
 *
 *   surplus  = max(0, stockInHand − openCommitments − safetyStock − forecastDemand)
 *   shortage = max(0, forecastDemand + safetyStock − currentStock − openInbound)
 *
 * Open commitments (Stage 4): stock promised to REQUESTED/APPROVED transfers
 * that have not been dispatched yet. Outbound ones are not available at the
 * source again; inbound ones already cover part of the destination's need.
 * DISPATCHED/IN_TRANSIT transfers are NOT counted here — their stock has
 * already left the source's SIH and sits in the destination's SIT (inside
 * TotalStockQty), so counting them again would double-count.
 *   quantity = min(source surplus, destination shortage)
 *
 * Distribution business rule: only stock IN HAND can be shipped, so a
 * source's transferable surplus never counts stock in transit. A
 * destination's shortage uses total stock, because stock already in transit
 * to it will arrive and must not be recommended again. (Planning's stock
 * calculation is unaffected — this rule is Distribution-only.)
 *
 * A depot can never be both a source and a destination for a material:
 * surplus > 0 means SIH − openCommitments > safety + demand, and since
 * total + openInbound ≥ SIH (SIH ≤ total is validated), its shortage is 0.
 * A depot therefore never transfers to itself.
 *
 * Matching (per material, fully deterministic):
 *   destinations by shortage desc, then depotId asc; each destination is
 *   filled from the source with the largest REMAINING surplus (ties: depotId
 *   asc), splitting across sources only when one source cannot cover it.
 *
 * Data quality: a Material × Depot with missing stock, incomplete forecast or
 * missing safety stock is EXCLUDED and reported — never treated as zero. The
 * only zero fallback is safety stock, and only when the caller explicitly
 * passes allowMissingSafetyStock: true (each use is reported).
 *
 * Writes ONLY DistributionRecommendation documents: new PENDING records for
 * this run, and PENDING → SUPERSEDED for the previous suggestions this run
 * re-evaluated. APPROVED/REJECTED history is never touched; nothing is
 * deleted (except this run's own records if its insert fails and is rolled
 * back). No stock moves, no transfers.
 */
const crypto = require("crypto");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const DepotSafetyStock = require("../models/DepotSafetyStock");
const DistributionTransfer = require("../models/DistributionTransfer");
const Material = require("../models/Material");
const Stock = require("../models/Stock");
const depotDemandService = require("./depotDemandService");
const { resolveActivePlantMapping } = require("./depotPlantMappingService");
const { calendarYearOfMonth, finYearStartCalendarYear } = require("../utils/financialYear");
const distributionConfig = require("../config/distribution");

const { DEFAULT_MIN_TRANSFER_QUANTITY } = distributionConfig;

// One quarter — the grain Planning Master works in. Overridable per request.
const DEFAULT_HORIZON_MONTHS = 3;
const MAX_HORIZON_MONTHS = 12;

const norm = (v) => String(v || "").trim().toUpperCase();
const fmt = (n) => Number(n).toLocaleString("en-IN");

// ─── Pure calculations ───────────────────────────────────────────────────────

/** Transferable surplus — stock IN HAND only; stock in transit cannot be shipped. */
function calculateSurplus({ stockInHand, safetyStock, forecastDemand, openCommitments = 0 }) {
  return Math.max(0, stockInHand - openCommitments - safetyStock - forecastDemand);
}

function calculateShortage({ currentStock, safetyStock, forecastDemand, openInbound = 0 }) {
  return Math.max(0, forecastDemand + safetyStock - currentStock - openInbound);
}

/** Share of the destination's requirement (demand + safety stock) that is uncovered. */
function priorityFor(destination) {
  const requirement = destination.forecastDemand + destination.safetyStock;
  const uncovered = requirement > 0 ? destination.shortage / requirement : 0;
  if (destination.currentStock < destination.safetyStock || uncovered >= 0.5) return "CRITICAL";
  if (uncovered >= 0.25) return "HIGH";
  if (uncovered >= 0.1) return "MEDIUM";
  return "LOW";
}

/** "October 2026 – December 2026" (calendar months, from FY-labelled forecast months). */
function periodLabel(months) {
  if (!months.length) return "";
  const label = ({ month, financialYear }) => `${month} ${calendarYearOfMonth(month, finYearStartCalendarYear(financialYear))}`;
  const first = label(months[0]);
  const last = label(months[months.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

function buildReason({ materialNo, source, destination, quantity, uncoveredAfter, months }) {
  const name = (p) => (p.depotName ? `${p.depotId} (${p.depotName})` : p.depotId);
  const parts = [
    `${name(destination)} needs ${fmt(destination.shortage)} more units of ${materialNo} for ${periodLabel(months)}: forecast demand ${fmt(destination.forecastDemand)} + safety stock ${fmt(destination.safetyStock)} vs current stock ${fmt(destination.currentStock)}`
      + `${destination.openInbound ? ` + ${fmt(destination.openInbound)} already on open inbound transfers.` : "."}`,
    `${name(source)} can spare ${fmt(source.surplus)}: stock in hand ${fmt(source.stockInHand)}${source.openCommitments ? ` − ${fmt(source.openCommitments)} committed to open transfers` : ""} − safety stock ${fmt(source.safetyStock)} − own forecast demand ${fmt(source.forecastDemand)}`
      + `${source.currentStock > source.stockInHand ? ` (${fmt(source.currentStock - source.stockInHand)} more in transit, not transferable).` : "."}`,
    `Recommend ${fmt(quantity)}${uncoveredAfter > 0 ? ` (${fmt(uncoveredAfter)} of the destination's shortage still uncovered after this transfer).` : "."}`,
  ];
  return parts.join(" ");
}

/** Adds surplus/shortage/role to raw positions. */
function buildPositions(rawPositions) {
  return rawPositions.map((p) => {
    const surplus = calculateSurplus(p);
    const shortage = calculateShortage(p);
    return { ...p, surplus, shortage, role: surplus > 0 ? "SOURCE" : shortage > 0 ? "DESTINATION" : "BALANCED" };
  });
}

/**
 * Deterministic greedy matching for one material.
 *
 * Minimum transfer quantity (config/distribution.js): an allocation smaller
 * than minTransferQuantity is not created and never rounded up. The source's
 * surplus is NOT consumed by a filtered allocation (it stays available to
 * other destinations), and the destination's remaining need is reported as
 * unfulfilled. Because candidates are ordered by remaining surplus and the
 * quantity is min(remaining, need), once the best candidate is below the
 * minimum every other candidate is too — so matching for that destination
 * stops there, and the filtered opportunity is reported.
 *
 * Each filtered entry carries sourceRemainingSurplus: the source's surplus
 * still unallocated at the moment the opportunity was filtered. Because a
 * filtered allocation does not consume it, the SAME remaining surplus can
 * appear against several destinations — it is context for each entry, not a
 * quantity to add up across entries.
 *
 * Returns { matches: [{ source, destination, quantity, uncoveredAfter }], unfulfilled: [...], filtered: [...] }.
 */
function matchMaterial(positions, { minTransferQuantity = DEFAULT_MIN_TRANSFER_QUANTITY } = {}) {
  const byDepot = (a, b) => a.depotId.localeCompare(b.depotId);
  const destinations = positions.filter((p) => p.shortage > 0).sort((a, b) => b.shortage - a.shortage || byDepot(a, b));
  const sources = positions.filter((p) => p.surplus > 0);
  const remaining = new Map(sources.map((s) => [s.depotId, s.surplus]));
  const matches = [];
  const unfulfilled = [];
  const filtered = [];

  destinations.forEach((destination) => {
    let need = destination.shortage;
    while (need > 0) {
      const candidates = sources
        .filter((s) => s.depotId !== destination.depotId && remaining.get(s.depotId) > 0)
        .sort((a, b) => remaining.get(b.depotId) - remaining.get(a.depotId) || byDepot(a, b));
      if (!candidates.length) break;
      const source = candidates[0];
      const quantity = Math.min(remaining.get(source.depotId), need);
      if (quantity < minTransferQuantity) {
        filtered.push({
          materialNo: destination.materialNo, sourceDepotId: source.depotId, destinationDepotId: destination.depotId,
          quantity, sourceRemainingSurplus: remaining.get(source.depotId), minTransferQuantity, reason: "MIN_TRANSFER_QUANTITY",
        });
        break;
      }
      remaining.set(source.depotId, remaining.get(source.depotId) - quantity);
      need -= quantity;
      matches.push({ source, destination, quantity, uncoveredAfter: need });
    }
    if (need > 0) {
      unfulfilled.push({ materialNo: destination.materialNo, depotId: destination.depotId, shortage: destination.shortage, covered: destination.shortage - need, uncovered: need });
    }
  });
  return { matches, unfulfilled, filtered };
}

// ─── Input loading & validation ──────────────────────────────────────────────

/**
 * Builds every evaluable Material × Depot position and records why anything
 * else was excluded. Pure reads.
 */
async function loadPositions({ horizonMonths, materialNos, allowMissingSafetyStock }, now) {
  const [demand, mapping, materials, stockRows, safetyRows, openTransfers] = await Promise.all([
    depotDemandService.getDepotDemand({ horizonMonths }, now),
    resolveActivePlantMapping(),
    Material.find({}).select("materialNo status isActive").lean(),
    Stock.find({}).select("MatNo PlantName TotalStockQty SIHQty StockDate").lean(),
    DepotSafetyStock.find({}).lean(),
    DistributionTransfer.find({ status: { $in: ["REQUESTED", "APPROVED"] } })
      .select("materialNo sourceDepotId destinationDepotId status requestedQuantity approvedQuantity").lean(),
  ]);

  const months = demand.window.months;
  if (!months.length) {
    const err = new Error("No forecast window is available — Sales Master and ForecastPredictions are empty.");
    err.status = 422;
    throw err;
  }
  if (months.length < horizonMonths) {
    const err = new Error(`horizonMonths (${horizonMonths}) exceeds the current forecast window (${months.length} months).`);
    err.status = 422;
    throw err;
  }

  const skipped = [];
  const warnings = {};
  const { plantToDepot, depotNames, depotsWithoutActiveMapping } = mapping;

  // ---- Materials ----
  const materialByNo = new Map(materials.map((m) => [norm(m.materialNo), m]));
  const isOperational = (m) => m && m.isActive && m.status !== "Discontinued";
  const dataMaterials = new Set([...stockRows.map((s) => norm(s.MatNo)), ...demand.data.map((r) => r.materialNo)]);
  let candidates;
  if (materialNos) {
    candidates = materialNos;
  } else {
    candidates = [...new Set([...materials.filter(isOperational).map((m) => norm(m.materialNo)), ...dataMaterials])];
  }
  const evaluatedMaterials = [];
  candidates.sort().forEach((materialNo) => {
    const material = materialByNo.get(materialNo);
    if (!material) skipped.push({ materialNo, depotId: null, reasons: ["MATERIAL_NOT_FOUND"] });
    else if (!isOperational(material)) skipped.push({ materialNo, depotId: null, reasons: ["MATERIAL_INACTIVE"] });
    else evaluatedMaterials.push(materialNo);
  });

  // ---- Depots ----
  const mappedDepots = [...new Set(plantToDepot.values())].sort();
  depotsWithoutActiveMapping.forEach((depotId) => skipped.push({ materialNo: null, depotId, reasons: ["DEPOT_NOT_MAPPED"] }));

  // ---- Stock: latest snapshot per Material × Plant, summed per depot ----
  const latestByMatPlant = new Map();
  stockRows.forEach((row) => {
    const key = `${norm(row.MatNo)}|${row.PlantName}`;
    const at = row.StockDate ? new Date(row.StockDate).getTime() : 0;
    const entry = latestByMatPlant.get(key);
    if (!entry || at > entry.at) latestByMatPlant.set(key, { at, rows: [row] });
    else if (at === entry.at) entry.rows.push(row);
  });
  const stockByMatDepot = new Map();
  const invalidStock = new Set();
  const unmappedStockPlants = new Map();
  latestByMatPlant.forEach(({ rows }, key) => {
    const [materialNo, plant] = key.split("|");
    const depotId = plantToDepot.get(plant);
    if (!depotId) {
      unmappedStockPlants.set(plant, (unmappedStockPlants.get(plant) || 0) + rows.length);
      return;
    }
    const k = `${materialNo}|${depotId}`;
    rows.forEach((r) => {
      const total = Number(r.TotalStockQty);
      const inHand = Number(r.SIHQty);
      const valid = (q) => Number.isFinite(q) && q >= 0 && Number.isInteger(q);
      // Stock in hand can never exceed total stock (total = in hand + in transit).
      if (!valid(total) || !valid(inHand) || inHand > total) invalidStock.add(k);
      else {
        const acc = stockByMatDepot.get(k) || { total: 0, inHand: 0 };
        stockByMatDepot.set(k, { total: acc.total + total, inHand: acc.inHand + inHand });
      }
    });
  });
  if (unmappedStockPlants.size) warnings.unmappedStockPlants = [...unmappedStockPlants].map(([plantName, rows]) => ({ plantName, rows }));

  // ---- Forecast demand: every horizon month must be present and complete ----
  const forecastByMatDepot = new Map();
  demand.data.forEach((row) => {
    const k = `${row.materialNo}|${row.depotId}`;
    const f = forecastByMatDepot.get(k) || { months: 0, complete: 0, total: 0 };
    f.months += 1;
    if (row.complete) f.complete += 1;
    f.total += row.forecastDemand;
    forecastByMatDepot.set(k, f);
  });

  // ---- Open commitments: REQUESTED → requested qty, APPROVED → approved qty (each transfer counted once) ----
  const outbound = new Map();
  const inbound = new Map();
  openTransfers.forEach((t) => {
    const qty = t.status === "APPROVED" ? t.approvedQuantity : t.requestedQuantity;
    const out = `${norm(t.materialNo)}|${norm(t.sourceDepotId)}`;
    const inn = `${norm(t.materialNo)}|${norm(t.destinationDepotId)}`;
    outbound.set(out, (outbound.get(out) || 0) + qty);
    inbound.set(inn, (inbound.get(inn) || 0) + qty);
  });

  // ---- Safety stock ----
  const safetyByMatDepot = new Map(safetyRows.map((s) => [`${norm(s.materialNo)}|${norm(s.depotId)}`, s]));

  // ---- Positions ----
  const raw = [];
  const zeroFallbacks = [];
  evaluatedMaterials.forEach((materialNo) => {
    mappedDepots.forEach((depotId) => {
      const k = `${materialNo}|${depotId}`;
      const reasons = [];
      if (invalidStock.has(k)) reasons.push("INVALID_STOCK");
      else if (!stockByMatDepot.has(k)) reasons.push("MISSING_STOCK");

      const f = forecastByMatDepot.get(k);
      if (!f || f.months < months.length || f.complete < months.length) reasons.push("MISSING_FORECAST");

      const ss = safetyByMatDepot.get(k);
      const ssValid = ss && ss.status !== "ERROR" && Number.isInteger(ss.safetyStock) && ss.safetyStock >= 0;
      if (!ssValid && !allowMissingSafetyStock) reasons.push("MISSING_SAFETY_STOCK");

      if (reasons.length) {
        skipped.push({ materialNo, depotId, reasons, ...(f ? { forecastMonthsAvailable: f.complete, forecastMonthsRequired: months.length } : {}) });
        return;
      }
      if (!ssValid) zeroFallbacks.push({ materialNo, depotId });
      raw.push({
        materialNo,
        depotId,
        depotName: depotNames.get(depotId) || null,
        currentStock: stockByMatDepot.get(k).total,
        stockInHand: stockByMatDepot.get(k).inHand,
        stockInTransit: stockByMatDepot.get(k).total - stockByMatDepot.get(k).inHand,
        openCommitments: outbound.get(k) || 0,
        openInbound: inbound.get(k) || 0,
        safetyStock: ssValid ? ss.safetyStock : 0,
        safetyStockSource: ssValid ? "DEPOT_SAFETY_STOCK" : "ZERO_FALLBACK",
        // Conservative whole units: demand is rounded UP for every depot.
        forecastDemand: Math.ceil(f.total - 1e-9),
      });
    });
  });
  if (zeroFallbacks.length) warnings.safetyStockZeroFallback = zeroFallbacks;

  // Demand-side integrity from Stage 2, passed through as-is.
  const i = demand.integrity;
  if (i.unmappedPlants.length) warnings.unmappedForecastPlants = i.unmappedPlants;
  if (i.inactiveMappingPlants.length) warnings.inactiveMappingPlants = i.inactiveMappingPlants;
  if (i.mappingsToUnknownDepots.length) warnings.mappingsToUnknownDepots = i.mappingsToUnknownDepots;
  if (i.unknownOrInactiveMaterials.length) warnings.forecastsForUnknownOrInactiveMaterials = i.unknownOrInactiveMaterials;
  if (i.excludedForecastMonths.length) warnings.excludedForecastMonths = i.excludedForecastMonths;
  if (!evaluatedMaterials.length) warnings.noEvaluableMaterials = true;

  return { months, positions: buildPositions(raw), evaluatedMaterials, skipped, warnings };
}

// ─── Generation ──────────────────────────────────────────────────────────────

let generationInProgress = false;

function newRunId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `DRUN-${stamp}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/**
 * @param {object} options  horizonMonths?, materialNos?, dryRun?, allowMissingSafetyStock?
 * @param {object} context  { now, user, sourceVersions? } — sourceVersions (optional) is
 *   stamped on each record as inputVersions: the source/forecast versions this run used.
 *
 * Only writing runs take the single-run lock; a dry run (Network Analysis) only
 * reads, so it may run alongside a writing run.
 */
async function generateRecommendations(options = {}, { now = new Date(), user = "system", sourceVersions } = {}) {
  const dryRun = Boolean(options.dryRun);
  if (!dryRun) {
    if (generationInProgress) {
      const err = new Error("A recommendation generation run is already in progress.");
      err.status = 409;
      throw err;
    }
    generationInProgress = true;
  }
  try {
    const horizonMonths = options.horizonMonths || DEFAULT_HORIZON_MONTHS;
    const allowMissingSafetyStock = Boolean(options.allowMissingSafetyStock);
    const materialNos = options.materialNos ? [...new Set(options.materialNos.map(norm))] : null;

    const { months, positions, evaluatedMaterials, skipped, warnings } = await loadPositions({ horizonMonths, materialNos, allowMissingSafetyStock }, now);
    const forecastPeriod = { financialYear: months[0].financialYear, startMonth: months[0].month, horizonMonths };
    const generationRunId = newRunId(now);
    const generatedAt = now;

    // ---- Match ----
    const docs = [];
    const unfulfilledShortages = [];
    const filteredRecommendations = [];
    const minTransferByMaterial = {};
    evaluatedMaterials.forEach((materialNo) => {
      const minTransferQuantity = distributionConfig.resolveMinTransferQuantity(materialNo);
      minTransferByMaterial[materialNo] = minTransferQuantity;
      const { matches, unfulfilled, filtered } = matchMaterial(positions.filter((p) => p.materialNo === materialNo), { minTransferQuantity });
      unfulfilledShortages.push(...unfulfilled);
      filteredRecommendations.push(...filtered);
      matches.forEach(({ source, destination, quantity, uncoveredAfter }) => {
        docs.push({
          materialNo,
          sourceDepotId: source.depotId,
          destinationDepotId: destination.depotId,
          forecastPeriod,
          sourceCurrentStock: source.currentStock,
          sourceStockInHand: source.stockInHand,
          sourceOpenCommitments: source.openCommitments,
          sourceSafetyStock: source.safetyStock,
          sourceForecastDemand: source.forecastDemand,
          sourceSurplus: source.surplus,
          destinationCurrentStock: destination.currentStock,
          destinationSafetyStock: destination.safetyStock,
          destinationForecastDemand: destination.forecastDemand,
          destinationShortage: destination.shortage,
          destinationOpenInbound: destination.openInbound,
          recommendedQuantity: quantity,
          priority: priorityFor(destination),
          reason: buildReason({ materialNo, source, destination, quantity, uncoveredAfter, months }),
          generatedAt,
          generationRunId,
          generatedBy: user,
          status: "PENDING",
          ...(sourceVersions ? { inputVersions: sourceVersions } : {}),
        });
      });
    });

    // Every document must pass the model's own rules before anything is written.
    // validate() (not validateSync) so the cross-field pre("validate") rules run too.
    for (const d of docs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new DistributionRecommendation(d).validate();
      } catch (err) {
        throw new Error(`Engine produced an invalid recommendation (${d.materialNo} ${d.sourceDepotId}→${d.destinationDepotId}): ${err.message}`);
      }
    }

    // ---- Supersede scope: PENDING suggestions for the same forecast period
    // whose material AND both depots were fully re-evaluated in this run.
    const depotsByMaterial = new Map();
    positions.forEach((p) => {
      if (!depotsByMaterial.has(p.materialNo)) depotsByMaterial.set(p.materialNo, []);
      depotsByMaterial.get(p.materialNo).push(p.depotId);
    });
    const supersedeFilter = depotsByMaterial.size
      ? {
          status: "PENDING",
          "forecastPeriod.financialYear": forecastPeriod.financialYear,
          "forecastPeriod.startMonth": forecastPeriod.startMonth,
          $or: [...depotsByMaterial].map(([materialNo, depots]) => ({ materialNo, sourceDepotId: { $in: depots }, destinationDepotId: { $in: depots } })),
        }
      : null;

    let supersededCount = 0;
    let created = [];
    if (dryRun) {
      supersededCount = supersedeFilter ? await DistributionRecommendation.countDocuments(supersedeFilter) : 0;
    } else {
      if (supersedeFilter) {
        const r = await DistributionRecommendation.updateMany(supersedeFilter, {
          $set: { status: "SUPERSEDED", supersededByRunId: generationRunId, supersededAt: generatedAt },
        });
        supersededCount = r.modifiedCount || 0;
      }
      try {
        created = docs.length ? await DistributionRecommendation.insertMany(docs, { ordered: true }) : [];
      } catch (err) {
        // Roll back this run: remove its partial inserts and restore what it superseded.
        await DistributionRecommendation.deleteMany({ generationRunId });
        await DistributionRecommendation.updateMany(
          { supersededByRunId: generationRunId, status: "SUPERSEDED" },
          { $set: { status: "PENDING" }, $unset: { supersededByRunId: "", supersededAt: "" } }
        );
        throw err;
      }
    }

    // PENDING suggestions this run could not re-evaluate stay as they were — report them.
    const stillPendingFilter = { status: "PENDING", generationRunId: { $ne: generationRunId } };
    const stalePending = await DistributionRecommendation.countDocuments(stillPendingFilter);
    const stalePendingAfter = dryRun ? stalePending - supersededCount : stalePending;
    if (stalePendingAfter > 0) warnings.pendingRecommendationsNotReevaluated = stalePendingAfter;

    const strip = ({ materialNo, depotId, depotName, currentStock, stockInHand, stockInTransit, openCommitments, openInbound, safetyStock, safetyStockSource, forecastDemand, surplus, shortage }) =>
      ({ materialNo, depotId, depotName, currentStock, stockInHand, stockInTransit, openCommitments, openInbound, safetyStock, safetyStockSource, forecastDemand, surplus, shortage });
    return {
      generationRunId,
      dryRun,
      generatedAt,
      forecastPeriod,
      forecastMonths: months,
      materialsEvaluated: evaluatedMaterials.length,
      positionsEvaluated: positions.length,
      sourcePositions: positions.filter((p) => p.role === "SOURCE").map(strip),
      destinationPositions: positions.filter((p) => p.role === "DESTINATION").map(strip),
      balancedPositions: positions.filter((p) => p.role === "BALANCED").length,
      recommendationsCreated: dryRun ? 0 : created.length,
      recommendations: dryRun ? docs : created.map((d) => (d.toObject ? d.toObject() : d)),
      totalRecommendedQuantity: docs.reduce((s, d) => s + d.recommendedQuantity, 0),
      // Uniform today; per material once a material-level override exists.
      minTransferQuantity: [...new Set(Object.values(minTransferByMaterial))].length <= 1
        ? (Object.values(minTransferByMaterial)[0] ?? distributionConfig.getGlobalMinTransferQuantity()) : minTransferByMaterial,
      recommendationsFiltered: filteredRecommendations.length,
      filteredRecommendations,
      supersededCount,
      unfulfilledShortages,
      skipped,
      dataQualityWarnings: warnings,
    };
  } finally {
    if (!dryRun) generationInProgress = false;
  }
}

module.exports = {
  DEFAULT_HORIZON_MONTHS,
  MAX_HORIZON_MONTHS,
  calculateSurplus,
  calculateShortage,
  priorityFor,
  buildPositions,
  matchMaterial,
  buildReason,
  loadPositions,
  generateRecommendations,
};
