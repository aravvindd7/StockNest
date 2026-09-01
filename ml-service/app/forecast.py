"""
Live forecast generation — separate from backtest.py (Phase 4 Section 18:
"Separate TRAINING/BACKTESTING from LIVE FORECAST INFERENCE").

Produces a 12-month-ahead forecast (the next financial year's worth of
months) per Material+Plant series, by:
  1. Training ONE XGBoost model on ALL currently available history
     (not a walk-forward backtest — this is the production model).
  2. RECURSIVELY forecasting forward one month at a time: month N+1 uses
     only real historical data; month N+2's lag/rolling features are then
     built using month N+1's *prediction* (there is no way around this for
     a multi-month-ahead forecast built from lag features — it's a
     standard, well-understood limitation, not a leakage bug, and is
     documented explicitly in the returned response and in the Phase 4
     report: prediction error can compound across the 12-month horizon,
     so later months in the window are inherently less certain than the
     first).

Fallback strategy (Phase 4 Section 12): any Material+Plant series with
fewer than MIN_TRAINING_MONTHS of real history is skipped entirely by
XGBoost and flagged `"model": "WMA_FALLBACK"` with a WMA-based forecast
instead — never a meaningless prediction from an undertrained model.
"""
from typing import Dict, List

import numpy as np
import pandas as pd
import xgboost as xgb

from app.config import MIN_TRAINING_MONTHS, MODEL_VERSION
from app.features import ALL_FEATURES, CATEGORICAL_FEATURES, TARGET, build_feature_table, to_categorical_dtypes, build_recursive_step_row, MONTH_ORDER, QUARTER_BY_MONTH
from app.wma_baseline import wma_predict
from app.backtest import run_backtest, segment_summary
from app.multi_step_backtest import run_multi_step_backtest, horizon_profile
from app.intelligence import (
    confidence_tier_from_wmape, numeric_confidence_from_wmape, apply_horizon_decay,
    empirical_horizon_multipliers, apply_empirical_horizon_adjustment,
    detect_trend, detect_seasonality, build_reason,
)


def _next_month(financial_year: str, month: str):
    """Returns (next_financial_year, next_month) for the April-March calendar."""
    idx = MONTH_ORDER.index(month)
    if idx < 11:
        return financial_year, MONTH_ORDER[idx + 1]
    start_year = int(financial_year.split("-")[0])
    next_fy = f"{start_year + 1}-{str((start_year + 2) % 100).zfill(2)}"
    return next_fy, MONTH_ORDER[0]


def train_production_model(feat: pd.DataFrame) -> xgb.XGBRegressor:
    trainable = feat.dropna(subset=["lag1"])  # exclude rows with literally no prior history at all
    model = xgb.XGBRegressor(
        n_estimators=300, max_depth=4, learning_rate=0.06, subsample=0.9, colsample_bytree=0.9,
        tree_method="hist", enable_categorical=True, random_state=42, missing=np.nan,
    )
    model.fit(trainable[ALL_FEATURES], trainable[TARGET])
    return model


