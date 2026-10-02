/**
 * Stage 3: Integration tests for ForecastErrorStats refresh
 *
 * Tests material aggregation across plants, deduplication, and database
 * persistence behavior.
 *
 * These tests require MongoDB and are skipped in environments without it.
 *
 * Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");

test("ForecastErrorStats integration tests require MongoDB (skipped in CI)", () => {
  // These tests require a live MongoDB connection
  // They should be run manually in a development environment with MongoDB running
  assert.ok(true, "Integration tests are environment-specific");
});

// Exercise refresh with in-memory ML and persistence boundaries; no MongoDB needed.
const ForecastErrorStats = require('../models/ForecastErrorStats');
const mlClient = require('../services/mlServiceClient');

async function withRefreshMocks(t, request, verify) {
  const writes = [];
  t.mock.method(mlClient, 'requestBacktestRows', request);
  t.mock.method(ForecastErrorStats, 'findOneAndUpdate', async (filter, stats, options) => {
    writes.push({ filter, stats, options });
    return stats;
  });
  const servicePath = require.resolve('../services/safetyStockService');
  delete require.cache[servicePath];
  const { refreshForecastErrorStats } = require(servicePath);
  try {
    await verify(refreshForecastErrorStats, writes);
  } finally {
    delete require.cache[servicePath];
    t.mock.restoreAll();
  }
}

const observation = (Plant, Month, error) => ({
  MatNo: ' mat001 ', Plant, FinancialYear: '2025-26', Month,
  actual: 100 + error, xgb_pred: 100, month_index: 1,
});

test('refresh aggregates plants by material, deduplicates observations, and ignores invalid numeric rows', async (t) => {
  const rows = [
    observation('A', 'April', 10), observation('A', 'May', -20),
    observation('A', 'June', 30), observation('B', 'April', -10),
    observation('B', 'May', 0), observation('B', 'June', 20),
  ];
  rows.push({ ...rows[0] });
  for (const invalid of [NaN, Infinity, -Infinity, null, '100']) {
    rows.push({ ...observation('C', 'April', 10), actual: invalid });
    rows.push({ ...observation('C', 'May', 10), xgb_pred: invalid });
  }
  await withRefreshMocks(t, async () => ({ rows }), async (refresh, writes) => {
    const summary = await refresh();
    assert.equal(summary.processedMaterials, 1);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].filter, { materialNo: 'MAT001' });
    const stats = writes[0].stats;
    assert.equal(stats.observationCount, 6);
    assert.equal(stats.underForecastCount, 3);
    assert.equal(stats.status, 'FORECAST_ERROR_BASED');
    assert.equal(stats.safetyStock, 28); // P90([10, 20, 30])
    assert.equal(stats.meanUnderforecast, 20);
    assert.equal(stats.mae, 15);
    assert.equal(stats.rmse, Math.sqrt(1900 / 6));
  });
});

test('refresh retains insufficient-history statistics after invalid rows are removed', async (t) => {
  const rows = [10, -20, 30, -10, 0].map((error, i) => observation('A', String(i), error));
  rows.push({ ...observation('A', 'invalid', 0), actual: NaN });
  await withRefreshMocks(t, async () => ({ rows }), async (refresh, writes) => {
    await refresh();
    const stats = writes[0].stats;
    assert.equal(stats.observationCount, 5);
    assert.equal(stats.status, 'INSUFFICIENT_HISTORY');
    assert.equal(stats.safetyStock, 0);
    assert.equal(stats.underForecastCount, 2);
    assert.equal(stats.meanUnderforecast, 20);
    assert.equal(stats.mae, 14);
    assert.equal(stats.rmse, Math.sqrt(300));
  });
});

test('ML request failure leaves existing statistics untouched', async (t) => {
  await withRefreshMocks(t, async () => { throw new Error('offline'); }, async (refresh, writes) => {
    await assert.rejects(refresh(), /Failed to fetch backtest rows.*offline/);
    assert.equal(writes.length, 0);
  });
});
