"""qlib data providers backed by the TradeAC parquet lake.

These providers plug into the standard qlib mechanism: ``qlib.init(calendar_provider=...,
instrument_provider=..., feature_provider=...)`` instantiates them and binds them to the
``Cal`` / ``Inst`` / ``FeatureD`` wrappers (see ``qlib.data.data.register_all_wrappers``).
The rest of qlib (``LocalDatasetProvider`` expression engine, backtest ``Exchange``) keeps
working unchanged because the interface contract is identical to the file-based providers:

- ``feature()`` returns a ``pd.Series`` indexed by the **calendar position** range
  ``[start_index, end_index]`` (matching ``FileFeatureStorage.__getitem__`` semantics).
- ``list_instruments()`` returns ``{symbol: [(start, end), ...]}``.
- ``load_calendar()`` returns a list of ``pd.Timestamp`` trading days.
"""

from __future__ import annotations

import bisect
from typing import Dict, List, Optional, Union

import numpy as np
import pandas as pd

from qlib.data.data import CalendarProvider, FeatureProvider, InstrumentProvider
from qlib.log import get_module_logger

from .config import (
    BAR_FIELD_MAP,
    LakeConfig,
    UNKNOWN_FIELD_NAMES,
    timeframe_for_freq,
)

logger = get_module_logger("tac_qlib.data.providers")


def _day_freq(freq: str) -> bool:
    return str(freq).lower() in ("day", "1d")


def _calendar_keys(cal: List[pd.Timestamp], freq: str) -> pd.Index:
    """Convert calendar timestamps into the same key space as the lake parquet."""
    if _day_freq(freq):
        return pd.Index([pd.Timestamp(x).date() for x in cal])
    return pd.Index([pd.Timestamp(x) for x in cal])


class LakeCalendarProvider(CalendarProvider):
    """Trading calendar read from ``<lake>/calendar.parquet`` (fallback: derived from bars)."""

    def __init__(self, lake_root: Optional[str] = None, market: str = "US"):
        super().__init__()
        self.cfg = LakeConfig(lake_root, market)

    def load_calendar(self, freq, future):
        timeframe = timeframe_for_freq(freq)
        if not _day_freq(freq):
            raise NotImplementedError(
                f"freq={freq!r} (timeframe={timeframe}) is not supported yet: the lake calendar "
                f"only covers daily sessions; add a minute-level calendar to `calendar.parquet`"
            )

        dates = self.cfg.load_calendar_dates()
        if not dates:
            # Fallback: derive the trading-day set from the persisted bar files.
            bar_dir = self.cfg.bar_dir(timeframe)
            if bar_dir.exists():
                import pyarrow.parquet as pq

                cal: Dict[pd.Timestamp, None] = {}
                for p in sorted(bar_dir.glob("symbol=*.parquet")):
                    tbl = pq.read_table(p, columns=["t"])
                    for v in tbl.column("t"):
                        cal[pd.Timestamp(v.as_py()).normalize()] = None
                dates = sorted(cal.keys())
            if not dates:
                return []

        if future:
            # append the next calendar day so that "today" is a valid trade date
            last = dates[-1]
            dates = dates + [pd.Timestamp(last) + pd.Timedelta(days=1)]
        return dates


class LakeInstrumentProvider(InstrumentProvider):
    """Instruments from ``<lake>/symbols.parquet`` with listing spans from ``coverage.parquet``."""

    def __init__(
        self,
        lake_root: Optional[str] = None,
        market: str = "US",
        markets: Optional[Dict[str, list]] = None,
    ):
        super().__init__()
        self.cfg = LakeConfig(lake_root, market)
        #: optional named pools, e.g. ``{"sp500": ["AAPL", "MSFT"], "etf": ["SPY"]}``.
        #: ``all`` / any unregistered name resolves to every symbol in the lake.
        self.markets: Dict[str, list] = markets or {}

    def _resolve_symbols(self, market: Union[str, list]) -> List[str]:
        if isinstance(market, (list, tuple, pd.Index, np.ndarray)):
            return [str(s).upper() for s in market]
        if isinstance(market, str) and "," in market:
            return [s.strip().upper() for s in market.split(",") if s.strip()]
        if market in self.markets:
            return [str(s).upper() for s in self.markets[market]]
        return self.cfg.load_symbols()

    def list_instruments(self, instruments, start_time=None, end_time=None, freq="day", as_list=False):
        market = instruments["market"]
        timeframe = timeframe_for_freq(freq)

        symbols = self._resolve_symbols(market)
        if not symbols:
            if as_list:
                return []
            return {}

        # clip listing spans to the queried window (mirror of LocalInstrumentProvider)
        from qlib.data.data import Cal  # pylint: disable=C0415

        cal = Cal.calendar(freq=freq)
        start_time = pd.Timestamp(start_time or cal[0])
        end_time = pd.Timestamp(end_time or cal[-1])

        out: Dict[str, list] = {}
        for symbol in symbols:
            spans = []
            for begin, end in self.cfg.symbol_spans(symbol, timeframe):
                lo = max(start_time, pd.Timestamp(begin))
                hi = min(end_time, pd.Timestamp(end))
                if lo <= hi:
                    spans.append((lo, hi))
            if spans:
                out[symbol] = spans

        filter_pipe = instruments.get("filter_pipe") or []
        for filter_config in filter_pipe:
            from qlib.data import filter as F  # pylint: disable=C0415

            filter_t = getattr(F, filter_config["filter_type"]).from_config(filter_config)
            out = filter_t(out, start_time, end_time, freq)

        if as_list:
            return list(out)
        return out


