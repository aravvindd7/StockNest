/**
 * Derived-data pipeline — keeps StockNest's derived intelligence current.
 *
 *   source data changes (one successful business operation = one event)
 *        ↓  recordSourceChange()  — bumps a version counter, schedules a cycle
 *   Forecast            stale when Sales changed or the rolling window moved
 *        ↓                (ForecastPredictions; XGBoost via the ML service)
 *   AUTO replenishment  computed live by every Planning read from the stored
 *        ↓                forecast — never persisted, so never stale
 *   Recommendations     stale when Stock, Materials, Depots, Depot↔Plant
 *                        mapping, depot safety stock, transfer commitments or
 *                        the forecast changed — a normal engine run: new
 *                        PENDING records, earlier PENDING → SUPERSEDED.
 *
 * What it never does: approve or reject recommendations, create, approve,
 * dispatch, receive or cancel transfers, or touch a MANUAL replenishment plan.
 * Recommendation and transfer-review writes do not raise source events, so a
 * run can never trigger itself.
 *
 * Safety:
 *   - Coalescing: events within DEBOUNCE_MS share one cycle; events arriving
 *     while a cycle runs schedule exactly one follow-up cycle.
 *   - One runner: an in-process queue plus a MongoDB lease (multi-process).
 *   - Versions are captured when a stage STARTS; data that changes during a
 *     run leaves the stage stale, so it runs again — nothing is lost.
 *   - A failed stage keeps the last valid output (forecast writes are
 *     upsert-then-trim; engine runs roll themselves back), records the
 *     failure and retries with exponential backoff.
 *   - First start adopts the existing forecast/recommendations as the
 *     baseline instead of regenerating them.
 */
const crypto = require("crypto");
const os = require("os");
const mongoose = require("mongoose");
const DerivedDataState = require("../models/DerivedDataState");
const ForecastPredictions = require("../models/ForecastPredictions");
const DistributionRecommendation = require("../models/DistributionRecommendation");
const forecastService = require("./forecastGenerationService");
const recommendationEngine = require("./distributionRecommendationService");

const SOURCES = ["sales", "stock", "materials", "depots", "depotPlantMapping", "depotSafetyStock", "transfers"];
const DISTRIBUTION_INPUTS = ["stock", "materials", "depots", "depotPlantMapping", "depotSafetyStock", "transfers"];
const AUTOMATIC_USER = "system (automatic)";

const config = {
  debounceMs: Number(process.env.DERIVED_DEBOUNCE_MS) || 3000,
  busyRetryMs: 15_000,
  // Periodic staleness check: the rolling forecast window moves with the
  // calendar, and versions bumped by another process (scripts/recordSourceChange.js)
  // are picked up here. Cheap: a few small reads; a stage only runs when stale.
  clockCheckMs: 5 * 60_000,
  leaseMs: 15 * 60_000,
  maxPassesPerCycle: 3,
};
const backoffMs = (failures) => Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));

const ownerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
let started = false;
let timer = null;
let retryTimer = null;
let clockTimer = null;
let activeStage = null;
let chain = Promise.resolve();

const isConnected = () => mongoose.connection.readyState === 1;

/** Runs fn after every previously queued pipeline task (one at a time in this process). */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Bookkeeping write. Without a database connection (DB-free unit tests) it is
 * skipped, so a manual action still runs — it just isn't recorded.
 */
async function saveState(id, update, options = { upsert: true }) {
  if (!isConnected()) return;
  await DerivedDataState.updateOne({ _id: id }, update, options);
}

async function readState() {
  if (!isConnected()) return { sources: Object.fromEntries(SOURCES.map((s) => [s, 0])), forecast: null, distribution: null };
  const docs = await DerivedDataState.find({ _id: { $in: ["sources", "forecast", "distribution"] } }).lean();
  const by = Object.fromEntries(docs.map((d) => [d._id, d]));
  const sources = Object.fromEntries(SOURCES.map((s) => [s, by.sources?.versions?.[s] || 0]));
  return { sources, forecast: by.forecast || null, distribution: by.distribution || null };
}

const distributionInputs = (state) => ({
  ...Object.fromEntries(DISTRIBUTION_INPUTS.map((k) => [k, state.sources[k]])),
  forecast: state.forecast?.version || 0,
});
const forecastIsStale = (state, window) =>
  !state.forecast || state.forecast.basedOn?.sales !== state.sources.sales || (window ? state.forecast.basedOn?.window !== window.key : false);
const distributionIsStale = (state) => {
  if (!state.distribution) return true;
  const inputs = distributionInputs(state);
  return Object.keys(inputs).some((k) => state.distribution.basedOn?.[k] !== inputs[k]);
};
const inBackoff = (doc) => Boolean(doc?.nextRetryAt && new Date(doc.nextRetryAt) > new Date());

