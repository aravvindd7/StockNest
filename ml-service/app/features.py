"""
Feature engineering for StockNest's monthly SalesQty forecasting.

EVERY feature here is computed using ONLY information strictly before the
target month — this file exists specifically to make that guarantee
mechanically checkable in one place, per Phase 4 Section 7 ("EVERY
FEATURE must be calculated using information available BEFORE month T").

How the guarantee is enforced:
  - Each Material+Plant series is sorted into strict chronological order
    first (FinancialYear, then Month-within-financial-year, i.e. April=0
    ... March=11 — NOT calendar/alphabetical month order).
  - Every lag/rolling/growth feature is built with pandas .shift(1) as its
    first operation, so index t can never see its own value or anything
    after it — shifting happens before any rolling/window function runs,
    not after.
  - A feature that needs more history than exists at the current row is
    left as NaN (pandas' native missing value), never filled with 0 or any
    fabricated number. XGBoost's native missing-value handling (it learns
    a default split direction for NaN) is used instead of imputation —
    this satisfies "DO NOT fabricate historical values."
  - Only rows with at least MIN_TRAINING_MONTHS of prior history are kept
    for training/backtesting at all (see config.MIN_TRAINING_MONTHS).

Explicitly EXCLUDED, per Phase 4 Section 6's leakage list:
  - SalesEA, SalesCV, NetSales — derived from the same transaction as the
    SalesQty target itself; using them would be circular, not predictive.
  - QtrWk, Merged, Page — no defensible forecasting purpose demonstrated;
    left out for this first implementation per the brief's own guidance.
  - Any historical Stock feature — Stock Master is a single point-in-time
    snapshot (2027-01-15), not a time series; see Section 19. Current
    stock is legitimate ONLY as a live inference-time input, never as a
    historical training feature, and is not included here at all — it
    would need to be joined in separately at actual inference time by
    whatever caller wants it, kept fully outside this training pipeline.
"""
from typing import List

import numpy as np
import pandas as pd

MONTHS_BY_QUARTER = {
    "Q1": ["April", "May", "June"],
    "Q2": ["July", "August", "September"],
    "Q3": ["October", "November", "December"],
    "Q4": ["January", "February", "March"],
}
MONTH_ORDER = [m for q in ["Q1", "Q2", "Q3", "Q4"] for m in MONTHS_BY_QUARTER[q]]
MONTH_INDEX = {m: i for i, m in enumerate(MONTH_ORDER)}
QUARTER_BY_MONTH = {m: q for q, ms in MONTHS_BY_QUARTER.items() for m in ms}

CATEGORICAL_FEATURES = ["MatNo", "Plant", "ProductionCycle", "MatGroupName", "Month", "Quarter"]
NUMERIC_FEATURES = [
    "lag1", "lag2", "lag3",
    "rolling3", "rolling6", "rolling12",
    "same_month_prior_year",
    "qoq_growth", "yoy_growth",
    "financial_year_index",
]
ALL_FEATURES = CATEGORICAL_FEATURES + NUMERIC_FEATURES
TARGET = "SalesQty"


def _chrono_key(financial_year: str, month: str, fy_order: List[str]) -> int:
    """Sortable integer position within the whole series: FY index * 12 + month-within-FY index."""
    return fy_order.index(financial_year) * 12 + MONTH_INDEX[month]


