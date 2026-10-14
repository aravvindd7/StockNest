import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import DistributionOverview from "../components/distribution/DistributionOverview";
import DistributionRecommendations from "../components/distribution/DistributionRecommendations";
import DistributionTransfers from "../components/distribution/DistributionTransfers";
import DistributionShortages, { shortageRows } from "../components/distribution/DistributionShortages";
import RecommendationDrawer from "../components/distribution/RecommendationDrawer";
import TransferDrawer from "../components/distribution/TransferDrawer";
import { ErrorBanner, TabButton, describeError, num } from "../components/distribution/shared";
import { fetchDepots } from "../services/depotService";
import {
  countRecommendations, countTransfers, fetchPlantMappings, fetchRecommendations, fetchTransferByTransferId, generateRecommendations,
} from "../services/distributionService";

/**
 * Distribution Master — operational control centre for moving surplus stock
 * between depots. Admin-only (route guard + backend requireRole).
 *
 *   Overview          what is happening right now (counts, queues, latest run, network position)
 *   Recommendations   engine suggestions → review (approve / reject)
 *   Transfers         the transfer lifecycle (approve → dispatch → in transit → receive / cancel)
 *   Network Shortages what redistribution can solve vs what needs Planning
 *
 * The page only reads and calls existing endpoints — inventory is changed
 * exclusively by the server at dispatch and receipt.
 */
