"""
Forecast intelligence: confidence and explanation, built entirely from
evidence the forecasting system already produces — no arbitrary hardcoded
percentages, no fabricated explanations (per this phase's explicit
requirements).

CONFIDENCE THRESHOLDS — where they come from:
A fresh backtest run on the current dataset shows a clear, real
distribution across the 18 materials: 14 of 18 sit under 12% WMAPE (a
"the model works well here" cluster), a middle band from ~12-17% (4
materials — largely the strongly-seasonal ones XGBoost still handles
reasonably but not as cleanly), and one genuine outlier at 53.8% (MAT0008,
already flagged in Phase 3 as the highest-volatility material in the
catalog). The tier boundaries below sit at the natural gaps in that real
distribution, not chosen a priori — HIGH <= 12%, MEDIUM <= 25%, LOW > 25%.
If the distribution shifts materially on future backtests, these
boundaries should be re-examined against the new distribution, not left
as a fixed constant forever.

HORIZON CALIBRATION — updated in Phase 6: the decay described below is now
EMPIRICALLY MEASURED via a genuine recursive multi-step walk-forward
backtest (ml-service/app/multi_step_backtest.py), not assumed. See
empirical_horizon_multipliers()/apply_empirical_horizon_adjustment() below.
apply_horizon_decay() (the original Phase 5 structural assumption) is kept
only as a fallback for when no measured horizon profile is available at
all — it is no longer the primary mechanism.

The measured profile from this project's own backtest turned out to be
IRREGULAR, not a smooth degradation (WMAPE fluctuates between ~10-13.5%
across horizons 1-12, peaking around horizon 6, then partially recovering)
— per Phase 6 Section 14's explicit instruction, this irregularity is
preserved as-is via a direct ratio of measured values, not smoothed into
an assumed curve.
"""
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

MONTHS_BY_QUARTER = {
    "Q1": ["April", "May", "June"],
    "Q2": ["July", "August", "September"],
    "Q3": ["October", "November", "December"],
    "Q4": ["January", "February", "March"],
}
MONTH_ORDER = [m for q in ["Q1", "Q2", "Q3", "Q4"] for m in MONTHS_BY_QUARTER[q]]


def confidence_tier_from_wmape(wmape: Optional[float]) -> str:
    if wmape is None:
        return "MEDIUM"  # no segment evidence available — neither optimistic nor pessimistic
    if wmape <= 12:
        return "HIGH"
    if wmape <= 25:
        return "MEDIUM"
    return "LOW"


def numeric_confidence_from_wmape(wmape: Optional[float]) -> int:
    """Keeps the same 50-97 numeric range the existing (pre-ML) confidence already used, so the frontend's confidence badge needs no format change."""
    if wmape is None:
        return 70
    return int(max(50, min(97, round(100 - wmape))))


