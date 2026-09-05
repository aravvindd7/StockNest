"""
Chronological expanding-window backtest — Phase 4 Section 9, run under a
SINGLE, GLOBAL walk-forward clock (not one clock per Material+Plant
series). This is a deliberate interpretation worth stating explicitly:

Every one of the 37 Material+Plant series in the synchronized dataset
shares the exact same 36-month calendar (Phase 3 confirmed 100% period
completeness), so "the next month" is the same calendar month for every
series at every step. XGBoost's whole value proposition here is learning
CROSS-SERIES patterns via Material/Plant as categorical features — a
model retrained separately per series would never see more than one
constant category value and those features would be structurally useless.
So: ONE global model is retrained at each walk-forward step on every
series' history up to that point, and used to predict that same step's
target month across all series at once. WMA needs no training step (it's
a stateless function of each series' own recent history) but is evaluated
on the exact same (series, month) pairs at the exact same steps, which is
what makes the comparison fair (Section 10).

No random splitting anywhere in this file. No step ever trains on a row
whose month_index >= the step being predicted.
"""
from typing import Dict, List

import numpy as np
import pandas as pd
import xgboost as xgb

from app.config import MIN_TRAINING_MONTHS, TRAINING_WINDOW_MONTHS
from app.features import ALL_FEATURES, CATEGORICAL_FEATURES, TARGET, to_categorical_dtypes
from app.wma_baseline import wma_predict


def wmape(actual: np.ndarray, forecast: np.ndarray) -> float:
    denom = np.sum(np.abs(actual))
    if denom == 0:
        return float("nan")
    return float(100 * np.sum(np.abs(actual - forecast)) / denom)


def mae(actual: np.ndarray, forecast: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - forecast)))


def rmse(actual: np.ndarray, forecast: np.ndarray) -> float:
    return float(np.sqrt(np.mean((actual - forecast) ** 2)))


def run_backtest(feat: pd.DataFrame, min_training_months: int = MIN_TRAINING_MONTHS, training_window_months: int = TRAINING_WINDOW_MONTHS) -> pd.DataFrame:
    """
    feat: output of features.build_feature_table (must include month_index).
    Returns a row-level DataFrame: one row per (MatNo, Plant, month_index)
    backtest prediction, with columns actual, wma_pred, xgb_pred — ready
    for both overall and segment-level metric aggregation.

    Phase B: each step trains on the most recent training_window_months
    (18) of history before the step — the same rolling window as the
    production model, so backtest and production see the same data.
    """
    feat = to_categorical_dtypes(feat)
    max_month_index = int(feat["month_index"].max())

    # A step is only evaluable once every category level that might appear
    # at prediction time has already been seen in training at least once —
    # trivially true here since all 37 series share month_index 0..35, so
    # eligibility is purely "is there enough prior history," same rule as
    # features.py's own NaN behavior.
    eval_steps = list(range(min_training_months, max_month_index + 1))

    rows: List[Dict] = []
    for step in eval_steps:
        train_df = feat[feat["month_index"] < step]
        if training_window_months:
            cutoff = step - training_window_months
            train_df = train_df[train_df["month_index"] >= cutoff]
        predict_df = feat[feat["month_index"] == step]
        if train_df.empty or predict_df.empty:
            continue

        # ---- XGBoost: retrain fresh at this step on everything known so far ----
        X_train = train_df[ALL_FEATURES]
        y_train = train_df[TARGET]
        X_predict = predict_df[ALL_FEATURES]

        model = xgb.XGBRegressor(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.08,
            subsample=0.9,
            colsample_bytree=0.9,
            tree_method="hist",
            enable_categorical=True,
            random_state=42,
            missing=np.nan,
        )
        model.fit(X_train, y_train)
        xgb_preds = model.predict(X_predict)
        xgb_preds = np.clip(xgb_preds, a_min=0, a_max=None)  # SalesQty can't be negative

        # ---- WMA: stateless, computed straight from each series' own raw history ----
        for i, (_, row) in enumerate(predict_df.iterrows()):
            series_history = feat[
                (feat["MatNo"] == row["MatNo"]) & (feat["Plant"] == row["Plant"]) & (feat["month_index"] < step)
            ].sort_values("month_index")[TARGET]
            wma_pred = wma_predict(series_history, window=3)

            rows.append({
                "MatNo": row["MatNo"], "Plant": row["Plant"], "MatGroupName": row["MatGroupName"],
                "FinancialYear": row["FinancialYear"], "Month": row["Month"], "month_index": step,
                "actual": row[TARGET], "xgb_pred": float(xgb_preds[i]), "wma_pred": wma_pred,
            })

    return pd.DataFrame(rows)


def summarize(results: pd.DataFrame, pred_col: str) -> Dict:
    valid = results.dropna(subset=[pred_col, "actual"])
    if valid.empty:
        return {"n": 0, "WMAPE": None, "MAE": None, "RMSE": None}
    actual = valid["actual"].values
    forecast = valid[pred_col].values
    return {
        "n": int(len(valid)),
        "WMAPE": round(wmape(actual, forecast), 2),
        "MAE": round(mae(actual, forecast), 2),
        "RMSE": round(rmse(actual, forecast), 2),
    }


def segment_summary(results: pd.DataFrame, group_col: str) -> List[Dict]:
    out = []
    for key, grp in results.groupby(group_col):
        wma_s = summarize(grp, "wma_pred")
        xgb_s = summarize(grp, "xgb_pred")
        out.append({group_col: key, "n": int(len(grp)), "wma": wma_s, "xgboost": xgb_s})
    return out
