/**
 * Stage 3: Tests for statistics utilities (percentile calculation).
 *
 * Verifies deterministic percentile calculation using linear interpolation.
 *
 * Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { percentile } = require("../utils/statistics");

test("percentile: 90th percentile of [5, 10, 15, 20, 25] is 23", () => {
  const result = percentile([5, 10, 15, 20, 25], 0.90);
  assert.strictEqual(result, 23);
});

test("percentile: 50th percentile (median) of [1, 2, 3, 4, 5]", () => {
  const result = percentile([1, 2, 3, 4, 5], 0.50);
  assert.strictEqual(result, 3);
});

test("percentile: 0th percentile is the minimum", () => {
  const result = percentile([10, 20, 30, 40, 50], 0);
  assert.strictEqual(result, 10);
});

test("percentile: 100th percentile is the maximum", () => {
  const result = percentile([10, 20, 30, 40, 50], 1.0);
  assert.strictEqual(result, 50);
});

test("percentile: single value returns that value", () => {
  const result = percentile([42], 0.90);
  assert.strictEqual(result, 42);
});

test("percentile: unsorted input is handled correctly", () => {
  const result = percentile([25, 5, 20, 10, 15], 0.90);
  assert.strictEqual(result, 23);
});

test("percentile: 90th percentile with duplicate values", () => {
  const result = percentile([1, 1, 1, 10, 10], 0.90);
  assert.strictEqual(result, 10);
});

test("percentile: throws on empty array", () => {
  assert.throws(
    () => percentile([], 0.5),
    /non-empty array/
  );
});

test("percentile: throws on invalid p < 0", () => {
  assert.throws(
    () => percentile([1, 2, 3], -0.1),
    /between 0 and 1/
  );
});

test("percentile: throws on invalid p > 1", () => {
  assert.throws(
    () => percentile([1, 2, 3], 1.1),
    /between 0 and 1/
  );
});

test("percentile: throws on non-finite values in array", () => {
  assert.throws(
    () => percentile([1, 2, NaN, 4], 0.5),
    /finite numbers/
  );
});

test("percentile: throws on Infinity in array", () => {
  assert.throws(
    () => percentile([1, 2, Infinity, 4], 0.5),
    /finite numbers/
  );
});

test("percentile: large array with 90th percentile", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1 to 100
  const result = percentile(values, 0.90);
  // 90th percentile of 1..100 is 90.1 using linear interpolation
  assert.ok(Math.abs(result - 90.1) < 0.01);
});

test("percentile: does not mutate original array", () => {
  const values = [5, 3, 1, 4, 2];
  const copy = [...values];
  percentile(values, 0.5);
  assert.deepStrictEqual(values, copy);
});