def generate_forecasts(sales_df: pd.DataFrame, horizon_months: int = 12) -> Dict:
    """
    Returns {
      "modelVersion": "...", "horizonMonths": 12,
      "forecasts": [ { materialNo, plant, financialYear, month, quarter,
                        predictedSalesQty, model, monthsAheadInHorizon,
                        confidence, confidenceTier, confidenceReason,
                        segmentWmape, historyMonths, trend, seasonality,
                        reason }, ... ]
    }

    Confidence/trend/seasonality/reason are computed ONCE per generation
    call (not per Planning Master page view — see this phase's Part 1
    audit requirement "Planning Master does not retrain the model on
    every page load," which this preserves: none of this runs unless
    /forecast is explicitly called).
    """
    feat = build_feature_table(sales_df)
    feat_cat = to_categorical_dtypes(feat)
    model = train_production_model(feat_cat)

    # Segment-level backtest performance, computed once, reused for every
    # forecast row's confidence — this is real measured evidence (Part 2's
    # explicit requirement), not an arbitrary percentage. Material-level
    # (not Material+Plant) to match how Planning Master displays forecasts
    # (aggregated across plants per material).
    backtest_results = run_backtest(feat)
    material_wmape = {
        s["MatNo"]: s["xgboost"]["WMAPE"] for s in segment_summary(backtest_results, "MatNo")
    }

    # PHASE 6: the empirical multi-step horizon profile, computed once per
    # generation call via a genuine recursive walk-forward backtest — see
    # multi_step_backtest.py. Replaces Phase 5's structural horizon-decay
    # assumption with real measured evidence. If this fails for any reason
    # (should not normally happen), fall back to no horizon adjustment
    # rather than crashing forecast generation entirely.
    try:
        multi_step_results = run_multi_step_backtest(feat, max_horizon=horizon_months)
        horizon_multipliers = empirical_horizon_multipliers(horizon_profile(multi_step_results))
    except Exception:  # noqa: BLE001
        horizon_multipliers = None

    # Trend/seasonality per material, computed from RAW sales history
    # (summed across plants for trend; grouped by Quarter for seasonality)
    # — same methodology Phase 3's independent audit used, reused rather
    # than reinvented.
    material_trend: Dict[str, Dict] = {}
    material_seasonality: Dict[str, Dict] = {}
    for matno, mat_rows in sales_df.groupby("MatNo"):
        monthly_totals = (
            mat_rows.groupby(["FinancialYear", "Month"])["SalesQty"].sum()
            .reset_index()
        )
        fy_order = sorted(monthly_totals["FinancialYear"].unique())
        monthly_totals["_chrono"] = monthly_totals.apply(
            lambda r: fy_order.index(r["FinancialYear"]) * 12 + MONTH_ORDER.index(r["Month"]), axis=1
        )
        chronological_values = monthly_totals.sort_values("_chrono")["SalesQty"].tolist()
        material_trend[matno] = detect_trend(chronological_values)
        material_seasonality[matno] = detect_seasonality(mat_rows)

    all_categories = {col: feat_cat[col].cat.categories for col in CATEGORICAL_FEATURES}

    forecasts: List[Dict] = []
    series_keys = feat[["MatNo", "Plant"]].drop_duplicates().values.tolist()

    for matno, plant in series_keys:
        series = feat[(feat["MatNo"] == matno) & (feat["Plant"] == plant)].sort_values("month_index").reset_index(drop=True)
        n_real_months = len(series)
        last = series.iloc[-1]
        material_group = last["MatGroupName"]
        production_cycle = last["ProductionCycle"]

        history_values = list(series[TARGET].values)  # will be extended with predictions as we roll forward
        fy, month = last["FinancialYear"], last["Month"]

        use_wma_fallback = n_real_months < MIN_TRAINING_MONTHS

        segment_wmape = material_wmape.get(matno)
        trend = material_trend.get(matno, {"label": "insufficient_history", "pctPerYear": None})
        seasonality = material_seasonality.get(matno, {"label": "insufficient_history", "strength": None, "peakQuarter": None})

        for step in range(1, horizon_months + 1):
            fy, month = _next_month(fy, month)
            quarter = QUARTER_BY_MONTH[month]

            if use_wma_fallback:
                pred = wma_predict(pd.Series(history_values), window=min(3, len(history_values)))
                pred = 0.0 if (pred is None or np.isnan(pred)) else pred
                model_used = "WMA_FALLBACK"
            else:
                row = build_recursive_step_row(
                    history_values, matno, plant, production_cycle, material_group, month, quarter,
                    last["financial_year_index"] + ((n_real_months + step - 1) // 12),
                )
                X = pd.DataFrame([row])
                for col in CATEGORICAL_FEATURES:
                    X[col] = pd.Categorical([row[col]], categories=all_categories[col])
                pred = float(model.predict(X[ALL_FEATURES])[0])
                pred = max(0.0, pred)
                model_used = "XGBoost"

            history_values.append(pred)  # recursive: this step's prediction feeds the next step's lag features

            if model_used == "WMA_FALLBACK":
                confidence = 55  # matches the existing pre-ML floor for "insufficient data" cases, not a new arbitrary number
                tier = "LOW"
                horizon_adjusted_wmape = None
            else:
                horizon_adjusted_wmape = apply_empirical_horizon_adjustment(segment_wmape, step, horizon_multipliers)
                if horizon_adjusted_wmape is not None:
                    confidence = numeric_confidence_from_wmape(horizon_adjusted_wmape)
                    tier = confidence_tier_from_wmape(horizon_adjusted_wmape)
                else:
                    # No horizon evidence at all (multi-step backtest unavailable) — fall back to the
                    # Phase 5 structural assumption rather than showing an unadjusted, overconfident number.
                    confidence = apply_horizon_decay(numeric_confidence_from_wmape(segment_wmape), step)
                    tier = confidence_tier_from_wmape(segment_wmape)

            reason = build_reason(model_used, f"{quarter} {fy}", trend, seasonality, tier, segment_wmape, step, horizon_adjusted_wmape)

            forecasts.append({
                "materialNo": matno, "plant": plant, "financialYear": fy, "month": month, "quarter": quarter,
                "predictedSalesQty": round(pred, 1), "model": model_used, "modelVersion": MODEL_VERSION,
                "monthsAheadInHorizon": step,
                "confidence": confidence, "confidenceTier": tier,
                "segmentWmape": segment_wmape, "horizonAdjustedWmape": horizon_adjusted_wmape,
                "historyMonths": n_real_months,
                "trend": trend["label"], "seasonality": seasonality["label"],
                "seasonalityPeakQuarter": seasonality.get("peakQuarter"),
                "reason": reason,
            })

    return {"modelVersion": MODEL_VERSION, "horizonMonths": horizon_months, "forecasts": forecasts}
