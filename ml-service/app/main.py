"""
StockNest ML Service — Phase 4.

HTTP is the integration mechanism with the Node backend (Phase 4 Section
14's preference). This service does its own MongoDB read (via
data_loader.py) rather than having Node push data to it — Node still owns
all MongoDB *writes* (Section 14: "Node should handle... MongoDB
application access"); this service only ever reads Sales history and
returns computed results over HTTP, never writes to MongoDB itself.

Endpoints:
  GET  /health              — liveness check, and which data source is reachable
  POST /backtest             — runs the full WMA vs XGBoost chronological backtest,
                                returns overall + segment-level results
  POST /forecast              — trains a production model on all available history
                                and returns a 12-month-ahead forecast per Material+Plant

Run with: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.config import MODEL_VERSION
from app.data_loader import load_sales_history
from app.features import build_feature_table
from app.backtest import run_backtest, summarize, segment_summary
from app.multi_step_backtest import run_multi_step_backtest, horizon_profile, segment_by_horizon, summarize_multi_step
from app.forecast import generate_forecasts

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stocknest_ml.main")

app = FastAPI(title="StockNest ML Service", version=MODEL_VERSION)


class ForecastRequest(BaseModel):
    horizonMonths: int = 6  # Phase B: production horizon reduced from 12 to 6
    startFinancialYear: Optional[str] = None  # optional FY label anchor, e.g. "2027-28"


class BacktestRequest(BaseModel):
    maxHorizon: int = 6  # Phase B: backtest capped at the production horizon (6); 1 would reduce to Phase 4's original single-step behavior


@app.get("/health")
def health():
    try:
        df, source = load_sales_history()
        return {"status": "ok", "dataSource": source, "salesRowsAvailable": len(df), "modelVersion": MODEL_VERSION}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Data source unavailable: {exc}") from exc


@app.post("/backtest")
def backtest(req: BacktestRequest = BacktestRequest()):
    """
    Runs the full chronological expanding-window backtest (Phase 4 Section
    9) and returns WMA vs XGBoost comparison — overall and segment-level
    (by Material, by Plant). Reproducible: no randomness in the walk-
    forward split, fixed random_state on the model itself.

    PHASE 6: also runs the genuine recursive multi-step walk-forward
    evaluation (horizons 1..maxHorizon) — see multi_step_backtest.py for
    the full leakage-prevention methodology. All Phase 4/5 fields
    (`overall`, `byMaterial`, `byPlant`, `evaluatedRows`) are preserved
    exactly as before; the new `multiStep` key is purely additive, so
    nothing that already consumed this endpoint's response breaks.
    """
    try:
        df, source = load_sales_history()
        feat = build_feature_table(df)
        results = run_backtest(feat)

        wma_overall = summarize(results, "wma_pred")
        xgb_overall = summarize(results, "xgb_pred")

        def improvement(wma_val, xgb_val):
            if not wma_val or wma_val == 0:
                return None
            return round((wma_val - xgb_val) / wma_val * 100, 1)

        multi_step_results = run_multi_step_backtest(feat, max_horizon=req.maxHorizon)
        profile = horizon_profile(multi_step_results)

        return {
            "dataSource": source,
            "evaluatedRows": len(results),
            "overall": {
                "wma": wma_overall,
                "xgboost": xgb_overall,
                "improvementPct": {
                    "WMAPE": improvement(wma_overall["WMAPE"], xgb_overall["WMAPE"]),
                    "MAE": improvement(wma_overall["MAE"], xgb_overall["MAE"]),
                    "RMSE": improvement(wma_overall["RMSE"], xgb_overall["RMSE"]),
                },
            },
            "byMaterial": segment_summary(results, "MatNo"),
            "byPlant": segment_summary(results, "Plant"),
            "multiStep": {
                "maxHorizon": req.maxHorizon,
                "originsEvaluated": sorted(multi_step_results["origin"].unique().tolist()) if len(multi_step_results) else [],
                "seriesEvaluated": int(multi_step_results[["MatNo", "Plant"]].drop_duplicates().shape[0]) if len(multi_step_results) else 0,
                "totalObservations": len(multi_step_results),
                "overall": {
                    "xgboost": summarize_multi_step(multi_step_results, "xgb_pred"),
                    "wma": summarize_multi_step(multi_step_results, "wma_pred"),
                },
                "horizons": profile,
                "byMaterialAndHorizon": segment_by_horizon(multi_step_results, "MatNo"),
                "byPlantAndHorizon": segment_by_horizon(multi_step_results, "Plant"),
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Backtest failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/forecast")
def forecast(req: ForecastRequest):
    """
    Trains a production model on ALL currently available Sales history and
    returns a recursive month-by-month forecast per Material+Plant, up to
    `horizonMonths` ahead (default 12 — a full financial year). Series
    with insufficient history automatically fall back to WMA — see
    forecast.py's top comment.
    """
    try:
        df, source = load_sales_history()
        result = generate_forecasts(df, horizon_months=req.horizonMonths, start_financial_year=req.startFinancialYear)
        result["dataSource"] = source
        return result
    except Exception as exc:  # noqa: BLE001
        logger.exception("Forecast generation failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
