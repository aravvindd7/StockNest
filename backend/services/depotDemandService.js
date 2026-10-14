/**
 * Depot demand — Distribution Stage 2 (read-only).
 *
 * Turns the EXISTING Material × Plant × Month forecasts (ForecastPredictions,
 * produced by the existing ML pipeline) into Material × Depot × Month demand
 * through the active DepotPlantMapping. There is no second forecasting
 * pipeline: this only reads, translates and sums stored predictions.
 *
 * Window: the same rolling horizon rule forecast generation uses (the month
 * after the latest actual Sales month → end of the working quarter + 2;
 * utils/forecastTargets.planForecastHorizonRange). Stored predictions outside
 * that window (already-actual months, or beyond it) are excluded and
 * reported; window months with no prediction are reported as missing, never
 * filled with zeros or any other fabricated number.
 *
 * Every data-integrity problem is reported in `integrity` alongside the data:
 * unmapped plants, plants with only inactive mappings, mappings to depots
 * that no longer exist, depots with no active mapping, missing forecasts,
 * forecasts for unknown/inactive materials, and out-of-window months.
 */
const ForecastPredictions = require("../models/ForecastPredictions");
const Material = require("../models/Material");
const Sales = require("../models/Sales");
const { resolveActivePlantMapping } = require("./depotPlantMappingService");
const { ALL_MONTHS, QUARTER_BY_MONTH, finYearLabel, finYearStartCalendarYear } = require("../utils/financialYear");
const { planForecastHorizonRange } = require("../utils/forecastTargets");

const MISSING_LIST_LIMIT = 500;

const monthIndex = (fy, month) => finYearStartCalendarYear(fy) * 12 + ALL_MONTHS.indexOf(month);
const fromIndex = (idx) => {
  const month = ALL_MONTHS[idx % 12];
  return { financialYear: finYearLabel(Math.floor(idx / 12)), month, quarter: QUARTER_BY_MONTH[month] };
};
const norm = (v) => String(v || "").trim().toUpperCase();

/** Latest (FY, month) that has actual Sales, or null. */
async function latestActualSalesMonth() {
  const periods = await Sales.aggregate([{ $group: { _id: { fy: "$FinancialYear", month: "$Month" } } }]);
  let best = null;
  periods.forEach(({ _id }) => {
    if (finYearStartCalendarYear(_id.fy) === null || !ALL_MONTHS.includes(_id.month)) return;
    const idx = monthIndex(_id.fy, _id.month);
    if (!best || idx > best.idx) best = { idx, financialYear: _id.fy, month: _id.month };
  });
  return best;
}

/**
 * The forecast window as month indices. Uses the horizon rule when Sales
 * exists; otherwise falls back to whatever months are stored.
 */
function forecastWindow(now, latestActual, storedIdx) {
  if (latestActual) {
    const range = planForecastHorizonRange(now, latestActual.financialYear, latestActual.month);
    const start = latestActual.idx + 1;
    return { source: "forecastHorizonRule", indices: Array.from({ length: range.horizonMonths }, (_, i) => start + i) };
  }
  return { source: "storedPredictions", indices: [...storedIdx].sort((a, b) => a - b) };
}

/**
 * @param {object} query  materialNo?, depotId? (comma lists), horizonMonths? (first N window months)
 * @param {Date}   now    injectable clock (tests)
 */
