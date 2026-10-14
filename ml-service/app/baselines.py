"""
Comparison baselines for the chronological backtest — Distribution Stage 2.

These exist so the forecasting model for Material x Plant (and therefore
Material x Depot) demand is chosen from backtest EVIDENCE, not assumption.
Nothing here replaces XGBoost or changes production forecasting: baselines
are evaluated on the exact same (series, month) rows as XGBoost inside
backtest.py, only when the caller opts in.

Leakage rule (same as features.py / wma_baseline.py): every function only
ever receives a series' history STRICTLY BEFORE the target month. A
baseline that lacks the history it needs returns NaN ("unavailable"),
never a fabricated number.

Baselines:
  seasonal_naive   — same month last year (month_index - 12)
  ma3 / ma6 / ma12 — equal-weight moving averages of the last 3/6/12 months
  seasonal_wma     — the existing 3-month linear WMA, run on deseasonalised
                     history and re-seasonalised for the target month
                     (seasonal indices from >= 24 months of prior history)
  croston / sba    — Croston's method and the Syntetos-Boylan Approximation,
                     the standard methods for intermittent demand; reported
                     separately for series classified intermittent/lumpy
                     (ADI >= 1.32, Syntetos-Boylan-Croston classification)
"""
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from app.wma_baseline import wma_predict

BASELINE_COLUMNS = ["snaive_pred", "ma3_pred", "ma6_pred", "ma12_pred", "seasonal_wma_pred", "croston_pred", "sba_pred"]
# Display name -> backtest row column, XGBoost and the existing WMA first.
MODEL_COLUMNS = {
    "xgboost": "xgb_pred",
    "wma3": "wma_pred",
    "seasonal_naive": "snaive_pred",
    "ma3": "ma3_pred",
    "ma6": "ma6_pred",
    "ma12": "ma12_pred",
    "seasonal_wma": "seasonal_wma_pred",
    "croston": "croston_pred",
    "sba": "sba_pred",
}

ADI_CUTOFF = 1.32   # Syntetos-Boylan average inter-demand interval cut-off
CV2_CUTOFF = 0.49   # squared coefficient of variation of non-zero demand sizes
CROSTON_ALPHA = 0.1
SEASONAL_MIN_HISTORY = 24  # two full years, so every month index has >= 2 observations


def seasonal_naive(history_by_index: Dict[int, float], target_index: int) -> float:
    value = history_by_index.get(target_index - 12)
    return float(value) if value is not None else np.nan


def moving_average(values: List[float], window: int) -> float:
    if len(values) < window:
        return np.nan
    return float(np.mean(values[-window:]))


def seasonal_wma(values: List[float], month_positions: List[int], target_position: int, window: int = 3) -> float:
    """
    values / month_positions: chronological history and each value's
    month-within-FY position (0=April ... 11=March). Seasonal index of a
    position = mean of that position / overall mean, from history only.
    """
    if len(values) < SEASONAL_MIN_HISTORY:
        return np.nan
    vals = np.asarray(values, dtype=float)
    pos = np.asarray(month_positions)
    overall = vals.mean()
    if overall <= 0:
        return np.nan
    index = {p: vals[pos == p].mean() / overall for p in range(12) if (pos == p).any()}
    needed = list(pos[-window:]) + [target_position]
    if any(index.get(p, 0) <= 0 for p in needed):
        return np.nan
    deseasonalised = pd.Series(vals[-window:] / np.array([index[p] for p in pos[-window:]]))
    base = wma_predict(deseasonalised, window=window)
    return float(base * index[target_position])


def classify_intermittency(values: List[float]) -> Optional[str]:
    """Syntetos-Boylan-Croston demand class: smooth | erratic | intermittent | lumpy (None without demand)."""
    vals = np.asarray(values, dtype=float)
    nonzero = vals[vals > 0]
    if len(vals) == 0 or len(nonzero) == 0:
        return None
    adi = len(vals) / len(nonzero)
    cv2 = (nonzero.std() / nonzero.mean()) ** 2 if len(nonzero) > 1 else 0.0
    if adi < ADI_CUTOFF:
        return "smooth" if cv2 < CV2_CUTOFF else "erratic"
    return "intermittent" if cv2 < CV2_CUTOFF else "lumpy"


def croston(values: List[float], alpha: float = CROSTON_ALPHA, sba: bool = False) -> float:
    """
    Croston's method: separately smooths non-zero demand size (z) and the
    interval between demands (p); forecast = z / p. SBA applies the
    (1 - alpha/2) bias correction. Returns 0 when the history has no demand.
    """
    z = p = None
    interval = 1
    for v in values:
        if v > 0:
            if z is None:
                z, p = float(v), float(interval)
            else:
                z = z + alpha * (v - z)
                p = p + alpha * (interval - p)
            interval = 1
        else:
            interval += 1
    if z is None:
        return 0.0
    forecast = z / p
    return float(forecast * (1 - alpha / 2) if sba else forecast)


