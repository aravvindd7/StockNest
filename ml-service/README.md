# StockNest ML Service (Phase 4)

Standalone Python forecasting engine — feature engineering, chronological
backtesting, and XGBoost training/inference. Talks to the Node backend
over HTTP only; never accessed directly by the frontend.

## Setup

```bash
cd ml-service
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configuration (environment variables, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `MONGO_URI` | *(unset)* | If set and reachable, Sales history is read from MongoDB's `sales` collection — the production path. |
| `MONGO_DB` | `stocknest` | Database name. |
| `SALES_EXCEL_FALLBACK_PATH` | `ml-service/data/04_Sales_Master.xlsx` | Used only if `MONGO_URI` is unset or unreachable — see `app/data_loader.py`'s top comment. Copy the synchronized dataset's `04_Sales_Master.xlsx` here for local development/backtesting without a live database. |

## Run

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then from the Node backend's `.env`, set `ML_SERVICE_URL=http://localhost:8000` (defaults to that value if unset).

## Endpoints

- `GET /health` — liveness + which data source is currently reachable
- `POST /backtest` — runs the full chronological WMA vs XGBoost comparison, returns overall + per-Material + per-Plant results
- `POST /forecast` — trains a production model on all available history, returns a recursive N-month-ahead forecast per Material+Plant (body: `{"horizonMonths": 12}`)

## Design notes

- **No random splitting anywhere.** Every train/predict split in `backtest.py` and `forecast.py` is chronological.
- **One global model, not one model per series** — see `backtest.py`'s top comment for why: XGBoost's categorical Material/Plant features only add value if trained across all series at once.
- **Leakage discipline** lives entirely in `features.py` — every feature is built with `.shift(1)` before any window function runs. See that file's top comment for the full guarantee.
- **Graceful degradation**: any Material+Plant series with fewer than `MIN_TRAINING_MONTHS` (12) of history automatically falls back to a WMA forecast (`forecast.py`) rather than an undertrained model prediction.
