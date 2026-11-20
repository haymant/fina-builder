"""Drop-in replacement for ``qlib.init`` that configures qlib against the TradeAC lake.

Usage::

    from tac_qlib.qlib_init import qlib_init

    qlib_init(
        provider_uri="/path/to/lake",          # same layout as tac-engine's TAC_LAKE_DIR
        market="US",
        freq="day",
        markets={"sp500": ["AAPL", "MSFT"]},   # optional named instrument pools
        **qlib_init_kwargs,                    # anything qlib.init accepts
    )

It sets ``provider_uri`` to the lake root and points the calendar / instrument / feature
providers at the lake-backed implementations, then delegates to the upstream ``qlib.init``.
The dataset provider (expression engine, backtest ``Exchange``) is left untouched, so the
rest of the qlib workflow is byte-for-byte upstream code.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Union

import qlib
from qlib.config import C

from .data.config import LakeConfig, resolve_lake_root

PROVIDERS = "tac_qlib.data.providers"


def provider_config(cls: str, **kwargs) -> dict:
    return {"class": f"{PROVIDERS}.{cls}", "kwargs": kwargs}


def qlib_init(
    provider_uri: Optional[str] = None,
    market: str = "US",
    freq: str = "day",
    markets: Optional[Dict[str, list]] = None,
    **qlib_kwargs,
) -> qlib.Initialized:
    """Initialize qlib with the lake-backed data providers and re-export qlib.init results."""
    if qlib_kwargs.pop("calendar_provider", None) is not None or qlib_kwargs.pop("instrument_provider", None) is not None:
        raise ValueError("calendar_provider / instrument_provider are managed by tac_qlib; use `market` instead")

    lake_root = resolve_lake_root(provider_uri)
    if freq != "day":
        raise ValueError("freq must be 'day' for now: the lake calendar only covers daily sessions")

    qlib_kwargs.setdefault("provider_uri", lake_root)
    qlib_kwargs.setdefault("region", "us")
    qlib_kwargs.setdefault("expression_cache", None)
    qlib_kwargs.setdefault("dataset_cache", None)
    qlib_kwargs["calendar_provider"] = provider_config("LakeCalendarProvider", lake_root=lake_root, market=market)
    qlib_kwargs["instrument_provider"] = provider_config(
        "LakeInstrumentProvider", lake_root=lake_root, market=market, markets=markets or {}
    )
    qlib_kwargs["feature_provider"] = provider_config("LakeFeatureProvider", lake_root=lake_root, market=market)
    return qlib.init(**qlib_kwargs)


__all__ = ["qlib_init", "provider_config"]
