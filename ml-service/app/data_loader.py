"""
Loads Sales Master history for feature engineering/training/backtesting.

PRIMARY PATH: MongoDB, via pymongo, reading the exact same `sales`
collection the Node backend's Mongoose Sales model writes to. This is the
production data path and is what actually runs whenever MONGO_URI is
configured and reachable.

FALLBACK PATH: the frozen, Phase-3-audited `04_Sales_Master.xlsx` from
StockNest_Synchronized_Dataset. This exists only because the current
development/demo environment has no live MongoDB instance to connect to —
it is NOT a design choice for production use, and it never gets used if
MONGO_URI is set and reachable. This keeps the backtest genuinely
reproducible without requiring a running database, while never lying
about which mode produced a given result: every response from this
service reports `data_source: "mongodb"` or `data_source: "excel_fallback"`
explicitly (see main.py), so nothing here can be mistaken for a live
MongoDB result if it wasn't one.

Either path returns the exact same shape: a pandas DataFrame with columns
matching Sales Master's schema (MatNo, Material, MatGroupName, Plant,
FinancialYear, Month, Quarter, ProductionCycle, SalesQty, ...) — everything
downstream (features.py, backtest.py) is agnostic to which path was used.
"""
import logging
from typing import Tuple

import pandas as pd

from app.config import MONGO_URI, MONGO_DB, EXCEL_FALLBACK_PATH

logger = logging.getLogger("stocknest_ml.data_loader")

SALES_COLUMNS_NEEDED = [
    "MatNo", "Material", "MatGroupName", "Plant", "FinancialYear", "Month",
    "Quarter", "ProductionCycle", "SalesQty",
]


def _load_from_mongo() -> pd.DataFrame:
    from pymongo import MongoClient

    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
    client.admin.command("ping")  # fail fast if unreachable, rather than hanging
    db = client[MONGO_DB]
    docs = list(db.sales.find({}, {"_id": 0, **{c: 1 for c in SALES_COLUMNS_NEEDED}}))
    client.close()
    if not docs:
        raise RuntimeError("MongoDB connected but the 'sales' collection returned zero documents.")
    return pd.DataFrame(docs)


def _load_from_excel() -> pd.DataFrame:
    if not EXCEL_FALLBACK_PATH.exists():
        raise FileNotFoundError(
            f"No MongoDB connection available and the Excel fallback dataset was not found at "
            f"{EXCEL_FALLBACK_PATH}. Set MONGO_URI, or set SALES_EXCEL_FALLBACK_PATH to a valid "
            f"04_Sales_Master.xlsx."
        )
    df = pd.read_excel(EXCEL_FALLBACK_PATH, sheet_name="Data")
    # The Excel file's headers are the application's display labels
    # (e.g. "Material Number"), not the Mongoose field keys — map them
    # back to the same keys MongoDB would return, so every downstream
    # module only ever deals with one column-naming scheme.
    rename_map = {
        "Material Number": "MatNo", "Material Description": "Material",
        "Material Group Name": "MatGroupName", "Plant": "Plant",
        "Financial Year": "FinancialYear", "Month": "Month", "Quarter": "Quarter",
        "Production Cycle": "ProductionCycle", "Sales Quantity": "SalesQty",
    }
    df = df.rename(columns=rename_map)
    return df[SALES_COLUMNS_NEEDED].copy()


def load_sales_history() -> Tuple[pd.DataFrame, str]:
    """
    Returns (dataframe, data_source_label). Tries MongoDB first if
    MONGO_URI is configured; falls back to the synchronized Excel dataset
    only if MongoDB isn't configured or isn't reachable. Never silently
    mixes the two.
    """
    if MONGO_URI:
        try:
            df = _load_from_mongo()
            logger.info("Loaded %d Sales rows from MongoDB.", len(df))
            return df, "mongodb"
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any Mongo failure should fall back, not crash
            logger.warning("MongoDB load failed (%s). Falling back to the synchronized Excel dataset.", exc)

    df = _load_from_excel()
    logger.info("Loaded %d Sales rows from the synchronized Excel dataset (fallback path).", len(df))
    return df, "excel_fallback"