class LakeFeatureProvider(FeatureProvider):
    """Feature data from the lake parquet (OHLCV bars + pre-computed ta-lib features).

    Field routing:
        - ``$open/$high/$low/$close/$volume/$vwap``      -> bar parquet columns
        - ``$amount`` (= v*vw), ``$avg_amount`` (= vw)  -> derived from bar parquet
        - ``$factor/$change/...``                        -> all-NaN (not stored)
        - anything else                                  -> a ta-lib column in the features parquet
    """

    def __init__(self, lake_root: Optional[str] = None, market: str = "US"):
        super().__init__()
        self.cfg = LakeConfig(lake_root, market)
        self._bar_cache: Dict[tuple, pd.DataFrame] = {}
        self._feature_cache: Dict[tuple, pd.DataFrame] = {}

    # ------------------------------------------------------------------ caches
    def _load_bar_df(self, instrument: str, timeframe: str) -> pd.DataFrame:
        key = (instrument, timeframe)
        if key not in self._bar_cache:
            p = self.cfg.bar_path(timeframe, instrument)
            self._bar_cache[key] = pd.read_parquet(p) if p.exists() else pd.DataFrame()
        return self._bar_cache[key]

    def _load_feature_df(self, instrument: str, timeframe: str) -> pd.DataFrame:
        key = (instrument, timeframe)
        if key not in self._feature_cache:
            self._feature_cache[key] = self.cfg.load_features(timeframe, instrument)
        return self._feature_cache[key]

    @staticmethod
    def _keys(df: pd.DataFrame, freq: str) -> pd.Index:
        ts = pd.to_datetime(df["t"])
        return ts.dt.date if _day_freq(freq) else ts

    # ------------------------------------------------------------------ fields
    def _extract(self, instrument: str, field: str, timeframe: str, freq: str) -> Optional[pd.Series]:
        """Return the field as a Series keyed by date/timestamp (None if not present in the lake)."""
        bar = self._load_bar_df(instrument, timeframe)

        if field in BAR_FIELD_MAP:
            col = BAR_FIELD_MAP[field]
            if col in bar.columns:
                return bar[col].astype(float).set_axis(self._keys(bar, freq))
            return None
        if field == "amount":
            if "v" in bar.columns and "vw" in bar.columns:
                return (bar["v"] * bar["vw"]).astype(float).set_axis(self._keys(bar, freq))
            return None
        if field in UNKNOWN_FIELD_NAMES:
            return None

        feat = self._load_feature_df(instrument, timeframe)
        if field in feat.columns:
            return feat[field].astype(float).set_axis(self._keys(feat, freq))
        return None

    # ------------------------------------------------------------------ api
    def _get_calendar(self, freq: str) -> List[pd.Timestamp]:
        from qlib.data.data import Cal  # pylint: disable=C0415

        cal = Cal.calendar(freq=freq)
        return list(cal)

    def feature(self, instrument, field, start_index, end_index, freq):
        field = str(field)[1:]
        timeframe = timeframe_for_freq(freq)

        cal = self._get_calendar(freq)
        n = len(cal)
        lo = max(0, int(start_index))
        hi = min(n - 1, int(end_index))
        if lo > hi:
            return pd.Series(dtype=np.float32)

        keys = _calendar_keys(cal[lo : hi + 1], freq)
        ser = self._extract(str(instrument).upper(), field, timeframe, freq)
        if ser is None:
            vals = np.full(len(keys), np.nan, dtype=np.float64)
        else:
            vals = ser.reindex(keys).to_numpy(dtype=np.float64)
        return pd.Series(vals, index=pd.RangeIndex(lo, hi + 1))
