import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import DistributionOverview from "../components/distribution/DistributionOverview";
import DistributionRecommendations from "../components/distribution/DistributionRecommendations";
import DistributionTransfers from "../components/distribution/DistributionTransfers";
import DistributionNetworkAnalysis from "../components/distribution/DistributionNetworkAnalysis";
import RecommendationDrawer from "../components/distribution/RecommendationDrawer";
import TransferDrawer from "../components/distribution/TransferDrawer";
import { ErrorBanner, TabButton, describeError, num } from "../components/distribution/shared";
import { fetchDepots } from "../services/depotService";
import { fetchMaterials } from "../services/materialService";
import useDerivedStatus, { FreshnessNote } from "../components/useDerivedStatus";
import {
  countRecommendations, countTransfers, fetchPlantMappings, fetchRecommendations, fetchTransferByTransferId, generateRecommendations,
} from "../services/distributionService";

// Everything Distribution shows is derived from these — when any changes on the
// server (automatic recommendation run, stock movement, imports…), refresh quietly.
const distributionSignature = (s) => [
  s.distribution.version, s.forecast.version,
  s.sources.stock, s.sources.materials, s.sources.depots, s.sources.depotPlantMapping, s.sources.depotSafetyStock, s.sources.transfers,
].join("|");

/**
 * Distribution Master — operational control centre for moving surplus stock
 * between depots. Admin-only (route guard + backend requireRole).
 *
 *   Header            automatic-update status · Regenerate Recommendations (a manual
 *                     force-run; recommendations normally update automatically when
 *                     stock, forecasts, safety stock or depot mappings change)
 *   Overview          permanent KPI summary — always visible, never a tab
 *   Workspace tabs:
 *     Network Analysis   where inventory is needed and how much the depot network can solve
 *     Recommendations    engine suggestions → review (approve / reject)
 *     Transfers          the transfer lifecycle (approve → dispatch → in transit → receive / cancel)
 *
 * The page only reads and calls existing endpoints — inventory is changed
 * exclusively by the server at dispatch and receipt. It stays current on its
 * own: after every action, and whenever the server reports an automatic update
 * (useDerivedStatus — checked only while the tab is visible). Refreshes are
 * quiet: the active tab, search, filters, sorting, page, open drawers and
 * in-progress forms are left as they are.
 */
