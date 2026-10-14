"""
Distribution Stage 2 — ML service tests (synthetic data, no MongoDB).

Covers the forecast financial-year-index correction, the comparison
baselines, the opt-in backtest extensions (baselines, Material x Plant and
depot accuracy) and their backward compatibility.

Run with: pytest test_distribution_stage2.py -v
"""
import math

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app.forecast as forecast_module
import app.main as main_module
from app.backtest import run_backtest
from app.baselines import (
    BASELINE_COLUMNS, baseline_predictions, classify_intermittency, compare_models, croston, depot_summary,
    moving_average, seasonal_naive, seasonal_wma,
)
from app.features import MONTH_ORDER, QUARTER_BY_MONTH, build_feature_table
from app.forecast import future_financial_year_index, generate_forecasts

FYS = ["2023-24", "2024-25", "2025-26"]
SEASON = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.7]


def synthetic_sales(months: int = 36) -> pd.DataFrame:
    """2 materials x 3 plants; M2@P3 is intermittent (every third month)."""
    rng = np.random.default_rng(7)
    rows = []
    for mat, base in (("M1", 100), ("M2", 40)):
        for plant, scale in (("P1", 1.0), ("P2", 2.0), ("P3", 0.5)):
            for i in range(months):
                fy, m = FYS[i // 12] if i < 36 else "2026-27", MONTH_ORDER[i % 12]
                qty = base * scale * SEASON[i % 12] * (1 + rng.normal(0, 0.05))
                if mat == "M2" and plant == "P3":
                    qty = 30.0 if i % 3 == 0 else 0.0
                rows.append({"MatNo": mat, "Material": mat, "MatGroupName": "G", "Plant": plant, "FinancialYear": fy,
                             "Month": m, "Quarter": QUARTER_BY_MONTH[m], "ProductionCycle": "PC-1", "SalesQty": round(qty)})
    return pd.DataFrame(rows)


# ─── Forecast financial-year-index correction ────────────────────────────────

def test_future_financial_year_index_matches_month_index_definition():
    # Last real month = September of FY index 3 (month_index 41).
    assert future_financial_year_index(41, 1) == 3   # October, same FY
    assert future_financial_year_index(41, 6) == 3   # March, same FY
    assert future_financial_year_index(41, 7) == 4   # April, next FY
    assert future_financial_year_index(41, 9) == 4
    # Same rule features.py applies to real rows: FY position == month_index // 12.
    feat = build_feature_table(synthetic_sales())
    assert (feat["financial_year_index"] == feat["month_index"] // 12).all()


def test_live_forecast_passes_corrected_year_index(monkeypatch):
    captured = []
    real_builder = forecast_module.build_recursive_step_row

    def spy(history, matno, plant, pc, group, month, quarter, fy_index):
        captured.append((matno, plant, month, fy_index))
        return real_builder(history, matno, plant, pc, group, month, quarter, fy_index)

    monkeypatch.setattr(forecast_module, "build_recursive_step_row", spy)
    result = generate_forecasts(synthetic_sales(30), horizon_months=9)  # last real month: FY index 2, September
    by_month = {month: fy for _, _, month, fy in captured}
    assert by_month["October"] == 2 and by_month["March"] == 2   # still FY index 2 (was 4 before the fix)
    assert by_month["April"] == 3 and by_month["June"] == 3      # crosses into the next FY
    assert {f["financialYear"] for f in result["forecasts"]} == {"2025-26", "2026-27"}
    assert len(result["forecasts"]) == 6 * 9                      # 6 series x 9 months — horizon rule unchanged


# ─── Baselines ───────────────────────────────────────────────────────────────

def test_seasonal_naive_and_moving_averages():
    hist = {i: float(i) for i in range(24)}
    assert seasonal_naive(hist, 24) == 12.0
    assert math.isnan(seasonal_naive({0: 1.0}, 5))
    assert moving_average([1, 2, 3, 4], 3) == 3.0
    assert math.isnan(moving_average([1, 2], 3))


def test_seasonal_wma_recovers_a_pure_seasonal_pattern():
    values = [100 * SEASON[i % 12] for i in range(24)]
    positions = [i % 12 for i in range(24)]
    assert seasonal_wma(values, positions, 0) == pytest.approx(100 * SEASON[0])
    assert math.isnan(seasonal_wma(values[:12], positions[:12], 0)), "needs >= 24 months of history"


def test_croston_and_sba():
    series = [0, 0, 6, 0, 0, 6, 0, 0, 6]
    assert croston(series) == pytest.approx(6 / 3)
    assert croston(series, sba=True) == pytest.approx(6 / 3 * 0.95)
    assert croston([0, 0, 0]) == 0.0


def test_intermittency_classification():
    assert classify_intermittency([10, 11, 9, 10, 12, 10]) == "smooth"
    assert classify_intermittency([5, 0, 0, 5, 0, 0, 5]) == "intermittent"
    assert classify_intermittency([1, 0, 0, 50, 0, 0, 2]) == "lumpy"
    assert classify_intermittency([0, 0]) is None


def test_baseline_predictions_only_use_prior_history():
    feat = build_feature_table(synthetic_sales())
    s = feat[(feat.MatNo == "M1") & (feat.Plant == "P1")]
    target = 30
    preds = baseline_predictions(s[s.month_index < target], target)
    actual_by_idx = dict(zip(s.month_index, s.SalesQty))
    assert preds["snaive_pred"] == actual_by_idx[18]
    assert preds["ma3_pred"] == pytest.approx(np.mean([actual_by_idx[i] for i in (27, 28, 29)]))
    # Changing the target month's own value cannot change any baseline.
    tampered = s.copy()
    tampered.loc[tampered.month_index == target, "SalesQty"] = 10 ** 6
    assert baseline_predictions(tampered[tampered.month_index < target], target) == preds


# ─── Backtest extensions ─────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def results_pair():
    feat = build_feature_table(synthetic_sales())
    return run_backtest(feat), run_backtest(feat, include_baselines=True)


def test_baselines_are_opt_in_and_do_not_change_xgboost(results_pair):
    default, extended = results_pair
    assert not set(BASELINE_COLUMNS) & set(default.columns)
    assert set(BASELINE_COLUMNS) <= set(extended.columns)
    pd.testing.assert_series_equal(default["xgb_pred"], extended["xgb_pred"])
    pd.testing.assert_series_equal(default["wma_pred"], extended["wma_pred"])
    assert extended[extended.MatNo.eq("M2") & extended.Plant.eq("P3")]["demand_class"].isin(["intermittent", "lumpy"]).all()


def test_compare_models_reports_common_rows(results_pair):
    _, extended = results_pair
    cmp = compare_models(extended, {"xgboost": "xgb_pred", "seasonal_wma": "seasonal_wma_pred"})
    assert cmp["models"]["xgboost"]["n"] == len(extended)
    assert cmp["commonRows"]["n"] == extended["seasonal_wma_pred"].notna().sum() < len(extended)
    assert set(cmp["commonRows"]["rankingByWMAPE"]) == {"xgboost", "seasonal_wma"}


def test_depot_summary_sums_plants_before_scoring(results_pair):
    _, extended = results_pair
    out = depot_summary(extended, {"P1": "D1", "P2": "D1"})  # two plants feed one depot; P3 unmapped
    assert out["unmappedPlants"] == ["P3"]
    [d1] = out["byDepot"]
    assert d1["depotId"] == "D1" and d1["plants"] == ["P1", "P2"]
    rows = extended[extended.Plant.isin(["P1", "P2"])]
    assert d1["n"] == rows.groupby(["MatNo", "month_index"]).ngroups
    agg = rows.groupby(["MatNo", "month_index"])[["actual", "xgb_pred"]].sum()
    expected = 100 * (agg.actual - agg.xgb_pred).abs().sum() / agg.actual.abs().sum()
    assert d1["models"]["xgboost"]["WMAPE"] == round(expected, 2)


def test_backtest_endpoint_backward_compatible_and_opt_in(monkeypatch):
    monkeypatch.setattr(main_module, "load_sales_history", lambda: (synthetic_sales(), "test"))
    client = TestClient(main_module.app)
    default = client.post("/backtest", json={}).json()
    assert set(default) == {"dataSource", "evaluatedRows", "overall", "byMaterial", "byPlant", "multiStep"}

    extended = client.post("/backtest", json={"includeBaselines": True, "includeRows": True,
                                              "depotMapping": {"P1": "D1", "P2": "D1", "P3": "D2"}}).json()
    assert set(default) <= set(extended)
    assert extended["overall"] == default["overall"]
    assert {"baselines", "byMaterialPlant", "byDepot", "rows"} <= set(extended)
    assert len(extended["byMaterialPlant"]) == 6
    assert {d["depotId"] for d in extended["byDepot"]["byDepot"]} == {"D1", "D2"}
    assert "croston" in extended["baselines"]["intermittent"]["models"]
    # Unavailable baseline values are serialized as null, never NaN.
    assert any(r["seasonal_wma_pred"] is None for r in extended["rows"])
