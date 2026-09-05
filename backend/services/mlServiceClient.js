/**
 * Thin HTTP client for the Python ML service (ml-service/). Uses Node's
 * built-in `fetch` (stable since Node 18) rather than adding axios/
 * node-fetch as a new dependency — Phase 4 explicitly says not to install
 * anything unnecessary, and native fetch already covers everything this
 * needs.
 *
 * This is the ONLY place the Node backend talks to the ML service. It
 * never touches MongoDB itself — it just calls HTTP endpoints and returns
 * whatever JSON comes back (or throws, on failure/unavailability), so the
 * caller (forecastController.js) decides what "the ML service is down"
 * should mean for the rest of the app (Section 15: Planning Master must
 * keep working with the existing WMA fallback either way).
 */
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 60_000;

async function callMlService(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ML_SERVICE_URL}${path}`, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ML service ${path} returned ${response.status}: ${body}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealth() {
  return callMlService("/health");
}

/**
 * Returns { modelVersion, horizonMonths, startFinancialYear, dataSource,
 *            forecasts: [...] } — see ml-service/app/forecast.py.
 *
 * startFinancialYear: optional FY label string (e.g. "2027-28") that
 * anchors the forecast window — the ML service fast-forwards to this
 * FY before emitting rows, so the first emitted month is April of that
 * FY. Absent = existing behavior (forecast from next month onward).
 */
async function requestForecast({ horizonMonths = 12, startFinancialYear } = {}) {
  const body = { horizonMonths };
  if (startFinancialYear) body.startFinancialYear = startFinancialYear;
  return callMlService("/forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Returns the WMA vs XGBoost backtest comparison — see ml-service/app/backtest.py. */
async function requestBacktest() {
  return callMlService("/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

module.exports = { checkHealth, requestForecast, requestBacktest, ML_SERVICE_URL };
