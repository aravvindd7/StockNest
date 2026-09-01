"""
Weighted Moving Average baseline — monthly grain, reimplemented here (not
imported from planningService.js, which is quarterly-grain and Node/JS)
specifically so it can be run through the EXACT SAME chronological
expanding-window backtest harness as XGBoost (backtest.py), on the exact
same forecast months, which is what makes the WMA vs XGBoost comparison
fair (Phase 4 Section 10).

Configuration: 3-month linearly-weighted average of the prior 3 months.
This is the configuration Phase 3's independent audit found best among 5
tested (3mo/6mo/12mo x linear/equal weights) — 15.10% WMAPE — so it is the
one carried forward here as "the baseline to beat," not re-selected from
scratch. It requires no training step: prediction for month t is just a
function of months t-1, t-2, t-3, computed at prediction time.

This file does NOT touch planningService.js's own WMA implementation
(quarterly, seasonal-weighted-average + trend) in any way — that remains
untouched and fully operational as the production fallback (Phase 4's
explicit requirement). This is a separate, monthly-grain reimplementation
that exists only for apples-to-apples benchmarking against XGBoost.
"""
import numpy as np
import pandas as pd


def wma_predict(history: pd.Series, window: int = 3) -> float:
    """
    history: chronologically ordered SalesQty values STRICTLY BEFORE the
    forecast month (the caller is responsible for never passing the target
    month's own value in here — see backtest.py).
    Returns NaN if fewer than `window` prior months exist (consistent
    "unavailable" handling, matching features.py's own rule).
    """
    if len(history) < window:
        return np.nan
    recent = history.iloc[-window:]
    weights = np.arange(1, window + 1)  # oldest=1 ... newest=window
    return float(np.dot(recent.values, weights) / weights.sum())