export default function DistributionMaster() {
  const [tab, setTab] = useState("analysis");
  const [reloadToken, setReloadToken] = useState(0);

  const [depotNames, setDepotNames] = useState({});
  const [materialNames, setMaterialNames] = useState({});
  const [plantsByDepot, setPlantsByDepot] = useState({});
  const [refError, setRefError] = useState(null);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);

  const [recId, setRecId] = useState(null);
  const [transferDrawerId, setTransferDrawerId] = useState(null);
  const [lookupError, setLookupError] = useState(null);

  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);

  // Quiet refreshes that failed are retried at the next status check, and every
  // loader ignores a response that a newer request of its own has superseded.
  const failed = useRef(new Set());
  const refSeq = useRef(0);
  const statsSeq = useRef(0);

  const loadReference = useCallback(async () => {
    const seq = ++refSeq.current;
    setRefError(null);
    try {
      const [depots, mappings, materials] = await Promise.all([fetchDepots({ limit: 500 }), fetchPlantMappings(), fetchAllMaterials()]);
      if (seq !== refSeq.current) return;
      failed.current.delete("reference");
      setDepotNames(Object.fromEntries(depots.data.map((d) => [d.depotId, d.depotName])));
      setMaterialNames(Object.fromEntries(materials.map((m) => [m.materialNo, m.description])));
      const plants = {};
      mappings.filter((m) => m.isActive).forEach((m) => { (plants[m.depotId] = plants[m.depotId] || []).push(m.plantName); });
      setPlantsByDepot(plants);
    } catch (err) {
      if (seq !== refSeq.current) return;
      failed.current.add("reference");
      setRefError(describeError(err, "Could not load depots and plant mappings."));
    }
  }, []);

  const loadStats = useCallback(async ({ silent = false } = {}) => {
    const seq = ++statsSeq.current;
    if (!silent) setStatsError(null);
    try {
      const [pendingRecommendations, approvedRecommendations, requested, approvedTransfers, dispatched, inTransit, received, pending, latest] = await Promise.all([
        countRecommendations({ status: "PENDING" }),
        countRecommendations({ status: "APPROVED" }),
        countTransfers({ status: "REQUESTED" }),
        countTransfers({ status: "APPROVED" }),
        countTransfers({ status: "DISPATCHED" }),
        countTransfers({ status: "IN_TRANSIT" }),
        countTransfers({ status: "RECEIVED" }),
        fetchRecommendations({ status: "PENDING", limit: 500 }),
        fetchRecommendations({ limit: 1 }), // newest first by default
      ]);
      let latestRun = null;
      const newest = latest.data[0];
      if (newest?.generationRunId) {
        const [count, pendingInRun] = await Promise.all([
          countRecommendations({ generationRunId: newest.generationRunId }),
          countRecommendations({ generationRunId: newest.generationRunId, status: "PENDING" }),
        ]);
        latestRun = { ...newest, count, pending: pendingInRun };
      }
      if (seq !== statsSeq.current) return; // a newer refresh superseded this one
      setStats({
        pendingRecommendations,
        approvedRecommendations,
        requested,
        approvedTransfers,
        dispatched,
        inTransit,
        received,
        activeTransfers: requested + approvedTransfers + dispatched + inTransit,
        inMotion: dispatched + inTransit,
        pendingUnits: pending.data.reduce((s, r) => s + r.recommendedQuantity, 0),
        pendingUnitsPartial: pending.pagination.total > pending.data.length,
        latestRun,
      });
      setStatsError(null);
      failed.current.delete("stats");
    } catch (err) {
      if (seq !== statsSeq.current) return;
      failed.current.add("stats");
      if (!silent) setStatsError(describeError(err, "Could not load Distribution figures."));
    }
  }, []);

  /**
   * Live dry-run of the engine: the current network position, nothing saved.
   * One at a time, so responses can never arrive out of order. A background
   * update that arrives while a run is in flight queues exactly one follow-up
   * run (the in-flight one may predate the change); a duplicate initial load
   * (StrictMode's dev double-mount) is simply skipped.
   * silent: a background update — the current figures stay on screen, and a
   * failure keeps them rather than replacing them with an error.
   */
  const analysisInFlight = useRef(false);
  const analysisQueued = useRef(false);
  const runAnalysis = useCallback(async ({ silent = false } = {}) => {
    if (analysisInFlight.current) {
      if (silent) analysisQueued.current = true;
      return;
    }
    analysisInFlight.current = true;
    setAnalysisLoading(true);
    if (!silent) setAnalysisError(null);
    try {
      setAnalysis(await generateRecommendations({ dryRun: true }));
      setAnalysisError(null);
      failed.current.delete("analysis");
    } catch (err) {
      failed.current.add("analysis");
      if (!silent) setAnalysisError(describeError(err, "The network analysis could not be run."));
    } finally {
      analysisInFlight.current = false;
      setAnalysisLoading(false);
    }
    if (analysisQueued.current) {
      analysisQueued.current = false;
      runAnalysis({ silent: true });
    }
  }, []);

  useEffect(() => {
    loadReference();
    loadStats();
    runAnalysis();
  }, [loadReference, loadStats, runAnalysis]);

  /** After any action here: lists, Overview and Network Analysis update quietly. */
  const handleChanged = useCallback(() => {
    setReloadToken((t) => t + 1);
    loadStats({ silent: true });
    runAnalysis({ silent: true });
  }, [loadStats, runAnalysis]);

  // Automatic updates made on the server (new recommendation run, stock moved,
  // imports, mapping/safety-stock changes) — refresh quietly when they land.
  const { status: derivedStatus, check: checkDerived, tick: statusTick } = useDerivedStatus({
    signature: distributionSignature,
    onChange: () => {
      loadReference();
      handleChanged();
    },
  });

  // Retry any quiet refresh that failed (lists retry themselves on the same tick).
  useEffect(() => {
    if (failed.current.has("reference")) loadReference();
    if (failed.current.has("stats")) loadStats({ silent: true });
    if (failed.current.has("analysis")) runAnalysis({ silent: true });
  }, [statusTick, loadReference, loadStats, runAnalysis]);

  async function openTransfer(id, transferId) {
    setLookupError(null);
    if (id) {
      setTransferDrawerId(id);
      return;
    }
    try {
      const t = await fetchTransferByTransferId(transferId);
      if (t) setTransferDrawerId(t._id);
      else setLookupError({ title: "Not found", message: `Transfer ${transferId} could not be found.`, details: [] });
    } catch (err) {
      setLookupError(describeError(err));
    }
  }

  async function handleGenerate() {
    setConfirmGenerate(false);
    setGenerating(true);
    setGenerateError(null);
    setGenerateResult(null);
    try {
      const result = await generateRecommendations({});
      setGenerateResult(result);
      handleChanged();
      checkDerived();
      setTab("recommendations");
    } catch (err) {
      setGenerateError(describeError(err, "Recommendation generation failed."));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Distribution Master</h2>
          <p className="text-sm text-gray-500">Admin-only. Rebalance stock between depots — review recommendations, run transfers, and see what redistribution cannot solve.</p>
          <div className="mt-1"><FreshnessNote stage={derivedStatus?.distribution} noun="recommendations" /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setConfirmGenerate(true)} disabled={generating} className="sn-btn-ghost disabled:opacity-60">
            <SparkIcon /> {generating ? "Regenerating…" : "Regenerate Recommendations"}
          </button>
        </div>
      </div>

      <ErrorBanner error={refError} onRetry={loadReference} />
      <ErrorBanner error={generateError} onDismiss={() => setGenerateError(null)} />
      <ErrorBanner error={lookupError} onDismiss={() => setLookupError(null)} />
      {generateResult && <GenerationSummary result={generateResult} onDismiss={() => setGenerateResult(null)} />}

      {/* Permanent Overview — stays visible whichever workspace tab is open. */}
      <DistributionOverview stats={stats} statsError={statsError} onRetry={loadStats} analysis={analysis} analysisLoading={analysisLoading} />

      <section aria-label="Distribution workspace" className="flex flex-col gap-4 border-t border-gray-200 pt-5">
        <div className="flex w-fit flex-wrap gap-1 rounded-lg bg-gray-100 p-1" role="tablist">
          <TabButton active={tab === "analysis"} onClick={() => setTab("analysis")}>Network Analysis</TabButton>
          <TabButton active={tab === "recommendations"} onClick={() => setTab("recommendations")}>Recommendations</TabButton>
          <TabButton active={tab === "transfers"} onClick={() => setTab("transfers")}>Transfers</TabButton>
        </div>

        {tab === "analysis" && (
          <DistributionNetworkAnalysis
            analysis={analysis}
            loading={analysisLoading}
            error={analysisError}
            onRun={runAnalysis}
            depotNames={depotNames}
            materialNames={materialNames}
          />
        )}
        {tab === "recommendations" && (
          <DistributionRecommendations
            depotNames={depotNames}
            materialNames={materialNames}
            latestRunId={stats?.latestRun?.generationRunId}
            latestRunAt={stats?.latestRun?.generatedAt}
            reloadToken={reloadToken}
            retryTick={statusTick}
            onOpen={setRecId}
            onChanged={handleChanged}
          />
        )}
        {tab === "transfers" && (
          <DistributionTransfers depotNames={depotNames} materialNames={materialNames} reloadToken={reloadToken} retryTick={statusTick} onOpen={(id) => setTransferDrawerId(id)} />
        )}
      </section>

      <RecommendationDrawer
        open={Boolean(recId)}
        recommendationId={recId}
        onClose={() => setRecId(null)}
        depotNames={depotNames}
        materialNames={materialNames}
        plantsByDepot={plantsByDepot}
        onChanged={handleChanged}
        onOpenTransfer={(id, transferId) => { setRecId(null); openTransfer(id, transferId); }}
      />
      <TransferDrawer
        open={Boolean(transferDrawerId)}
        transferId={transferDrawerId}
        onClose={() => setTransferDrawerId(null)}
        depotNames={depotNames}
        materialNames={materialNames}
        plantsByDepot={plantsByDepot}
        onChanged={handleChanged}
      />
      <ConfirmDialog
        open={confirmGenerate}
        title="Regenerate recommendations now?"
        message={
          "Recommendations already update automatically when stock, forecasts, safety stock or depot mappings change. Use this only to force a fresh run now, using live stock in hand, depot safety stock and forecasts.\n\n" +
          "• New PENDING recommendations are created.\n• Earlier pending recommendations for re-evaluated routes are cleared from the review list.\n• Approved and rejected recommendations are not touched.\n• No stock moves."
        }
        confirmLabel="Regenerate"
        onConfirm={handleGenerate}
        onCancel={() => setConfirmGenerate(false)}
      />
    </div>
  );
}

/** All Material Master records for name lookups (the list endpoint returns at most 200 per page). */
async function fetchAllMaterials() {
  const first = await fetchMaterials({ page: 1, limit: 200 });
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, first.pagination.totalPages - 1) }, (_, i) => fetchMaterials({ page: i + 2, limit: 200 }))
  );
  return [first, ...rest].flatMap((r) => r.data);
}

function GenerationSummary({ result, onDismiss }) {
  const filtered = result.recommendationsFiltered || 0;
  return (
    <div className="rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm text-[#14532D]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold">Recommendations regenerated</div>
          <div className="mt-0.5">
            {num(result.recommendationsCreated)} recommendations created ({num(result.totalRecommendedQuantity)} units) from {num(result.materialsEvaluated)} materials ·{" "}
            {num(result.sourcePositions.length)} surplus / {num(result.destinationPositions.length)} short positions ·{" "}
            {num(filtered)} below the minimum transfer quantity · {num(result.unfulfilledShortages.length)} shortages need Planning
            {result.skipped.length > 0 && <> · {num(result.skipped.length)} positions skipped (data quality)</>}.
          </div>
        </div>
        <button onClick={onDismiss} className="shrink-0 text-xs font-semibold hover:underline">Dismiss</button>
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}
