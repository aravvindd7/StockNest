"""
Multi-step recursive walk-forward backtest — Phase 6.

Extends Phase 4's single-horizon backtest.py to answer: how does XGBoost's
forecast error actually change as the forecast horizon increases? Every
number this produces is measured, not assumed — see intelligence.py for
how the result calibrates confidence.

WHY RECURSIVE, NOT INDEPENDENT ONE-STEP PREDICTIONS AT EACH HORIZON
(Section 6's explicit, most important requirement): the production
forecast (forecast.py) is recursive — month N+2's features are built from
month N+1's PREDICTION, not its actual value, because at true live
forecast time the actual doesn't exist yet. Evaluating horizon 2 using the
REAL month-N+1 actual (rather than the model's own month-N+1 prediction)
would make the backtest measure a different, easier problem than what
production actually does — an artificially optimistic result. So this
file reuses features.build_recursive_step_row (the exact same function
forecast.py uses for live inference) and, at every step beyond horizon 1,
feeds it each series' own running prediction chain, never the real future
value. The one and only place a real actual value is used is horizon 1's
lag/rolling features, which are built from real history that already
existed before the forecast origin — legitimate, not leakage.

WHY ONE MODEL PER ORIGIN, NOT ONE PER (ORIGIN, HORIZON)
Per Section 9 ("train a fresh XGBoost model" at every origin) and Section
4 ("preserve the existing forecasting grain... the existing global
XGBoost model remains the forecasting model") — one model is trained per
origin on all data strictly before it, then used to recursively predict
every horizon at that origin. This mirrors production exactly: one model
trained "now," asked to forecast 12 months into the future recursively —
not 12 separately-trained models.

ORIGINS: every month_index with >= MIN_TRAINING_MONTHS of prior history
(the same eligibility rule backtest.py's single-horizon version already
uses) is a valid origin. At each origin, only the horizons that have a
real actual to compare against are evaluated (origins near the end of the
dataset naturally get fewer evaluable horizons) — this is determined
automatically from the data, never hard-coded (Section 8).
"""
from typing import Dict, List

import numpy as np
import pandas as pd
import xgboost as xgb

from app.config import MIN_TRAINING_MONTHS
from app.features import ALL_FEATURES, CATEGORICAL_FEATURES, TARGET, to_categorical_dtypes, build_recursive_step_row, MONTH_ORDER, QUARTER_BY_MONTH
from app.wma_baseline import wma_predict
from app.backtest import wmape, mae, rmse


def determine_origins(max_month_index: int, min_training_months: int = MIN_TRAINING_MONTHS) -> List[int]:
    """Every month_index that could serve as a Horizon-1 forecast target, given enough prior history to train on."""
    return list(range(min_training_months, max_month_index + 1))


