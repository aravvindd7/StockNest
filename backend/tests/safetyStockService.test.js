/**
 * Stage 3: Tests for Safety Stock Service
 *
 * Tests forecast-error-based Safety Stock calculation, material aggregation,
 * error handling, and persistence logic.
 *
 * Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateErrors,
  calculateSafetyStockForMaterial,
  MIN_BACKTEST_OBSERVATIONS,
  UNDERFORECAST_PERCENTILE,
} = require("../services/safetyStockService");

test("calculateErrors: positive error is underforecast", () => {
  const observations = [{ actual: 140, xgb_pred: 133.5 }];
  const { errors, underforecasts } = calculateErrors(observations);

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0], 6.5);
  assert.strictEqual(underforecasts.length, 1);
  assert.strictEqual(underforecasts[0], 6.5);
});

test("calculateErrors: negative error is NOT underforecast", () => {
  const observations = [{ actual: 100, xgb_pred: 120 }];
  const { errors, underforecasts } = calculateErrors(observations);

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0], -20);
  assert.strictEqual(underforecasts.length, 0); // No underforecasts
});

test("calculateErrors: zero error is NOT underforecast", () => {
  const observations = [{ actual: 100, xgb_pred: 100 }];
  const { errors, underforecasts } = calculateErrors(observations);

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0], 0);
  assert.strictEqual(underforecasts.length, 0); // No underforecasts
});

test("calculateErrors: mixed positive and negative errors", () => {
  const observations = [
    { actual: 140, xgb_pred: 130 }, // +10 underforecast
    { actual: 90, xgb_pred: 100 },  // -10 overforecast
    { actual: 120, xgb_pred: 115 }, // +5 underforecast
  ];
  const { errors, absoluteErrors, underforecasts } = calculateErrors(observations);

  assert.strictEqual(errors.length, 3);
  assert.deepStrictEqual(errors, [10, -10, 5]);

  assert.strictEqual(absoluteErrors.length, 3);
  assert.deepStrictEqual(absoluteErrors, [10, 10, 5]);

  assert.strictEqual(underforecasts.length, 2);
  assert.deepStrictEqual(underforecasts, [10, 5]);
});

test("calculateErrors: skips invalid numeric values", () => {
  const observations = [
    { actual: 140, xgb_pred: 130 },
    { actual: NaN, xgb_pred: 100 },
    { actual: 120, xgb_pred: Infinity },
    { actual: 150, xgb_pred: 145 },
  ];
  const { errors, underforecasts } = calculateErrors(observations);

  // Only 2 valid observations
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(underforecasts.length, 2);
});

test("calculateSafetyStockForMaterial: insufficient history (5 observations)", () => {
  const observations = [
    { actual: 100, xgb_pred: 90, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 110, xgb_pred: 95, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 105, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 120, xgb_pred: 110, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 115, xgb_pred: 105, month_index: 5, FinancialYear: "2024-25", Month: "September" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.status, "INSUFFICIENT_HISTORY");
  assert.strictEqual(stats.safetyStock, 0);
  assert.strictEqual(stats.observationCount, 5);
  assert.strictEqual(stats.underForecastCount, 5);
  assert.strictEqual(stats.meanUnderforecast, 10);
  assert.strictEqual(stats.mae, 10);
  assert.strictEqual(stats.rmse, Math.sqrt(110));
});

test("calculateSafetyStockForMaterial: insufficient history retains mixed error statistics", () => {
  const observations = [10, -20, 30, -10, 0].map(error => ({ actual: 100 + error, xgb_pred: 100 }));
  const stats = calculateSafetyStockForMaterial("MAT0001", observations);
  assert.strictEqual(stats.status, "INSUFFICIENT_HISTORY");
  assert.strictEqual(stats.safetyStock, 0);
  assert.strictEqual(stats.observationCount, 5);
  assert.strictEqual(stats.underForecastCount, 2);
  assert.strictEqual(stats.meanUnderforecast, 20);
  assert.strictEqual(stats.mae, 14);
  assert.strictEqual(stats.rmse, Math.sqrt(300));
});

test("calculateSafetyStockForMaterial: exactly 6 observations is sufficient", () => {
  const observations = [
    { actual: 100, xgb_pred: 90, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 110, xgb_pred: 95, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 105, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 120, xgb_pred: 110, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 115, xgb_pred: 105, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 125, xgb_pred: 120, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.observationCount, 6);
  assert.notStrictEqual(stats.status, "INSUFFICIENT_HISTORY");
  assert.strictEqual(stats.status, "FORECAST_ERROR_BASED");
  assert.ok(stats.safetyStock > 0); // All observations are underforecasts
});

test("calculateSafetyStockForMaterial: no underforecasts", () => {
  const observations = [
    { actual: 80, xgb_pred: 90, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 85, xgb_pred: 95, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 90, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 95, xgb_pred: 110, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 100, xgb_pred: 105, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 105, xgb_pred: 120, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.status, "NO_HISTORICAL_UNDERFORECAST");
  assert.strictEqual(stats.safetyStock, 0);
  assert.strictEqual(stats.observationCount, 6);
  assert.strictEqual(stats.underForecastCount, 0);
});

test("calculateSafetyStockForMaterial: 90th percentile calculation", () => {
  // Create 10 underforecasts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const observations = [
    { actual: 101, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 102, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 103, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 104, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 105, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 106, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
    { actual: 107, xgb_pred: 100, month_index: 7, FinancialYear: "2024-25", Month: "November" },
    { actual: 108, xgb_pred: 100, month_index: 8, FinancialYear: "2024-25", Month: "December" },
    { actual: 109, xgb_pred: 100, month_index: 9, FinancialYear: "2024-25", Month: "January" },
    { actual: 110, xgb_pred: 100, month_index: 10, FinancialYear: "2024-25", Month: "February" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.status, "FORECAST_ERROR_BASED");
  assert.strictEqual(stats.observationCount, 10);
  assert.strictEqual(stats.underForecastCount, 10);

  // 90th percentile of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] is 9.1, rounds to 9
  assert.strictEqual(stats.safetyStock, 9);
});

test("calculateSafetyStockForMaterial: Safety Stock is integer", () => {
  const observations = [
    { actual: 100.7, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 102.3, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 103.9, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 105.2, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 106.8, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 108.1, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.status, "FORECAST_ERROR_BASED");
  assert.ok(Number.isInteger(stats.safetyStock));
  assert.ok(stats.safetyStock >= 0);
});

test("calculateSafetyStockForMaterial: Safety Stock is non-negative", () => {
  const observations = [
    { actual: 100.1, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 100.2, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 100.1, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 100.3, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 100.2, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 100.1, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.ok(stats.safetyStock >= 0);
});

test("calculateSafetyStockForMaterial: Safety Stock is finite", () => {
  const observations = [
    { actual: 110, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 120, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 115, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 125, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 130, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 135, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.ok(Number.isFinite(stats.safetyStock));
});

test("calculateSafetyStockForMaterial: MAE and RMSE are calculated", () => {
  const observations = [
    { actual: 110, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 90, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 115, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 85, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 120, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 95, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.ok(Number.isFinite(stats.mae));
  assert.ok(stats.mae >= 0);
  assert.ok(Number.isFinite(stats.rmse));
  assert.ok(stats.rmse >= 0);
  assert.ok(Number.isFinite(stats.meanUnderforecast));
  assert.ok(stats.meanUnderforecast >= 0);
});

test("calculateSafetyStockForMaterial: percentile field is set", () => {
  const observations = [
    { actual: 110, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 120, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 115, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 125, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 130, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 135, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.strictEqual(stats.percentile, UNDERFORECAST_PERCENTILE);
  assert.strictEqual(stats.percentile, 0.90);
});

test("calculateSafetyStockForMaterial: lastEvaluatedPeriod is set to most recent", () => {
  const observations = [
    { actual: 110, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 120, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 115, xgb_pred: 100, month_index: 10, FinancialYear: "2025-26", Month: "February" },
    { actual: 125, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 130, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 135, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  // Most recent is month_index 10
  assert.strictEqual(stats.lastEvaluatedPeriod, "2025-26|February");
});

test("calculateSafetyStockForMaterial: calculatedAt is a Date", () => {
  const observations = [
    { actual: 110, xgb_pred: 100, month_index: 1, FinancialYear: "2024-25", Month: "May" },
    { actual: 120, xgb_pred: 100, month_index: 2, FinancialYear: "2024-25", Month: "June" },
    { actual: 115, xgb_pred: 100, month_index: 3, FinancialYear: "2024-25", Month: "July" },
    { actual: 125, xgb_pred: 100, month_index: 4, FinancialYear: "2024-25", Month: "August" },
    { actual: 130, xgb_pred: 100, month_index: 5, FinancialYear: "2024-25", Month: "September" },
    { actual: 135, xgb_pred: 100, month_index: 6, FinancialYear: "2024-25", Month: "October" },
  ];

  const stats = calculateSafetyStockForMaterial("MAT0001", observations);

  assert.ok(stats.calculatedAt instanceof Date);
});

test("MIN_BACKTEST_OBSERVATIONS constant is 6", () => {
  assert.strictEqual(MIN_BACKTEST_OBSERVATIONS, 6);
});

test("UNDERFORECAST_PERCENTILE constant is 0.90", () => {
  assert.strictEqual(UNDERFORECAST_PERCENTILE, 0.90);
});