export default function DistributionMaster() {
  const [tab, setTab] = useState("overview");
  const [transferQueue, setTransferQueue] = useState("active");
  const [reloadToken, setReloadToken] = useState(0);

  const [depotNames, setDepotNames] = useState({});
  const [plantsByDepot, setPlantsByDepot] = useState({});
  const [refError, setRefError] = useState(null);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [analysisStale, setAnalysisStale] = useState(false);

  const [recId, setRecId] = useState(null);
  const [transferDrawerId, setTransferDrawerId] = useState(null);
  const [lookupError, setLookupError] = useState(null);

  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);

  const loadReference = useCallback(async () => {
    setRefError(null);
    try {
      const [depots, mappings] = await Promise.all([fetchDepots({ limit: 500 }), fetchPlantMappings()]);
      setDepotNames(Object.fromEntries(depots.data.map((d) => [d.depotId, d.depotName])));
      const plants = {};
      mappings.filter((m) => m.isActive).forEach((m) => { (plants[m.depotId] = plants[m.depotId] || []).push(m.plantName); });
      setPlantsByDepot(plants);
    } catch (err) {
      setRefError(describeError(err, "Could not load depots and plant mappings."));
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsError(null);
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
    } catch (err) {
      setStatsError(describeError(err, "Could not load Distribution figures."));
    }
  }, []);

  /** Live dry-run of the engine: the current network position, nothing saved. */
  const runAnalysis = useCallback(async () => {
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      setAnalysis(await generateRecommendations({ dryRun: true }));
      setAnalysisStale(false);
    } catch (err) {
      setAnalysisError(describeError(err, "The network analysis could not be run."));
    } finally {
      setAnalysisLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReference();
    loadStats();
    runAnalysis();
  }, [loadReference, loadStats, runAnalysis]);

  /** After any write: reload lists and counts; the analysis is marked stale (re-run on demand, no polling). */
  const handleChanged = useCallback(() => {
    setReloadToken((t) => t + 1);
    loadStats();
    setAnalysisStale(true);
  }, [loadStats]);

  function refreshAll() {
    setReloadToken((t) => t + 1);
    loadStats();
    runAnalysis();
  }

  function navigate(target, queue) {
    if (target === "transfers" && queue) setTransferQueue(queue);
    setTab(target);
  }

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
      setTab("recommendations");
    } catch (err) {
      setGenerateError(describeError(err, "Recommendation generation failed."));
    } finally {
      setGenerating(false);
    }
  }

  const shortageCount = analysis ? shortageRows(analysis).filter((r) => r.uncovered > 0).length : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Distribution Master</h2>
          <p className="text-sm text-gray-500">Admin-only. Rebalance stock between depots — review recommendations, run transfers, and see what redistribution cannot solve.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={refreshAll} className="sn-btn-ghost"><RefreshIcon /> Refresh</button>
          <button onClick={() => setConfirmGenerate(true)} disabled={generating || analysisLoading} className="sn-btn-primary disabled:opacity-60">
            <SparkIcon /> {generating ? "Generating…" : "Generate Recommendations"}
          </button>
        </div>
      </div>

      <ErrorBanner error={refError} onRetry={loadReference} />
      <ErrorBanner error={generateError} onDismiss={() => setGenerateError(null)} />
      <ErrorBanner error={lookupError} onDismiss={() => setLookupError(null)} />
      {generateResult && <GenerationSummary result={generateResult} onDismiss={() => setGenerateResult(null)} />}

      <div className="flex w-fit flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabButton>
        <TabButton active={tab === "recommendations"} onClick={() => setTab("recommendations")} count={stats?.pendingRecommendations}>Recommendations</TabButton>
        <TabButton active={tab === "transfers"} onClick={() => setTab("transfers")} count={stats?.activeTransfers}>Transfers</TabButton>
        <TabButton active={tab === "shortages"} onClick={() => setTab("shortages")} count={shortageCount}>Network Shortages</TabButton>
      </div>

      {tab === "overview" && (
        <DistributionOverview stats={stats} statsError={statsError} onRetry={loadStats} analysis={analysis} analysisLoading={analysisLoading} onNavigate={navigate} />
      )}
      {tab === "recommendations" && (
        <DistributionRecommendations depotNames={depotNames} latestRunId={stats?.latestRun?.generationRunId} reloadToken={reloadToken} onOpen={setRecId} />
      )}
      {tab === "transfers" && (
        <DistributionTransfers key={transferQueue} depotNames={depotNames} reloadToken={reloadToken} initialQueue={transferQueue} onOpen={(id) => setTransferDrawerId(id)} />
      )}
      {tab === "shortages" && (
        <DistributionShortages analysis={analysis} loading={analysisLoading} error={analysisError} onRun={runAnalysis} depotNames={depotNames} stale={analysisStale} />
      )}

      <RecommendationDrawer
        open={Boolean(recId)}
        recommendationId={recId}
        onClose={() => setRecId(null)}
        depotNames={depotNames}
        plantsByDepot={plantsByDepot}
        onChanged={handleChanged}
        onOpenTransfer={(id, transferId) => { setRecId(null); openTransfer(id, transferId); }}
      />
      <TransferDrawer
        open={Boolean(transferDrawerId)}
        transferId={transferDrawerId}
        onClose={() => setTransferDrawerId(null)}
        depotNames={depotNames}
        plantsByDepot={plantsByDepot}
        onChanged={handleChanged}
      />
      <ConfirmDialog
        open={confirmGenerate}
        title="Generate distribution recommendations?"
        message={
          "Runs the engine for the current forecast period using live stock in hand, depot safety stock and forecasts.\n\n" +
          "• New PENDING recommendations are created.\n• Earlier PENDING recommendations for re-evaluated routes become SUPERSEDED (kept for history).\n• Approved and rejected recommendations are not touched.\n• No stock moves."
        }
        confirmLabel="Generate"
        onConfirm={handleGenerate}
        onCancel={() => setConfirmGenerate(false)}
      />
    </div>
  );
}

function GenerationSummary({ result, onDismiss }) {
  const filtered = result.recommendationsFiltered || 0;
  return (
    <div className="rounded-lg border border-healthy/30 bg-healthy/5 px-4 py-3 text-sm text-[#14532D]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold">Generation run complete — <span className="font-mono text-xs">{result.generationRunId}</span></div>
          <div className="mt-0.5">
            {num(result.recommendationsCreated)} recommendations created ({num(result.totalRecommendedQuantity)} units) from {num(result.materialsEvaluated)} materials ·{" "}
            {num(result.sourcePositions.length)} surplus / {num(result.destinationPositions.length)} short positions · {num(result.supersededCount)} superseded ·{" "}
            {num(filtered)} below the minimum transfer quantity · {num(result.unfulfilledShortages.length)} shortages need Planning
            {result.skipped.length > 0 && <> · {num(result.skipped.length)} positions skipped (data quality)</>}.
          </div>
        </div>
        <button onClick={onDismiss} className="shrink-0 text-xs font-semibold hover:underline">Dismiss</button>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}