def apply_horizon_decay(confidence: int, months_ahead: int) -> int:
    """
    DEPRECATED as of Phase 6 — kept only as the fallback used when no
    empirical horizon profile is available (e.g. the multi-step backtest
    hasn't been run yet). Prefer apply_empirical_horizon_adjustment below,
    which uses real measured error instead of this structural assumption.
    """
    penalty = min(15, max(0, (months_ahead - 1) // 2))
    return max(40, confidence - penalty)


def empirical_horizon_multipliers(horizon_profile: Dict[str, Dict], reference_horizon: int = 1) -> Dict[int, float]:
    """
    Converts a measured horizon_profile (multi_step_backtest.horizon_profile's
    output — real WMAPE per horizon, from actual recursive backtesting, see
    multi_step_backtest.py) into a per-horizon multiplier relative to the
    reference horizon (default: horizon 1, the best-measured baseline).

    This deliberately does NOT fit a smooth curve — Phase 6 Section 14 is
    explicit that an irregular measured profile must be respected as
    irregular, not smoothed away. It's a direct ratio of measured WMAPE
    values, clamped to [0.7, 2.5] purely as a defensive guard against a
    single noisy/low-sample horizon producing an extreme swing — not a
    shape assumption.
    """
    ref = horizon_profile.get(str(reference_horizon), {}).get("xgboost", {}).get("wmape")
    multipliers = {}
    for h_str, entry in horizon_profile.items():
        h = int(h_str)
        wmape_h = entry.get("xgboost", {}).get("wmape")
        if ref and wmape_h is not None and ref > 0:
            multipliers[h] = max(0.7, min(2.5, wmape_h / ref))
        else:
            multipliers[h] = 1.0
    return multipliers


def apply_empirical_horizon_adjustment(base_wmape: Optional[float], months_ahead: int, horizon_multipliers: Optional[Dict[int, float]]) -> Optional[float]:
    """
    Adjusts a material's own baseline WMAPE by the EMPIRICALLY MEASURED
    relative error at this horizon (Phase 6's core requirement — replacing
    the Phase 5 structural penalty). If no horizon profile is available at
    all, returns base_wmape unchanged (equivalent to "no adjustment"), not
    a fabricated one — see forecast.py for when this fallback triggers.
    """
    if base_wmape is None:
        return None
    if not horizon_multipliers:
        return base_wmape
    multiplier = horizon_multipliers.get(months_ahead, horizon_multipliers.get(max(horizon_multipliers), 1.0))
    return round(base_wmape * multiplier, 2)


def detect_trend(monthly_values_chronological: List[float]) -> Dict:
    """Same method as Phase 3's independent audit: least-squares slope, expressed as annualized % of the series' own mean. Reused, not reinvented."""
    n = len(monthly_values_chronological)
    if n < 6:
        return {"label": "insufficient_history", "pctPerYear": None}
    mean = float(np.mean(monthly_values_chronological))
    if mean == 0:
        return {"label": "stable", "pctPerYear": 0}
    xs = np.arange(n)
    xbar, ybar = xs.mean(), mean
    num = np.sum((xs - xbar) * (np.array(monthly_values_chronological) - ybar))
    den = np.sum((xs - xbar) ** 2)
    slope = num / den if den else 0
    pct_per_year = round((slope * 12 / mean) * 100, 1)
    if pct_per_year >= 8:
        label = "increasing"
    elif pct_per_year <= -8:
        label = "declining"
    else:
        label = "stable"
    return {"label": label, "pctPerYear": pct_per_year}


def detect_seasonality(sales_df_for_material: pd.DataFrame) -> Dict:
    """Same method as Phase 3: (max quarterly avg - min quarterly avg) / mean quarterly avg, pooled across all available years."""
    q_avg = sales_df_for_material.groupby("Quarter")["SalesQty"].mean()
    if len(q_avg) < 4 or q_avg.mean() == 0:
        return {"label": "insufficient_history", "strength": None, "peakQuarter": None}
    strength = round((q_avg.max() - q_avg.min()) / q_avg.mean(), 2)
    peak_quarter = q_avg.idxmax()
    if strength > 0.6:
        label = "strong"
    elif strength > 0.3:
        label = "moderate"
    else:
        label = "weak"
    return {"label": label, "strength": strength, "peakQuarter": peak_quarter}


def build_reason(model: str, quarter_or_month: str, trend: Dict, seasonality: Dict, confidence_tier: str, segment_wmape: Optional[float], months_ahead: int, horizon_adjusted_wmape: Optional[float] = None) -> str:
    """Every clause here is conditional on real, already-computed data — nothing is asserted unless the corresponding value is actually available."""
    if model == "WMA_FALLBACK":
        return (
            f"Forecast uses the WMA fallback because this Material+Plant combination has insufficient "
            f"historical data for the XGBoost model (fewer than the required minimum training months)."
        )

    parts = []
    if trend["label"] == "increasing" and trend["pctPerYear"] is not None:
        parts.append(f"recent demand has grown roughly {trend['pctPerYear']}% per year")
    elif trend["label"] == "declining" and trend["pctPerYear"] is not None:
        parts.append(f"recent demand has declined roughly {abs(trend['pctPerYear'])}% per year")
    elif trend["label"] == "stable":
        parts.append("recent demand has been relatively stable")

    if seasonality["label"] == "strong" and seasonality["peakQuarter"]:
        parts.append(f"this material shows a recurring {seasonality['peakQuarter']} seasonal peak")
    elif seasonality["label"] == "moderate" and seasonality["peakQuarter"]:
        parts.append(f"this material shows a moderate seasonal pattern, typically higher in {seasonality['peakQuarter']}")

    basis = " and ".join(parts) if parts else "available historical sales history"
    sentence = f"XGBoost forecast for {quarter_or_month} is based on {basis}."

    if segment_wmape is not None:
        if confidence_tier == "HIGH":
            sentence += f" This model has historically performed well for this material (backtested WMAPE {segment_wmape}%)."
        elif confidence_tier == "LOW":
            sentence += f" Confidence is lower because this model's historical backtest accuracy for this material was weaker (WMAPE {segment_wmape}%)."

    # Evidence-based horizon statement (Phase 6 Section 17) — only stated
    # if a real measured comparison exists (horizon_adjusted_wmape differs
    # from the material's own unadjusted baseline), never asserted from
    # the mere fact that months_ahead is large.
    if months_ahead > 1 and horizon_adjusted_wmape is not None and segment_wmape is not None and horizon_adjusted_wmape > segment_wmape * 1.05:
        sentence += (
            f" This is month {months_ahead} of a recursive forecast; historical backtesting shows higher "
            f"forecast error at this horizon (measured ~{horizon_adjusted_wmape}% vs. ~{segment_wmape}% at the "
            f"nearest horizon), so confidence is reduced accordingly."
        )
    elif months_ahead > 1 and horizon_adjusted_wmape is not None and segment_wmape is not None and horizon_adjusted_wmape < segment_wmape * 0.95:
        sentence += (
            f" This is month {months_ahead} of a recursive forecast; historical backtesting actually shows "
            f"comparable or better accuracy at this horizon for this material, so confidence is not reduced further."
        )

    return sentence