async function recordFailure(stage, doc, err) {
  const failures = (doc?.failures || 0) + 1;
  await saveState(stage, {
    $set: { status: "failed", lastAttemptAt: new Date(), lastError: String(err?.message || err).slice(0, 500), failures, nextRetryAt: new Date(Date.now() + backoffMs(failures)) },
  });
  console.error(`[derived] ${stage} update failed (attempt ${failures}); keeping the last valid result:`, err?.message || err);
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Records that source data changed. Call once per successful business
 * operation (an import, a create/edit/delete, a stock movement) — never per
 * row and never from model hooks. Safe to call when no database is connected.
 *
 * HTTP write routes call this through middleware/sourceChange.js. Writes made
 * directly to MongoDB (mongosh, ad-hoc scripts) bypass it: such a script must
 * record its change itself — `node scripts/recordSourceChange.js sales stock`
 * — and the running server picks it up at its next periodic check.
 */
async function recordSourceChange(sources, { reason } = {}) {
  const list = [...new Set(sources)].filter((s) => SOURCES.includes(s));
  if (!list.length || !isConnected()) return false;
  const now = new Date();
  await DerivedDataState.updateOne(
    { _id: "sources" },
    { $inc: Object.fromEntries(list.map((s) => [`versions.${s}`, 1])), $set: { ...Object.fromEntries(list.map((s) => [`changedAt.${s}`, now])), lastReason: reason || null } },
    { upsert: true }
  );
  schedule();
  return true;
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

/** Coalescing: at most one pending timer; a cycle already running gets exactly one follow-up. */
function schedule(delay = config.debounceMs) {
  if (!started || timer) return;
  timer = setTimeout(() => {
    timer = null;
    exclusive(processCycle).catch((err) => console.error("[derived] cycle failed:", err.message));
  }, delay);
  timer.unref?.();
}

async function scheduleRetry() {
  if (!started) return;
  const state = await readState();
  const pendingRetries = [state.forecast, state.distribution]
    .filter((d) => d?.status === "failed" && d.nextRetryAt)
    .map((d) => new Date(d.nextRetryAt).getTime());
  if (!pendingRetries.length) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => schedule(0), Math.max(1000, Math.min(...pendingRetries) - Date.now()));
  retryTimer.unref?.();
}

async function acquireLease() {
  try {
    const doc = await DerivedDataState.findOneAndUpdate(
      { _id: "lease", $or: [{ until: { $lt: new Date() } }, { owner: ownerId }] },
      { $set: { owner: ownerId, until: new Date(Date.now() + config.leaseMs) } },
      { upsert: true, new: true }
    ).lean();
    return doc?.owner === ownerId;
  } catch (err) {
    if (err.code === 11000) return false; // held by another live runner
    throw err;
  }
}
const releaseLease = () => DerivedDataState.updateOne({ _id: "lease", owner: ownerId }, { $set: { until: new Date(0) } });

// ─── Stages ──────────────────────────────────────────────────────────────────

async function runForecastStage({ force = false, actor } = {}) {
  const state = await readState();
  const window = await forecastService.currentForecastWindow();
  if (!force && (!forecastIsStale(state, window) || inBackoff(state.forecast))) return { ran: false };
  const salesVersion = state.sources.sales; // captured at start: later changes leave it stale
  const version = (state.forecast?.version || 0) + 1;
  activeStage = "forecast";
  try {
    const summary = await forecastService.generateAndStoreForecast({ window, stamp: { forecastVersion: version, sourceSalesVersion: salesVersion } });
    await saveState("forecast", {
      $set: {
        version, basedOn: { sales: salesVersion, window: window?.key || null }, status: "current", lastSuccessAt: summary.generatedAt,
        lastAttemptAt: new Date(), lastError: null, failures: 0, nextRetryAt: null, lastTrigger: actor || AUTOMATIC_USER,
      },
    });
    console.log(`[derived] forecast v${version} generated (${summary.predictionsStored} predictions, Sales v${salesVersion}, ${actor || "automatic"}).`);
    return { ran: true, ok: true, summary, version };
  } catch (err) {
    await recordFailure("forecast", state.forecast, err);
    return { ran: true, ok: false, error: err };
  } finally {
    activeStage = null;
  }
}

/**
 * @param {object} opts  force (manual run), actor, options (engine options for a manual run)
 */
async function runDistributionStage({ force = false, actor, options = {} } = {}) {
  const state = await readState();
  if (!force && (!distributionIsStale(state) || inBackoff(state.distribution))) return { ran: false };
  const inputs = distributionInputs(state); // captured at start
  const fullScope = !options.materialNos && !options.horizonMonths && !options.allowMissingSafetyStock;
  activeStage = "distribution";
  try {
    const result = await recommendationEngine.generateRecommendations({ ...options, dryRun: false }, { user: actor || AUTOMATIC_USER, sourceVersions: inputs });
    // Only a full-scope run represents "the current state of the network".
    if (fullScope) {
      await saveState("distribution", {
        $set: {
          basedOn: inputs, generationRunId: result.generationRunId, status: "current", lastSuccessAt: result.generatedAt,
          lastAttemptAt: new Date(), lastError: null, failures: 0, nextRetryAt: null, lastTrigger: actor || AUTOMATIC_USER,
          lastResult: { created: result.recommendationsCreated, superseded: result.supersededCount },
        },
        $inc: { version: 1 },
      });
    }
    console.log(`[derived] recommendations run ${result.generationRunId}: ${result.recommendationsCreated} PENDING created, ${result.supersededCount} superseded (${actor || "automatic"}).`);
    return { ran: true, ok: true, result };
  } catch (err) {
    if (err.status === 409) return { ran: false, busy: true, error: err }; // a manual run holds the engine — retry soon
    if (!force) await recordFailure("distribution", state.distribution, err);
    return { ran: true, ok: false, error: err };
  } finally {
    activeStage = null;
  }
}

/** One coalesced pass over the dependency graph: forecast first, then recommendations. */
async function processCycle() {
  if (!isConnected()) return;
  if (!(await acquireLease())) {
    schedule(config.busyRetryMs);
    return;
  }
  try {
    for (let pass = 0; pass < config.maxPassesPerCycle; pass++) {
      const f = await runForecastStage();
      const d = await runDistributionStage();
      if (d.busy) schedule(config.busyRetryMs);
      if (!f.ran && !d.ran) break;
    }
  } finally {
    await releaseLease().catch(() => {});
  }
  await scheduleRetry().catch(() => {});
}

// ─── Manual (force) actions ──────────────────────────────────────────────────

/** Planning "Regenerate Forecast": a forced forecast run; recommendations follow automatically. */
function regenerateForecast({ actor } = {}) {
  return exclusive(async () => {
    const r = await runForecastStage({ force: true, actor });
    schedule(0);
    if (!r.ok) throw r.error;
    return r.summary;
  });
}

/** Distribution "Regenerate Recommendations": a forced engine run with the given options. */
function regenerateRecommendations(options = {}, { user } = {}) {
  return exclusive(async () => {
    const r = await runDistributionStage({ force: true, actor: user, options });
    if (r.busy || !r.ok) throw r.error;
    return r.result;
  });
}

// ─── Status (UI) ─────────────────────────────────────────────────────────────

async function getStatus() {
  const state = await readState();
  const stage = (name, doc, stale) => ({
    version: doc?.version || 0,
    updatedAt: doc?.lastSuccessAt || null,
    status: activeStage === name ? "updating" : doc?.status === "failed" ? "failed" : stale ? "updating" : "current",
  });
  return {
    sources: state.sources,
    forecast: stage("forecast", state.forecast, forecastIsStale(state, null)),
    distribution: stage("distribution", state.distribution, distributionIsStale(state)),
  };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** First start: adopt existing results as the baseline (no regeneration, no business writes). */
async function bootstrap() {
  await DerivedDataState.updateOne({ _id: "sources" }, { $setOnInsert: { versions: {}, changedAt: {} } }, { upsert: true });
  let state = await readState();
  if (!state.forecast) {
    const latest = await ForecastPredictions.findOne({}).sort({ generatedAt: -1 }).select("generatedAt").lean();
    if (latest) {
      const window = await forecastService.currentForecastWindow();
      await DerivedDataState.updateOne({ _id: "forecast" }, {
        $setOnInsert: { version: 1, basedOn: { sales: state.sources.sales, window: window?.key || null }, status: "current", lastSuccessAt: latest.generatedAt, failures: 0, adopted: true },
      }, { upsert: true });
      state = await readState();
    }
  }
  if (!state.distribution) {
    const latestRun = await DistributionRecommendation.findOne({ generationRunId: { $type: "string" } }).sort({ generatedAt: -1 }).select("generationRunId generatedAt").lean();
    if (latestRun) {
      await DerivedDataState.updateOne({ _id: "distribution" }, {
        $setOnInsert: { version: 1, basedOn: distributionInputs(state), generationRunId: latestRun.generationRunId, status: "current", lastSuccessAt: latestRun.generatedAt, failures: 0, adopted: true },
      }, { upsert: true });
    }
  }
}

async function start() {
  if (started) return;
  await bootstrap();
  started = true;
  schedule(config.debounceMs); // pick up anything left stale by a previous run or restart
  clockTimer = setInterval(() => schedule(0), config.clockCheckMs);
  clockTimer.unref?.();
  console.log("[derived] automatic forecast & recommendation updates enabled.");
}

/** Test hook: stop timers and wait for the current task. */
async function stop() {
  started = false;
  clearTimeout(timer);
  clearTimeout(retryTimer);
  clearInterval(clockTimer);
  timer = retryTimer = clockTimer = null;
  await chain;
}

/** Test hook: run one cycle now and wait for it. */
const runNow = () => exclusive(processCycle);

module.exports = {
  SOURCES,
  DISTRIBUTION_INPUTS,
  AUTOMATIC_USER,
  config,
  backoffMs,
  recordSourceChange,
  regenerateForecast,
  regenerateRecommendations,
  getStatus,
  bootstrap,
  start,
  stop,
  runNow,
  readState,
};
