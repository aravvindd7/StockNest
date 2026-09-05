"""
Configuration for the StockNest ML service.

Reads MONGO_URI/MONGO_DB from the environment (matching the pattern the
existing Node backend already uses in its own .env) — no credentials are
hardcoded, and this file never reads or writes the Node backend's .env
directly (Phase 4 Section: "DO NOT modify .env files or expose credentials").

EXCEL_FALLBACK_PATH points at the frozen, Phase-3-audited synchronized
dataset. It exists so this service is runnable and its backtest results
reproducible in any environment that doesn't have a live MongoDB
connection available (e.g. this development/demo environment) — see
data_loader.py's top comment for the full reasoning. In a real deployment
with MONGO_URI set and reachable, MongoDB is used exclusively; the Excel
path is never touched.
"""
import os
from pathlib import Path

MONGO_URI = os.environ.get("MONGO_URI", "")
MONGO_DB = os.environ.get("MONGO_DB", "stocknest")

# Default: a local-dev convenience location inside ml-service itself. The
# synchronized dataset was deliberately generated OUTSIDE the application
# folder (Phase 3's "do not modify the StockNest application" scope), so
# this service never assumes where that folder lives on a given machine —
# copy 04_Sales_Master.xlsx here for local backtesting, or set
# SALES_EXCEL_FALLBACK_PATH to point at it directly. Neither is required
# in production, where MONGO_URI is used exclusively.
_DEFAULT_EXCEL_PATH = Path(__file__).resolve().parents[1] / "data" / "04_Sales_Master.xlsx"
EXCEL_FALLBACK_PATH = Path(os.environ.get("SALES_EXCEL_FALLBACK_PATH", str(_DEFAULT_EXCEL_PATH)))

# Minimum months of prior history required before a model attempts a
# prediction for a Material+Plant series — Phase 4 Section 9/12.
MIN_TRAINING_MONTHS = 12

# Production training window (months of most-recent history used to train).
# Phase B: empirically benchmarked as optimal (10.19% overall WMAPE vs
# 12.06% for full history) — an 18-month rolling window of the latest
# available sales per Material+Plant series.
TRAINING_WINDOW_MONTHS = 18

# Production forecast horizon (months ahead).
# Phase B: reduced from 12 (a full FY) to 6 — see ForecastRequest default.
FORECAST_HORIZON_MONTHS = 6

MODEL_VERSION = "v1"

# Cap for the empirical multi-step backtest horizon. Horizons beyond this
# are sparsely evaluable (insufficient trailing actuals for origins), and
# apply_empirical_horizon_adjustment already falls back to the max measured
# multiplier — so running the backtest past this adds cost without benefit.
#
# Phase B: capped at FORECAST_HORIZON_MONTHS (6) to mirror the production
# horizon exactly — confidence is calibrated on the same H1-H6 range the
# production forecast produces.
EMPIRICAL_BACKTEST_MAX_HORIZON = FORECAST_HORIZON_MONTHS
