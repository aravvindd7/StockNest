"""
Benchmark script to compare different training windows for StockNest forecasting.

This script evaluates:
- A. 12-month rolling training window
- B. 18-month rolling training window
- C. 24-month rolling training window
- D. Full available history

Using the leakage-free recursive walk-forward framework.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
import xgboost as xgb
from app.data_loader import load_sales_history
from app.features import (
    build_feature_table, ALL_FEATURES, CATEGORICAL_FEATURES, TARGET,
    to_categorical_dtypes, build_recursive_step_row, MONTH_ORDER, QUARTER_BY_MONTH
)
from app.wma_baseline import wma_predict


def wmape(actual, forecast):
    denom = np.sum(np.abs(actual))
    if denom == 0:
        return float('nan')
    return float(100 * np.sum(np.abs(actual - forecast)) / denom)


def mae(actual, forecast):
    return float(np.mean(np.abs(actual - forecast)))


def rmse(actual, forecast):
    return float(np.sqrt(np.mean((actual - forecast) ** 2)))


def run_benchmark_with_window(feat, training_window_months, max_horizon=6):
    """
    Run multi-step backtest with a specific training window size.

    training_window_months:
        - 12 = use last 12 months of history for training
        - 18 = use last 18 months
        - 24 = use last 24 months
        - None = use all available history (full history)
    """
    feat_cat = to_categorical_dtypes(feat)
    max_month_index = int(feat["month_index"].max())
    all_categories = {col: feat_cat[col].cat.categories for col in CATEGORICAL_FEATURES}

    # Determine valid origins - need at least training_window_months of history
    min_required = training_window_months if training_window_months else 12
    origins = list(range(min_required, max_month_index + 1))

    series_keys = feat[["MatNo", "Plant"]].drop_duplicates().values.tolist()

    # Pre-compute actuals and metadata
    series_actuals = {}
    series_meta = {}
    for matno, plant in series_keys:
        s = feat[(feat["MatNo"] == matno) & (feat["Plant"] == plant)].sort_values("month_index")
        series_actuals[(matno, plant)] = dict(zip(s["month_index"], s[TARGET]))
        last_row = s.iloc[-1]
        series_meta[(matno, plant)] = {
            "material_group": last_row["MatGroupName"],
            "production_cycle": last_row["ProductionCycle"]
        }

    result_rows = []

    for origin in origins:
        # Apply training window: use only last N months before origin
        if training_window_months:
            train_start = max(0, origin - training_window_months)
            train_df = feat_cat[(feat_cat["month_index"] >= train_start) & (feat_cat["month_index"] < origin)]
        else:
            # Full history
            train_df = feat_cat[feat_cat["month_index"] < origin]

        if train_df.empty:
            continue

        max_evaluable_h = min(max_horizon, max_month_index - origin + 1)
        if max_evaluable_h < 1:
            continue

        # Train model
        model = xgb.XGBRegressor(
            n_estimators=200, max_depth=4, learning_rate=0.08,
            subsample=0.9, colsample_bytree=0.9,
            tree_method="hist", enable_categorical=True,
            random_state=42, missing=np.nan
        )
        model.fit(train_df[ALL_FEATURES], train_df[TARGET])

        # Initialize histories for recursive forecasting
        xgb_histories = {}
        wma_histories = {}
        for matno, plant in series_keys:
            actuals_by_idx = series_actuals[(matno, plant)]
            real_history = [actuals_by_idx[i] for i in sorted(actuals_by_idx) if i < origin]
            if real_history:
                xgb_histories[(matno, plant)] = list(real_history)
                wma_histories[(matno, plant)] = list(real_history)

        # Recursive forecasting for each horizon
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

                # Build features using recursive predictions (leakage-free)
                row_feat = build_recursive_step_row(
                    xgb_hist, key[0], key[1], meta["production_cycle"],
                    meta["material_group"], month, quarter, fy_idx
                )
                batch_rows.append(row_feat)
                batch_keys.append(key)

            if not batch_rows:
                break

            # Make predictions
            X_batch = pd.DataFrame(batch_rows)
            for col in CATEGORICAL_FEATURES:
                X_batch[col] = pd.Categorical(X_batch[col], categories=all_categories[col])
            preds = np.clip(model.predict(X_batch[ALL_FEATURES]), a_min=0, a_max=None)

            # Store predictions and compute WMA
            for key, pred in zip(batch_keys, preds):
                xgb_histories[key].append(float(pred))

                wma_hist = wma_histories[key]
                wma_pred_val = wma_predict(pd.Series(wma_hist), window=min(3, len(wma_hist)))
                wma_pred_val = 0.0 if (wma_pred_val is None or np.isnan(wma_pred_val)) else wma_pred_val
                wma_histories[key].append(wma_pred_val)

                result_rows.append({
                    "MatNo": key[0], "Plant": key[1],
                    "origin": origin, "horizon": h,
                    "month_index": target_month_index,
                    "actual": series_actuals[key][target_month_index],
                    "xgb_pred": float(pred),
                    "wma_pred": wma_pred_val,
                    "training_window": training_window_months if training_window_months else "full"
                })

    return pd.DataFrame(result_rows)


def summarize_results(results, pred_col):
    """Compute WMAPE, MAE, RMSE for each horizon."""
    summary = {}
    for h in range(1, 7):
        horizon_data = results[results["horizon"] == h]
        if len(horizon_data) == 0:
            continue

        valid = horizon_data.dropna(subset=[pred_col, "actual"])
        if len(valid) == 0:
            continue

        actual = valid["actual"].values
        forecast = valid[pred_col].values

        summary[h] = {
            "n": int(len(valid)),
            "wmape": round(wmape(actual, forecast), 2),
            "mae": round(mae(actual, forecast), 2),
            "rmse": round(rmse(actual, forecast), 2)
        }

    # Overall
    valid_all = results.dropna(subset=[pred_col, "actual"])
    if len(valid_all) > 0:
        summary["overall"] = {
            "n": int(len(valid_all)),
            "wmape": round(wmape(valid_all["actual"].values, valid_all[pred_col].values), 2),
            "mae": round(mae(valid_all["actual"].values, valid_all[pred_col].values), 2),
            "rmse": round(rmse(valid_all["actual"].values, valid_all[pred_col].values), 2)
        }

    # Valid series/origin count
    summary["valid_series_origin_count"] = int(
        results[["MatNo", "Plant", "origin"]].drop_duplicates().shape[0]
    )

    return summary


def main():
    print("=" * 80)
    print("STOCKNEST TRAINING WINDOW BENCHMARK")
    print("=" * 80)

    # Load data
    print("\n[1] Loading sales history...")
    df, source = load_sales_history()
    print(f"    Data source: {source}")
    print(f"    Total sales rows: {len(df)}")

    # Build features
    print("\n[2] Building feature table...")
    feat = build_feature_table(df)
    print(f"    Feature rows: {len(feat)}")
    print(f"    Month index range: 0 to {feat['month_index'].max()}")

    # Determine available months
    max_month = int(feat["month_index"].max())
    print(f"    Available months for backtest: {max_month + 1}")

    # Define training windows to test
    windows = [
        (12, "12-month rolling"),
        (18, "18-month rolling"),
        (24, "24-month rolling"),
        (None, "Full available history")
    ]

    results = {}

    for window_months, label in windows:
        print(f"\n[3] Running benchmark for {label}...")
        print(f"    Training window: {'all history' if window_months is None else f'{window_months} months'}")

        try:
            results[label] = run_benchmark_with_window(feat, window_months, max_horizon=6)
            print(f"    Total observations: {len(results[label])}")
        except Exception as e:
            print(f"    ERROR: {e}")
            results[label] = pd.DataFrame()

    # Summarize and print results
    print("\n" + "=" * 80)
    print("BENCHMARK RESULTS")
    print("=" * 80)

    print("\n{:<30} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10}".format(
        "Training Window", "H1", "H2", "H3", "H4", "H5", "H6", "Overall"
    ))
    print("-" * 80)

    # Extract WMAPE by horizon for each window
    wmape_by_window = {}
    for label, df in results.items():
        if df.empty:
            wmape_by_window[label] = {h: None for h in range(1, 7)}
            wmape_by_window[label]["overall"] = None
            continue

        summary = summarize_results(df, "xgb_pred")
        wmape_by_window[label] = {h: summary.get(h, {}).get("wmape") for h in range(1, 7)}
        wmape_by_window[label]["overall"] = summary.get("overall", {}).get("wmape")

    for label in wmape_by_window:
        vals = wmape_by_window[label]
        print("{:<30} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10}".format(
            label,
            f"{vals.get(1, 'N/A'):.1f}" if vals.get(1) else "N/A",
            f"{vals.get(2, 'N/A'):.1f}" if vals.get(2) else "N/A",
            f"{vals.get(3, 'N/A'):.1f}" if vals.get(3) else "N/A",
            f"{vals.get(4, 'N/A'):.1f}" if vals.get(4) else "N/A",
            f"{vals.get(5, 'N/A'):.1f}" if vals.get(5) else "N/A",
            f"{vals.get(6, 'N/A'):.1f}" if vals.get(6) else "N/A",
            f"{vals.get('overall', 'N/A'):.1f}" if vals.get('overall') else "N/A"
        ))

    print("\n" + "=" * 80)
    print("DETAILED METRICS BY HORIZON (XGBoost)")
    print("=" * 80)

    for label, df in results.items():
        if df.empty:
            continue
        print(f"\n--- {label} ---")
        summary = summarize_results(df, "xgb_pred")

        # Print by horizon
        print("\n{:<10} {:>8} {:>8} {:>8} {:>8}".format(
            "Horizon", "Count", "WMAPE", "MAE", "RMSE"
        ))
        print("-" * 45)
        for h in range(1, 7):
            if h in summary:
                s = summary[h]
                print("{:<10} {:>8} {:>8.2f} {:>8.2f} {:>8.2f}".format(
                    f"H{h}", s["n"], s["wmape"], s["mae"], s["rmse"]
                ))

        # Overall
        if "overall" in summary:
            s = summary["overall"]
            print("-" * 45)
            print("{:<10} {:>8} {:>8.2f} {:>8.2f} {:>8.2f}".format(
                "Overall", s["n"], s["wmape"], s["mae"], s["rmse"]
            ))

        print(f"\nValid series/origin combinations: {summary.get('valid_series_origin_count', 'N/A')}")

    # Also show WMA comparison
    print("\n" + "=" * 80)
    print("WMA BASELINE COMPARISON")
    print("=" * 80)

    for label, df in results.items():
        if df.empty:
            continue
        summary = summarize_results(df, "wma_pred")
        if "overall" in summary:
            print(f"{label}: Overall WMAPE = {summary['overall']['wmape']:.2f}%")

    print("\n" + "=" * 80)
    print("BENCHMARK COMPLETE")
    print("=" * 80)

    return results


if __name__ == "__main__":
    main()