async function getDepotDemand(query = {}, now = new Date()) {
  const materialFilter = query.materialNo ? String(query.materialNo).split(",").map(norm).filter(Boolean) : null;
  const depotFilter = query.depotId ? new Set(String(query.depotId).split(",").map(norm).filter(Boolean)) : null;

  const [predictions, materials, mapping, latestActual] = await Promise.all([
    ForecastPredictions.find(materialFilter ? { materialNo: { $in: materialFilter } } : {}).lean(),
    Material.find({ isActive: true, status: { $ne: "Discontinued" } }).select("materialNo").lean(),
    resolveActivePlantMapping(),
    latestActualSalesMonth(),
  ]);
  const { plantToDepot, depotNames, inactiveOnlyPlants, mappingsToUnknownDepots, depotsWithoutActiveMapping } = mapping;

  const operationalMaterials = new Set(materials.map((m) => norm(m.materialNo)));
  const storedIdx = new Set(predictions.map((p) => monthIndex(p.financialYear, p.month)));
  const window = forecastWindow(now, latestActual, storedIdx);
  let windowIdx = window.indices;
  const horizon = parseInt(query.horizonMonths, 10);
  if (Number.isInteger(horizon) && horizon > 0) windowIdx = windowIdx.slice(0, horizon);
  const inWindow = new Set(windowIdx);
  // Months inside the forecast window but past the requested horizon are valid
  // forecasts that simply were not asked for — not a data-integrity problem.
  const inFullWindow = new Set(window.indices);
  let predictionsBeyondRequestedHorizon = 0;

  // ---- Classify every prediction ----
  const unmapped = new Map();
  const inactiveOnly = new Map();
  const unknownMaterials = new Map();
  const outOfWindow = new Map();
  const cells = new Map(); // material|depot|idx -> aggregate
  const seen = new Set(); // material|plant|idx actually present

  predictions.forEach((p) => {
    const materialNo = norm(p.materialNo);
    const idx = monthIndex(p.financialYear, p.month);
    if (!inWindow.has(idx) && inFullWindow.has(idx)) {
      predictionsBeyondRequestedHorizon += 1;
      return;
    }
    if (!inWindow.has(idx)) {
      const key = `${p.financialYear}|${p.month}`;
      const entry = outOfWindow.get(key) || {
        financialYear: p.financialYear, month: p.month, predictionCount: 0,
        reason: latestActual && idx <= latestActual.idx ? "ALREADY_ACTUAL" : "OUTSIDE_FORECAST_WINDOW",
      };
      entry.predictionCount += 1;
      outOfWindow.set(key, entry);
      return;
    }
    if (!operationalMaterials.has(materialNo)) {
      unknownMaterials.set(materialNo, (unknownMaterials.get(materialNo) || 0) + 1);
      return;
    }
    const depotId = plantToDepot.get(p.plant);
    if (!depotId) {
      const bucket = inactiveOnlyPlants.has(p.plant) ? inactiveOnly : unmapped;
      bucket.set(p.plant, (bucket.get(p.plant) || 0) + 1);
      return;
    }
    if (depotFilter && !depotFilter.has(depotId)) return;

    seen.add(`${materialNo}|${p.plant}|${idx}`);
    const key = `${materialNo}|${depotId}|${idx}`;
    const cell = cells.get(key) || { materialNo, depotId, idx, forecastDemand: 0, plants: new Set(), models: new Set(), predictionCount: 0 };
    cell.forecastDemand += Number(p.predictedSalesQty) || 0;
    cell.plants.add(p.plant);
    if (p.model) cell.models.add(p.model);
    cell.predictionCount += 1;
    cells.set(key, cell);
  });

  // ---- Expected-but-missing forecasts (operational material × mapped plant × window month) ----
  const plantsByDepot = new Map();
  plantToDepot.forEach((depotId, plant) => {
    if (depotFilter && !depotFilter.has(depotId)) return;
    if (!plantsByDepot.has(depotId)) plantsByDepot.set(depotId, []);
    plantsByDepot.get(depotId).push(plant);
  });
  const expectedMaterials = materialFilter ? materialFilter.filter((m) => operationalMaterials.has(m)) : [...operationalMaterials];
  const missing = [];
  let missingCount = 0;
  expectedMaterials.sort().forEach((materialNo) => {
    plantsByDepot.forEach((plants, depotId) => {
      plants.forEach((plant) => {
        windowIdx.forEach((idx) => {
          if (seen.has(`${materialNo}|${plant}|${idx}`)) return;
          missingCount += 1;
          if (missing.length < MISSING_LIST_LIMIT) missing.push({ materialNo, plantName: plant, depotId, ...fromIndex(idx) });
        });
      });
    });
  });

  // ---- Output rows ----
  const data = [...cells.values()]
    .map((c) => {
      const depotPlants = plantsByDepot.get(c.depotId) || [];
      return {
        materialNo: c.materialNo,
        depotId: c.depotId,
        depotName: depotNames.get(c.depotId) || null,
        ...fromIndex(c.idx),
        forecastDemand: Math.round(c.forecastDemand * 10) / 10,
        sourcePlants: [...c.plants].sort(),
        predictionCount: c.predictionCount,
        models: [...c.models].sort(),
        // false when a mapped plant of this depot has no prediction for this month — demand is understated
        complete: depotPlants.every((plant) => c.plants.has(plant)),
        _idx: c.idx,
      };
    })
    .sort((a, b) => a.materialNo.localeCompare(b.materialNo) || a.depotId.localeCompare(b.depotId) || a._idx - b._idx)
    .map(({ _idx, ...row }) => row);

  const toList = (map, field) => [...map].map(([key, predictionCount]) => ({ [field]: key, predictionCount })).sort((a, b) => String(a[field]).localeCompare(String(b[field])));
  const integrity = {
    unmappedPlants: toList(unmapped, "plantName"),
    inactiveMappingPlants: toList(inactiveOnly, "plantName").map((e) => ({ ...e, inactiveDepotIds: inactiveOnlyPlants.get(e.plantName) })),
    mappingsToUnknownDepots,
    depotsWithoutActiveMapping,
    missingForecasts: { count: missingCount, items: missing, truncated: missingCount > missing.length },
    unknownOrInactiveMaterials: toList(unknownMaterials, "materialNo"),
    excludedForecastMonths: [...outOfWindow.values()].sort((a, b) => monthIndex(a.financialYear, a.month) - monthIndex(b.financialYear, b.month)),
  };
  const hasIssues = integrity.unmappedPlants.length || integrity.inactiveMappingPlants.length || mappingsToUnknownDepots.length
    || depotsWithoutActiveMapping.length || missingCount || integrity.unknownOrInactiveMaterials.length || integrity.excludedForecastMonths.length;
  integrity.status = hasIssues ? "ISSUES_FOUND" : "OK";

  return {
    window: {
      source: window.source,
      latestActualMonth: latestActual ? { financialYear: latestActual.financialYear, month: latestActual.month } : null,
      months: windowIdx.map(fromIndex),
    },
    summary: {
      rows: data.length,
      materials: new Set(data.map((r) => r.materialNo)).size,
      depots: new Set(data.map((r) => r.depotId)).size,
      // Summed from the unrounded cells so per-row rounding never accumulates.
      totalForecastDemand: Math.round([...cells.values()].reduce((s, c) => s + c.forecastDemand, 0) * 10) / 10,
      predictionsRead: predictions.length,
      predictionsBeyondRequestedHorizon,
    },
    data,
    integrity,
  };
}

module.exports = { getDepotDemand, latestActualSalesMonth };