def run_multi_step_backtest(feat: pd.DataFrame, max_horizon: int = 12, min_training_months: int = MIN_TRAINING_MONTHS) -> pd.DataFrame:
    """
    feat: output of features.build_feature_table (must include month_index).
    Returns a row-level DataFrame: one row per (MatNo, Plant, origin,
    horizon) evaluated prediction — actual, xgb_pred, wma_pred — ready for
    horizon-level, material-level, plant-level, and material x horizon
    aggregation.
    """
    feat_cat = to_categorical_dtypes(feat)
    max_month_index = int(feat["month_index"].max())
    all_categories = {col: feat_cat[col].cat.categories for col in CATEGORICAL_FEATURES}

    origins = determine_origins(max_month_index, min_training_months)
    series_keys = feat[["MatNo", "Plant"]].drop_duplicates().values.tolist()

    series_actuals: Dict = {}
    series_meta: Dict = {}
    for matno, plant in series_keys:
        s = feat[(feat["MatNo"] == matno) & (feat["Plant"] == plant)].sort_values("month_index")
        series_actuals[(matno, plant)] = dict(zip(s["month_index"], s[TARGET]))
        last_row = s.iloc[-1]
        series_meta[(matno, plant)] = {"material_group": last_row["MatGroupName"], "production_cycle": last_row["ProductionCycle"]}

    result_rows: List[Dict] = []

    for origin in origins:
        train_df = feat_cat[feat_cat["month_index"] < origin]
        if train_df.empty:
            continue
        max_evaluable_h = min(max_horizon, max_month_index - origin + 1)
        if max_evaluable_h < 1:
            continue

        model = xgb.XGBRegressor(
            n_estimators=200, max_depth=4, learning_rate=0.08, subsample=0.9, colsample_bytree=0.9,
            tree_method="hist", enable_categorical=True, random_state=42, missing=np.nan,
        )
        model.fit(train_df[ALL_FEATURES], train_df[TARGET])

        xgb_histories: Dict = {}
        wma_histories: Dict = {}
        for matno, plant in series_keys:
            actuals_by_idx = series_actuals[(matno, plant)]
            real_history = [actuals_by_idx[i] for i in sorted(actuals_by_idx) if i < origin]
            if real_history:
                xgb_histories[(matno, plant)] = list(real_history)
                wma_histories[(matno, plant)] = list(real_history)

        for h in range(1, max_evaluable_h + 1):
            target_month_index = origin + h - 1
            batch_rows, batch_keys = [], []
            for key, xgb_hist in xgb_histories.items():
                actuals_by_idx = series_actuals[key]
                if target_month_index not in actuals_by_idx:
                    continue
                fy_idx, month_idx = divmod(target_month_index, 12)
                month = MONTH_ORDER[month_idx]
                quarter = QUARTER_BY_MONTH[month]
                meta = series_meta[key]
                # LEAKAGE-PREVENTION: xgb_hist contains real actuals only up
                # to `origin`, plus this series' own prior PREDICTIONS from
                # earlier horizon steps — never the real actual for
                # target_month_index or anything after it.
                row_feat = build_recursive_step_row(xgb_hist, key[0], key[1], meta["production_cycle"], meta["material_group"], month, quarter, fy_idx)
                batch_rows.append(row_feat)
                batch_keys.append(key)

            if not batch_rows:
                break

            X_batch = pd.DataFrame(batch_rows)
            for col in CATEGORICAL_FEATURES:
                X_batch[col] = pd.Categorical(X_batch[col], categories=all_categories[col])
            preds = np.clip(model.predict(X_batch[ALL_FEATURES]), a_min=0, a_max=None)

            for key, pred in zip(batch_keys, preds):
                xgb_histories[key].append(float(pred))

                wma_hist = wma_histories[key]
                wma_pred = wma_predict(pd.Series(wma_hist), window=min(3, len(wma_hist)))
                wma_pred = 0.0 if (wma_pred is None or np.isnan(wma_pred)) else wma_pred
                wma_histories[key].append(wma_pred)

                result_rows.append({
                    "MatNo": key[0], "Plant": key[1], "origin": origin, "horizon": h,
                    "month_index": target_month_index,
                    "actual": series_actuals[key][target_month_index],
                    "xgb_pred": float(pred), "wma_pred": wma_pred,
                })

    return pd.DataFrame(result_rows)


def summarize_multi_step(results: pd.DataFrame, pred_col: str) -> Dict:
    valid = results.dropna(subset=[pred_col, "actual"])
    if valid.empty:
        return {"n": 0, "wmape": None, "mae": None, "rmse": None}
    actual = valid["actual"].values
    forecast = valid[pred_col].values
    return {
        "n": int(len(valid)),
        "wmape": round(wmape(actual, forecast), 2),
        "mae": round(mae(actual, forecast), 2),
        "rmse": round(rmse(actual, forecast), 2),
    }


def horizon_profile(results: pd.DataFrame) -> Dict[str, Dict]:
    """{ "1": {xgboost: {...}, wma: {...}}, "2": {...}, ... } — the primary output of this phase."""
    profile = {}
    for h, grp in results.groupby("horizon"):
        profile[str(int(h))] = {
            "xgboost": summarize_multi_step(grp, "xgb_pred"),
            "wma": summarize_multi_step(grp, "wma_pred"),
        }
    return profile


def segment_by_horizon(results: pd.DataFrame, group_col: str) -> List[Dict]:
    """Material x Horizon or Plant x Horizon breakdown."""
    out = []
    for (key, h), grp in results.groupby([group_col, "horizon"]):
        out.append({
            group_col: key, "horizon": int(h), "n": int(len(grp)),
            "xgboost": summarize_multi_step(grp, "xgb_pred"),
            "wma": summarize_multi_step(grp, "wma_pred"),
        })
    return out
