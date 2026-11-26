"""Narrative-feature family (``family=narr``) discovery coverage.

Run::

    .venv/bin/python -m pytest tests/test_narr_family.py -q

Covers the fina-builder side of NARRATIVE_FEATURES.md §4 (change 2):
``FEATURE_FAMILIES`` includes ``"narr"``, so ``LakeConfig.load_features``
merges the narr partition and ``get_common_feature_fields`` discovers the
``narr_*`` columns; and ``symbol_spans`` still reads listing spans from the
bar coverage rows, not the narr rows.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tac_qlib.contrib.data.handler import get_common_feature_fields  # noqa: E402
from tac_qlib.data.config import FEATURE_FAMILIES, LakeConfig  # noqa: E402

NARR_COLS = [
    "narr_sent_mean_24h",
    "narr_sent_z_30d",
    "narr_mentions_24h",
    "narr_burst_ratio",
    "narr_coverage_24h",
]


def _narr_frame(symbol: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "t": pd.to_datetime(["2026-11-22", "2026-11-23", "2026-11-24"]),
            "narr_sent_mean_24h": [0.5, -0.2, 0.1],
            "narr_sent_z_30d": [None, None, None],
            "narr_mentions_24h": [3, 5, 2],
            "narr_burst_ratio": [1.0, 1.0, 1.0],
            "narr_coverage_24h": [1, 1, 1],
        }
    )


def _ta_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "t": pd.to_datetime(["2026-11-22", "2026-11-23", "2026-11-24"]),
            "sma_5": [10.0, 11.0, 12.0],
        }
    )


@pytest.fixture
def narr_lake(tmp_path):
    """Temp lake with family=narr (+ one family=ta) partitions."""
    root = tmp_path / "lake"
    narr_dir = root / "features" / "market=US" / "timeframe=1d" / "family=narr"
    narr_dir.mkdir(parents=True)
    for sym in ("NVDA", "AAPL"):
        _narr_frame(sym).to_parquet(narr_dir / f"symbol={sym}.parquet", index=False)
    ta_dir = root / "features" / "market=US" / "timeframe=1d" / "family=ta"
    ta_dir.mkdir(parents=True)
    _ta_frame().to_parquet(ta_dir / "symbol=NVDA.parquet", index=False)
    return root


def test_feature_families_includes_narr():
    assert "narr" in FEATURE_FAMILIES
    assert FEATURE_FAMILIES == ("ta", "sp", "macro", "narr")


def test_get_common_feature_fields_discovers_narr(narr_lake):
    fields = get_common_feature_fields(str(narr_lake), market="US", timeframe="1d")
    for col in NARR_COLS:
        assert col in fields, f"{col} missing from discovered fields {fields}"
    assert "sma_5" in fields, "ta columns must still be discovered"


def test_load_features_merges_narr_and_ta(narr_lake):
    cfg = LakeConfig(str(narr_lake), "US")
    df = cfg.load_features("1d", "NVDA")
    assert len(df) == 3
    for col in NARR_COLS:
        assert col in df.columns
    assert "sma_5" in df.columns
    assert df.loc[df["t"] == "2026-11-22", "narr_sent_mean_24h"].iloc[0] == pytest.approx(0.5)
    assert df.loc[df["t"] == "2026-11-22", "narr_mentions_24h"].iloc[0] == 3


def test_symbol_spans_ignores_narr_coverage_rows(narr_lake):
    # Bars cover 2026-01-02..2026-11-24; the narr ingest only covers
    # 2026-11-22..2026-11-24. The listing span must stay the bar span.
    cov = pd.DataFrame(
        [
            {
                "market": "US",
                "timeframe": "1d",
                "symbol": "NVDA",
                "family": "bars",
                "first_t": pd.Timestamp("2026-01-02"),
                "last_t": pd.Timestamp("2026-11-24"),
                "num_bars": 230,
                "feed": "iex",
                "adjustment": "raw",
            },
            {
                "market": "US",
                "timeframe": "1d",
                "symbol": "NVDA",
                "family": "narr",
                "first_t": pd.Timestamp("2026-11-22"),
                "last_t": pd.Timestamp("2026-11-24"),
                "num_bars": 3,
                "feed": "narrative",
                "adjustment": "narr-v1",
            },
        ]
    )
    cov.to_parquet(narr_lake / "coverage.parquet", index=False)
    cfg = LakeConfig(str(narr_lake), "US")
    assert cfg.symbol_spans("NVDA", "1d") == [("2026-01-02", "2026-11-24")]


def test_symbol_spans_without_family_column(narr_lake):
    # Lakes written before the family column existed have no family column;
    # spans must still resolve (rows are treated as bar rows).
    cov = pd.DataFrame(
        [
            {
                "market": "US",
                "timeframe": "1d",
                "symbol": "NVDA",
                "first_t": pd.Timestamp("2026-01-02"),
                "last_t": pd.Timestamp("2026-11-24"),
                "num_bars": 230,
                "feed": "iex",
                "adjustment": "raw",
            }
        ]
    )
    cov.to_parquet(narr_lake / "coverage.parquet", index=False)
    cfg = LakeConfig(str(narr_lake), "US")
    assert cfg.symbol_spans("NVDA", "1d") == [("2026-01-02", "2026-11-24")]
