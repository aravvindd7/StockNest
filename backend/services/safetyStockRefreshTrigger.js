const safetyStockService = require("./safetyStockService");

let pending = false;
let running = null;

// Serialize refreshes in this process. Mutations completed during a refresh
// request a trailing run, since the in-flight backtest may predate their data.
function refreshAfterSalesMutation() {
  pending = true;
  if (!running) {
    running = Promise.resolve().then(async () => {
      try {
        while (pending) {
          pending = false;
          try {
            const summary = await safetyStockService.refreshForecastErrorStats();
            if (summary.errors > 0) {
              console.error("[safetyStockRefresh] Sales mutation succeeded, but some ForecastErrorStats updates failed:", summary.errors);
            }
          } catch (error) {
            console.error("[safetyStockRefresh] Sales mutation succeeded, but ForecastErrorStats refresh failed:", error.message);
          }
        }
      } finally {
        running = null;
      }
    });
  }
  return running;
}

module.exports = { refreshAfterSalesMutation };
