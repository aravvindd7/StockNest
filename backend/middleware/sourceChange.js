/**
 * recordsSourceChange("sales") — marks a route as a source-data operation.
 *
 * After the response has been sent, and only if the operation SUCCEEDED (2xx)
 * and was not an idempotent replay, it records ONE source-change event for the
 * whole request — so a 9,072-row import is one event, never one per row. The
 * derived-data pipeline (services/derivedDataPipeline.js) coalesces events and
 * brings the forecast and recommendations up to date. A failed operation
 * (4xx/5xx) records nothing.
 */
const pipeline = require("../services/derivedDataPipeline");

function recordsSourceChange(...sources) {
  const middleware = (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || res.get("Idempotent-Replay") === "true") return;
      pipeline.recordSourceChange(sources, { reason: `${req.method} ${req.baseUrl}${req.route?.path || ""}` })
        .catch((err) => console.error("[derived] could not record source change:", err.message));
    });
    next();
  };
  middleware.sourceChange = sources.join(","); // introspection (route-wiring tests)
  return middleware;
}

module.exports = { recordsSourceChange };