def baseline_predictions(history: pd.DataFrame, target_index: int) -> Dict:
    """
    history: one series' rows strictly before target_index, with month_index
    and SalesQty, sorted chronologically. Returns every baseline prediction
    plus the series' demand class as of the forecast origin.
    """
    values = history["SalesQty"].astype(float).tolist()
    indices = history["month_index"].astype(int).tolist()
    positions = [i % 12 for i in indices]
    return {
        "snaive_pred": seasonal_naive(dict(zip(indices, values)), target_index),
        "ma3_pred": moving_average(values, 3),
        "ma6_pred": moving_average(values, 6),
        "ma12_pred": moving_average(values, 12),
        "seasonal_wma_pred": seasonal_wma(values, positions, target_index % 12),
        "croston_pred": croston(values),
        "sba_pred": croston(values, sba=True),
        "demand_class": classify_intermittency(values),
    }


# ─── Evaluation summaries ────────────────────────────────────────────────────

def _summ(frame: pd.DataFrame, col: str) -> Dict:
    from app.backtest import summarize  # local import: backtest.py imports this module
    return summarize(frame, col)


def _available_models(results: pd.DataFrame) -> Dict[str, str]:
    return {name: col for name, col in MODEL_COLUMNS.items() if col in results.columns}


def compare_models(results: pd.DataFrame, models: Optional[Dict[str, str]] = None) -> Dict:
    """
    Each model on all rows where it has a prediction, AND every model on the
    common rows where all of them do (the fair, like-for-like comparison).
    """
    models = models or _available_models(results)
    cols = list(models.values())
    common = results.dropna(subset=cols)
    per_model = {name: _summ(results, col) for name, col in models.items()}
    on_common = {name: _summ(common, col) for name, col in models.items()}
    ranked = sorted((m for m in on_common if on_common[m]["WMAPE"] is not None), key=lambda m: on_common[m]["WMAPE"])
    return {
        "models": per_model,
        "commonRows": {"n": int(len(common)), "models": on_common, "rankingByWMAPE": ranked},
    }


def baseline_evaluation(results: pd.DataFrame) -> Dict:
    """Overall comparison, plus a separate intermittent/lumpy-series comparison that includes Croston/SBA."""
    all_models = _available_models(results)
    regular = {k: v for k, v in all_models.items() if k not in ("croston", "sba")}
    intermittent_rows = results[results["demand_class"].isin(["intermittent", "lumpy"])] if "demand_class" in results else results.iloc[0:0]
    class_counts = results.drop_duplicates(["MatNo", "Plant"], keep="last")["demand_class"].value_counts().to_dict() if "demand_class" in results else {}
    return {
        "note": "Evidence only — XGBoost remains the production model; no model is selected automatically.",
        "overall": compare_models(results, regular),
        "intermittent": {
            "seriesRows": int(len(intermittent_rows)),
            "series": int(intermittent_rows[["MatNo", "Plant"]].drop_duplicates().shape[0]) if len(intermittent_rows) else 0,
            **(compare_models(intermittent_rows, all_models) if len(intermittent_rows) else {"models": {}, "commonRows": {"n": 0, "models": {}, "rankingByWMAPE": []}}),
        },
        "seriesDemandClassAtLastOrigin": {str(k): int(v) for k, v in class_counts.items()},
    }


def material_plant_summary(results: pd.DataFrame) -> List[Dict]:
    """Per Material x Plant accuracy for every available model, with the lowest-WMAPE model on that series' common rows."""
    models = _available_models(results)
    out = []
    for (matno, plant), grp in results.groupby(["MatNo", "Plant"]):
        cmp = compare_models(grp, models if grp.get("demand_class", pd.Series(dtype=object)).isin(["intermittent", "lumpy"]).any()
                             else {k: v for k, v in models.items() if k not in ("croston", "sba")})
        out.append({
            "MatNo": matno, "Plant": plant, "n": int(len(grp)),
            "models": cmp["models"],
            "bestModelOnCommonRows": cmp["commonRows"]["rankingByWMAPE"][0] if cmp["commonRows"]["rankingByWMAPE"] else None,
        })
    return out


def depot_summary(results: pd.DataFrame, plant_to_depot: Dict[str, str]) -> Dict:
    """
    Depot-level accuracy. Actuals and predictions are first summed across all
    plants mapped to the same depot for each (material, month), then scored —
    a depot's error is measured at the scale the depot actually plans at.
    Rows for plants with no mapping are excluded and reported.
    """
    models = {k: v for k, v in _available_models(results).items() if k not in ("croston", "sba")}
    mapped = results[results["Plant"].isin(plant_to_depot)].copy()
    unmapped = sorted(set(results["Plant"]) - set(plant_to_depot))
    if mapped.empty:
        return {"unmappedPlants": unmapped, "overall": {}, "byDepot": []}
    mapped["depotId"] = mapped["Plant"].map(plant_to_depot)
    cols = ["actual"] + list(models.values())
    # min_count=1 keeps "no prediction from any plant" as NaN instead of 0.
    agg = mapped.groupby(["depotId", "MatNo", "month_index"])[cols].sum(min_count=1).reset_index()
    by_depot = []
    for depot_id, grp in agg.groupby("depotId"):
        by_depot.append({
            "depotId": depot_id,
            "plants": sorted(p for p, d in plant_to_depot.items() if d == depot_id),
            "n": int(len(grp)),
            **compare_models(grp, models),
        })
    return {"unmappedPlants": unmapped, "overall": compare_models(agg, models), "byDepot": by_depot}
