"""TradeAC lake configuration helpers.

The lake is a hive-partitioned parquet store (see ``tac-engine/skills/tradeac-lake``):

    $TAC_LAKE_DIR/
    ├── market=US/
    │   └── timeframe=1d/
    │       └── symbol=AAPL.parquet        # OHLCV bars: t, date, o, h, l, c, v, n, vw
    ├── features/                          # indicators, wide format, family tier
    │   └── market=US/
    │       └── timeframe=1d/
    │           ├── family=ta/symbol=AAPL.parquet  # t, sma_5, sma_20, rsi_14, ...
    │           └── family=sp/symbol=AAPL.parquet  # t, sp_ou_*, sp_hmm_*, ...
    ├── calendar.parquet                   # trading days per market
    ├── coverage.parquet                   # per (market,timeframe,symbol) loaded windows
    └── symbols.parquet                    # asset master
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

#: qlib freq string (Freq.__str__) -> lake timeframe partition name
FREQ_TO_TIMEFRAME: Dict[str, str] = {
    "day": "1d",
    "1d": "1d",
    "min": "1m",
    "1min": "1m",
    "5min": "5m",
    "10min": "10m",
    "15min": "15m",
    "30min": "30m",
    "hour": "1h",
    "1hour": "1h",
    "2hour": "2h",
    "4hour": "4h",
    "week": "1w",
    "1week": "1w",
    "month": "1M",
    "1month": "1M",
}

#: bar-field map: qlib field name (without the leading ``$``) -> lake bar column
BAR_FIELD_MAP: Dict[str, str] = {
    "open": "o",
    "high": "h",
    "low": "l",
    "close": "c",
    "volume": "v",
    "vwap": "vw",
    "avg_amount": "vw",  # amount / volume
}

#: fields that qlib core/backtest queries but the lake does not store -> all-NaN
UNKNOWN_FIELD_NAMES = ("factor", "change", "trade_unit", "suspend_flag")

#: columns in the parquet files that are not features
NON_FEATURE_COLUMNS = ("t", "date", "market", "timeframe", "symbol")

#: Feature-family partitions merged by ``LakeConfig.load_features`` and scanned
#: by the handler's field discovery. ``macro`` holds broadcast market-state
#: columns (see skills/tac-qlib-custom/examples/persist_macro_broadcast.py).
FEATURE_FAMILIES = ("ta", "sp", "macro")


def timeframe_for_freq(freq: str) -> str:
    """Map a qlib frequency (e.g. ``day``, ``1min``) to a lake timeframe (e.g. ``1d``)."""
    f = str(freq).lower()
    if f not in FREQ_TO_TIMEFRAME:
        raise ValueError(
            f"unsupported qlib freq {freq!r}; supported freqs: {sorted(set(FREQ_TO_TIMEFRAME))}"
        )
    return FREQ_TO_TIMEFRAME[f]


def resolve_lake_root(lake_root: Optional[str] = None) -> Path:
    """Resolve the lake root: explicit arg > ``TAC_LAKE_DIR`` (no fallback).

    ``TAC_LAKE_DIR`` is **mandatory** — there is deliberately no default
    A missing/empty value raises so a
    misconfigured environment never silently points at a wrong directory.
    """
    if lake_root is None:
        lake_root = os.environ.get("TAC_LAKE_DIR")
    if not lake_root:
        raise RuntimeError(
            "TAC_LAKE_DIR is not set. Point it at the TradeAC lake root, e.g. "
            "export TAC_LAKE_DIR=/home/data/lake (docker) or set an absolute "
            "path in your local .env."
        )
    return Path(str(lake_root)).expanduser().resolve()


class LakeConfig:
    """Path helpers + cached readers for a (lake_root, market) combination."""

    def __init__(self, lake_root: Optional[str] = None, market: str = "US"):
        self.lake_root: Path = resolve_lake_root(lake_root)
        self.market: str = (market or "US").upper()

    # ---- paths --------------------------------------------------------------
    def bar_dir(self, timeframe: str) -> Path:
        return self.lake_root / f"market={self.market}" / f"timeframe={timeframe}"

    def bar_path(self, timeframe: str, symbol: str) -> Path:
        return self.bar_dir(timeframe) / f"symbol={str(symbol).upper()}.parquet"

    def features_dir(self, timeframe: str) -> Path:
        return self.lake_root / "features" / f"market={self.market}" / f"timeframe={timeframe}"

    def features_path(self, timeframe: str, symbol: str) -> Path:
        # Legacy flat path (no family tier). Prefer `load_features` which
        # resolves the family=ta|sp partition layout.
        return self.features_dir(timeframe) / f"symbol={str(symbol).upper()}.parquet"

    def load_features(self, timeframe: str, symbol: str) -> pd.DataFrame:
        """All feature columns for a symbol, merging the `family=ta|sp|macro`
        partitions by timestamp. Returns an empty frame when no
        feature files exist (legacy flat layout falls back transparently)."""
        sym = str(symbol).upper()
        frames = []
        for family in FEATURE_FAMILIES:
            p = self.features_dir(timeframe) / f"family={family}" / f"symbol={sym}.parquet"
            if p.exists():
                frames.append(pd.read_parquet(p))
        if not frames:
            flat = self.features_dir(timeframe) / f"symbol={sym}.parquet"
            if flat.exists():
                return pd.read_parquet(flat)
            return pd.DataFrame()
        if len(frames) == 1:
            return frames[0]
        merged = frames[0]
        for extra in frames[1:]:
            merged = merged.merge(extra, on="t", how="outer", suffixes=("", "_dup"))
            for c in [c for c in merged.columns if c.endswith("_dup")]:
                merged = merged.drop(columns=c)
        return merged

    def calendar_path(self) -> Path:
        return self.lake_root / "calendar.parquet"

    def symbols_path(self) -> Path:
        return self.lake_root / "symbols.parquet"

    def coverage_path(self) -> Path:
        return self.lake_root / "coverage.parquet"

    # ---- metadata readers ----------------------------------------------------
    def load_symbols(self) -> List[str]:
        """All symbols known to the lake (from ``symbols.parquet``)."""
        p = self.symbols_path()
        if not p.exists():
            return []
        df = pd.read_parquet(p)
        if "symbol" not in df.columns:
            return []
        return sorted(df["symbol"].astype(str).str.upper().tolist())

    def symbol_spans(self, symbol: str, timeframe: str) -> List[tuple]:
        """Listing span(s) ``[(start_iso, end_iso)]`` for a symbol from coverage.parquet."""
        p = self.coverage_path()
        if p.exists():
            try:
                df = pd.read_parquet(p)
            except Exception:  # pragma: no cover - defensive
                df = pd.DataFrame()
            if len(df):
                df = df[
                    (df.get("market") == self.market)
                    & (df.get("timeframe") == timeframe)
                    & (df.get("symbol") == str(symbol).upper())
                ]
                if len(df):
                    row = df.iloc[0]
                    first = pd.Timestamp(row["first_t"]).date()
                    last = pd.Timestamp(row["last_t"]).date()
                    return [(first.isoformat(), last.isoformat())]
        # fallback: derive from the bar file itself
        p = self.bar_path(timeframe, symbol)
        if p.exists():
            import pyarrow.parquet as pq

            tbl = pq.read_table(p, columns=["t"])
            first = pd.Timestamp(tbl.column("t")[0].as_py()).date()
            last = pd.Timestamp(tbl.column("t")[-1].as_py()).date()
            return [(first.isoformat(), last.isoformat())]
        return [("1970-01-01", "2099-12-31")]

    def load_calendar_dates(self) -> List[pd.Timestamp]:
        """Trading days (midnight timestamps) for the market, from ``calendar.parquet``."""
        p = self.calendar_path()
        if p.exists():
            df = pd.read_parquet(p)
            if "date" in df.columns:
                if "market" in df.columns:
                    df = df[df["market"] == self.market]
                dates = pd.to_datetime(df["date"]).dt.normalize().sort_values().unique()
                return [pd.Timestamp(x) for x in dates]
        return []

    def __repr__(self) -> str:  # pragma: no cover
        return f"LakeConfig(lake_root={self.lake_root}, market={self.market})"
