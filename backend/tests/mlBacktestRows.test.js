/**
 * Stage 2: Backend ML client test for row-level backtest predictions.
 *
 * Tests the requestBacktestRows() method added to mlServiceClient.js.
 * These are integration-style tests that require the ML service to be running.
 *
 * Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { requestBacktest, requestBacktestRows, checkHealth } = require("../services/mlServiceClient");

test("requestBacktest returns aggregate metrics without rows", async () => {
  let mlAvailable = false;
  try {
    await checkHealth();
    mlAvailable = true;
  } catch {
    // ML service not running - skip test
  }

  if (!mlAvailable) {
    console.log("  ⊘ ML service unavailable, skipping requestBacktest test");
    return;
  }

  const result = await requestBacktest();

  assert.ok(result.dataSource);
  assert.ok(result.evaluatedRows);
  assert.ok(result.overall);
  assert.ok(result.byMaterial);
  assert.ok(result.byPlant);

  // No rows field in default response
  assert.strictEqual(result.rows, undefined);
});

test("requestBacktestRows returns row-level predictions", async () => {
  let mlAvailable = false;
  try {
    await checkHealth();
    mlAvailable = true;
  } catch {
    // ML service not running - skip test
  }

  if (!mlAvailable) {
    console.log("  ⊘ ML service unavailable, skipping requestBacktestRows test");
    return;
  }

  const result = await requestBacktestRows();

  // Aggregate fields still present
  assert.ok(result.dataSource);
  assert.ok(result.evaluatedRows);
  assert.ok(result.overall);

  // Rows field now present
  assert.ok(result.rows);
  assert.ok(Array.isArray(result.rows));
  assert.ok(result.rows.length > 0);

  // Row count matches evaluatedRows
  assert.strictEqual(result.rows.length, result.evaluatedRows);
});

test("row schema contains required fields for Safety Stock", async () => {
  let mlAvailable = false;
  try {
    await checkHealth();
    mlAvailable = true;
  } catch {
    // ML service not running - skip test
  }

  if (!mlAvailable) {
    console.log("  ⊘ ML service unavailable, skipping row schema test");
    return;
  }

  const result = await requestBacktestRows();
  const firstRow = result.rows[0];

  // Required fields for Safety Stock calculation
  const requiredFields = [
    "MatNo",
    "Plant",
    "MatGroupName",
    "FinancialYear",
    "Month",
    "month_index",
    "actual",
    "xgb_pred",
    "wma_pred",
  ];

  for (const field of requiredFields) {
    assert.ok(field in firstRow, `Missing required field: ${field}`);
  }

  // Type validation
  assert.strictEqual(typeof firstRow.MatNo, "string");
  assert.strictEqual(typeof firstRow.Plant, "string");
  assert.strictEqual(typeof firstRow.MatGroupName, "string");
  assert.strictEqual(typeof firstRow.FinancialYear, "string");
  assert.strictEqual(typeof firstRow.Month, "string");
  assert.strictEqual(typeof firstRow.month_index, "number");
  assert.strictEqual(typeof firstRow.actual, "number");
  assert.strictEqual(typeof firstRow.xgb_pred, "number");
  assert.strictEqual(typeof firstRow.wma_pred, "number");
});

test("predictions are numeric and valid", async () => {
  let mlAvailable = false;
  try {
    await checkHealth();
    mlAvailable = true;
  } catch {
    // ML service not running - skip test
  }

  if (!mlAvailable) {
    console.log("  ⊘ ML service unavailable, skipping numeric validation test");
    return;
  }

  const result = await requestBacktestRows();

  for (const row of result.rows) {
    // All prediction values must be finite numbers
    assert.ok(Number.isFinite(row.actual));
    assert.ok(Number.isFinite(row.xgb_pred));
    assert.ok(Number.isFinite(row.wma_pred));

    // XGBoost predictions should be non-negative (clipped in backtest)
    assert.ok(row.xgb_pred >= 0);
  }
});

test("requestBacktest and requestBacktestRows are compatible", async () => {
  let mlAvailable = false;
  try {
    await checkHealth();
    mlAvailable = true;
  } catch {
    // ML service not running - skip test
  }

  if (!mlAvailable) {
    console.log("  ⊘ ML service unavailable, skipping compatibility test");
    return;
  }

  const withoutRows = await requestBacktest();
  const withRows = await requestBacktestRows();

  // Aggregate metrics should be identical
  assert.deepStrictEqual(withoutRows.overall, withRows.overall);
  assert.strictEqual(withoutRows.evaluatedRows, withRows.evaluatedRows);
  assert.strictEqual(withoutRows.dataSource, withRows.dataSource);

  // Only difference is the presence of rows field
  assert.strictEqual(withoutRows.rows, undefined);
  assert.ok(withRows.rows);
});