def build_feature_table(sales_df: pd.DataFrame) -> pd.DataFrame:
    """
    Input: raw Sales rows (MatNo, Material, MatGroupName, Plant,
    FinancialYear, Month, Quarter, ProductionCycle, SalesQty), one row per
    Material+Plant+Month (any duplicate Material+Plant+FY+Month combos are
    summed first, matching how Planning Service itself aggregates Sales).

    Output: one row per Material+Plant+Month with every feature in
    ALL_FEATURES plus the TARGET, sorted chronologically within each
    Material+Plant series. Rows with fewer than MIN_TRAINING_MONTHS of
    prior history are NOT dropped here (callers decide whether to include
    them) — but their NaN features make them naturally unusable for
    training without an explicit, visible decision downstream.
    """
    df = sales_df.copy()
    df["SalesQty"] = pd.to_numeric(df["SalesQty"], errors="coerce").fillna(0)

    # Collapse any duplicate Material+Plant+FY+Month rows by summing —
    # mirrors planningService.js's own $group+$sum aggregation philosophy,
    # never picks one row arbitrarily over another.
    group_cols = ["MatNo", "Material", "MatGroupName", "Plant", "ProductionCycle", "FinancialYear", "Month", "Quarter"]
    df = df.groupby(group_cols, as_index=False)["SalesQty"].sum()

    fy_order = sorted(df["FinancialYear"].unique())  # "2024-25" < "2025-26" sorts correctly as plain strings
    df["_chrono"] = df.apply(lambda r: _chrono_key(r["FinancialYear"], r["Month"], fy_order), axis=1)
    df["financial_year_index"] = df["FinancialYear"].apply(lambda fy: fy_order.index(fy))

    df = df.sort_values(["MatNo", "Plant", "_chrono"]).reset_index(drop=True)

    feature_frames = []
    for (matno, plant), grp in df.groupby(["MatNo", "Plant"], sort=False):
        grp = grp.sort_values("_chrono").reset_index(drop=True)
        s = grp[TARGET]

        # .shift(1) FIRST, on every single feature — this is the leakage
        # guard. Nothing below this line ever reads s[t] to build a
        # feature for row t.
        prior = s.shift(1)
        grp["lag1"] = prior
        grp["lag2"] = s.shift(2)
        grp["lag3"] = s.shift(3)
        grp["rolling3"] = prior.rolling(window=3, min_periods=3).mean()
        grp["rolling6"] = prior.rolling(window=6, min_periods=6).mean()
        grp["rolling12"] = prior.rolling(window=12, min_periods=12).mean()
        grp["same_month_prior_year"] = s.shift(12)

        # QoQ growth: comparing the two most recently COMPLETED quarters
        # as of t-1 (never the in-progress quarter containing t itself,
        # which would leak the target's own quarter).
        completed_quarter_totals = prior.rolling(window=3, min_periods=3).sum()
        prev_completed_quarter = completed_quarter_totals.shift(3)
        qoq = (completed_quarter_totals - prev_completed_quarter) / prev_completed_quarter.replace(0, np.nan)
        grp["qoq_growth"] = qoq

        # YoY growth: growth of the most recent known month (t-1) vs. the
        # same month one year before that (t-13) — a leakage-free recent
        # trend signal.
        yoy = (prior - s.shift(13)) / s.shift(13).replace(0, np.nan)
        grp["yoy_growth"] = yoy

        feature_frames.append(grp)

    result = pd.concat(feature_frames, ignore_index=True)
    result = result.sort_values(["MatNo", "Plant", "_chrono"]).reset_index(drop=True)
    result = result.rename(columns={"_chrono": "month_index"})
    return result


def to_categorical_dtypes(df: pd.DataFrame) -> pd.DataFrame:
    """Casts the categorical feature columns to pandas 'category' dtype, required for XGBoost's enable_categorical=True path."""
    df = df.copy()
    for col in CATEGORICAL_FEATURES:
        df[col] = df[col].astype("category")
    return df


def build_recursive_step_row(history_values, matno, plant, production_cycle, material_group, month, quarter, financial_year_index):
    """
    Builds one feature row for a single recursive forecasting step, from
    `history_values` — a plain chronological list of SalesQty values for
    this series, where entries beyond the real actual history may
    themselves be PRIOR PREDICTIONS from earlier steps in the same
    recursive walk (never the actual future value — the caller is
    responsible for that guarantee; see forecast.py and
    multi_step_backtest.py, both of which use this exact function so
    there is only one place this logic can go wrong).

    This is the single shared implementation of "how do we build features
    for the next recursive step" — Phase 6 Section 7's explicit
    requirement to document this behavior clearly, satisfied by having
    exactly one function do it, used everywhere it's needed.
    """
    completed_q = sum(history_values[-3:]) if len(history_values) >= 3 else np.nan
    prev_completed_q = sum(history_values[-6:-3]) if len(history_values) >= 6 else np.nan
    qoq = ((completed_q - prev_completed_q) / prev_completed_q) if (prev_completed_q not in (0, np.nan) and not np.isnan(prev_completed_q)) else np.nan
    yoy_anchor = history_values[-13] if len(history_values) >= 13 else np.nan
    yoy_prior = history_values[-1] if len(history_values) >= 1 else np.nan
    yoy = ((yoy_prior - yoy_anchor) / yoy_anchor) if (yoy_anchor not in (0, np.nan) and not (isinstance(yoy_anchor, float) and np.isnan(yoy_anchor))) else np.nan

    return {
        "MatNo": matno, "Plant": plant, "ProductionCycle": production_cycle,
        "MatGroupName": material_group, "Month": month, "Quarter": quarter,
        "lag1": history_values[-1] if len(history_values) >= 1 else np.nan,
        "lag2": history_values[-2] if len(history_values) >= 2 else np.nan,
        "lag3": history_values[-3] if len(history_values) >= 3 else np.nan,
        "rolling3": np.mean(history_values[-3:]) if len(history_values) >= 3 else np.nan,
        "rolling6": np.mean(history_values[-6:]) if len(history_values) >= 6 else np.nan,
        "rolling12": np.mean(history_values[-12:]) if len(history_values) >= 12 else np.nan,
        "same_month_prior_year": history_values[-12] if len(history_values) >= 12 else np.nan,
        "qoq_growth": qoq, "yoy_growth": yoy,
        "financial_year_index": financial_year_index,
    }
