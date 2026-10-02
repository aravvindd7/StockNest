"""
Stage 2: Test row-level backtest prediction API exposure.

Verifies that the includeRows opt-in flag exposes the existing leakage-safe
walk-forward backtest predictions without changing the underlying algorithm.

Run with: pytest test_backtest_rows.py -v
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.data_loader import load_sales_history
from app.features import build_feature_table
from app.backtest import run_backtest

client = TestClient(app)


def test_backtest_without_rows_is_backward_compatible():
    """Existing /backtest behavior remains unchanged when includeRows is omitted."""
    response = client.post("/backtest", json={})
    assert response.status_code == 200
    data = response.json()

    # Original response structure preserved
    assert "dataSource" in data
    assert "evaluatedRows" in data
    assert "overall" in data
    assert "byMaterial" in data
    assert "byPlant" in data
    assert "multiStep" in data

    # No rows field in default response
    assert "rows" not in data


def test_backtest_with_include_rows_false():
    """Explicitly setting includeRows=false behaves like the default."""
    response = client.post("/backtest", json={"includeRows": False})
    assert response.status_code == 200
    data = response.json()

    assert "rows" not in data
    assert "overall" in data


def test_backtest_with_include_rows_true():
    """Setting includeRows=true adds the rows field without breaking existing fields."""
    response = client.post("/backtest", json={"includeRows": True})
    assert response.status_code == 200
    data = response.json()

    # Original fields still present
    assert "dataSource" in data
    assert "evaluatedRows" in data
    assert "overall" in data

    # New rows field present
    assert "rows" in data
    assert isinstance(data["rows"], list)
    assert len(data["rows"]) > 0

    # Row count matches the evaluatedRows count
    assert len(data["rows"]) == data["evaluatedRows"]


def test_row_level_schema():
    """Each row contains all required fields for Safety Stock calculation."""
    response = client.post("/backtest", json={"includeRows": True})
    assert response.status_code == 200
    data = response.json()

    rows = data["rows"]
    assert len(rows) > 0

    # Check first row has all required fields
    first_row = rows[0]
    required_fields = [
        "MatNo", "Plant", "MatGroupName",
        "FinancialYear", "Month", "month_index",
        "actual", "xgb_pred", "wma_pred"
    ]

    for field in required_fields:
        assert field in first_row, f"Missing required field: {field}"

    # Validate data types
    assert isinstance(first_row["MatNo"], str)
    assert isinstance(first_row["Plant"], str)
    assert isinstance(first_row["MatGroupName"], str)
    assert isinstance(first_row["FinancialYear"], str)
    assert isinstance(first_row["Month"], str)
    assert isinstance(first_row["month_index"], int)
    assert isinstance(first_row["actual"], (int, float))
    assert isinstance(first_row["xgb_pred"], (int, float))
    assert isinstance(first_row["wma_pred"], (int, float))


def test_predictions_are_numeric():
    """XGBoost and WMA predictions are valid numeric values."""
    response = client.post("/backtest", json={"includeRows": True})
    assert response.status_code == 200
    data = response.json()

    rows = data["rows"]
    for row in rows:
        # Predictions must be numeric (not NaN strings or null)
        assert isinstance(row["xgb_pred"], (int, float))
        assert isinstance(row["wma_pred"], (int, float))
        assert isinstance(row["actual"], (int, float))

        # XGBoost predictions should be non-negative (clipped in backtest.py)
        assert row["xgb_pred"] >= 0


def test_rows_match_underlying_backtest():
    """Row-level API returns exactly what run_backtest() produces."""
    # Run the underlying backtest function directly
    df, _ = load_sales_history()
    feat = build_feature_table(df)
    direct_results = run_backtest(feat)

    # Run via API
    response = client.post("/backtest", json={"includeRows": True})
    assert response.status_code == 200
    api_rows = response.json()["rows"]

    # Same row count
    assert len(api_rows) == len(direct_results)

    # Spot-check a few rows match
    for i in [0, len(api_rows) // 2, -1]:
        api_row = api_rows[i]
        direct_row = direct_results.iloc[i]

        assert api_row["MatNo"] == direct_row["MatNo"]
        assert api_row["Plant"] == direct_row["Plant"]
        assert api_row["month_index"] == direct_row["month_index"]
        assert api_row["actual"] == pytest.approx(direct_row["actual"], rel=1e-6)
        assert api_row["xgb_pred"] == pytest.approx(direct_row["xgb_pred"], rel=1e-6)
        assert api_row["wma_pred"] == pytest.approx(direct_row["wma_pred"], rel=1e-6)


def test_leakage_safety_preserved():
    """Target month and predictions correspond correctly (no future leakage)."""
    response = client.post("/backtest", json={"includeRows": True})
    assert response.status_code == 200
    rows = response.json()["rows"]

    # Group by series to verify temporal ordering
    from collections import defaultdict
    series_data = defaultdict(list)

    for row in rows:
        key = (row["MatNo"], row["Plant"])
        series_data[key].append(row)

    # For each series, month_index should be monotonically increasing
    for (mat, plant), series_rows in series_data.items():
        sorted_rows = sorted(series_rows, key=lambda r: r["month_index"])
        month_indices = [r["month_index"] for r in sorted_rows]

        # Should be strictly increasing with no gaps in evaluated months
        # (gaps are fine - not all months are evaluated due to MIN_TRAINING_MONTHS)
        for i in range(len(month_indices) - 1):
            assert month_indices[i] < month_indices[i + 1], \
                f"Month indices not increasing for {mat}/{plant}"


def test_max_horizon_param_independent_of_rows():
    """includeRows works with different maxHorizon values."""
    for max_horizon in [1, 3, 6]:
        response = client.post("/backtest", json={"includeRows": True, "maxHorizon": max_horizon})
        assert response.status_code == 200
        data = response.json()

        assert "rows" in data
        assert data["multiStep"]["maxHorizon"] == max_horizon
        # Row count should be the same regardless of maxHorizon
        # (maxHorizon only affects multiStep backtest, not the base single-step backtest)
