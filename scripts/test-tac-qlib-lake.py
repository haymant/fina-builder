#!/usr/bin/env python3
"""Run tac-qlib lake integration smoke tests against a deterministic temp lake.

This harness deliberately creates the fixture outside the repository and passes its
path only through TAC_LAKE_DIR. It requires no credentials, network access, or
production lake data.

Run from the repository root with the locked module environment:

    uv run --project modules/tac-qlib --locked \
      python scripts/test-tac-qlib-lake.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TESTS = (
    ROOT / "modules" / "tac-qlib" / "tests" / "test_lake_providers.py",
    ROOT / "modules" / "tac-qlib" / "tests" / "test_contrib.py",
)
SYMBOLS = ("AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "SPY")


def create_fixture(root: Path) -> None:
    """Create the minimum TAC lake layout exercised by the integration scripts."""
    dates = pd.bdate_range("2026-01-02", "2026-08-10")
    bar_dir = root / "market=US" / "timeframe=1d"
    bar_dir.mkdir(parents=True)

    coverage = []
    for index, symbol in enumerate(SYMBOLS):
        steps = np.arange(len(dates), dtype=float)
        close = (
            100.0
            + index * 17
            + steps * (0.12 + index * 0.01)
            + np.sin(steps / 7.0) * 0.8
        )
        frame = pd.DataFrame(
            {
                "t": dates,
                "date": dates.date,
                "o": close - 0.2,
                "h": close + 0.5,
                "l": close - 0.5,
                "c": close,
                "v": 1_000_000 + index * 10_000,
                "n": 100 + index,
                "vw": close,
            }
        )
        frame.to_parquet(bar_dir / f"symbol={symbol}.parquet", index=False)
        coverage.append(
            {
                "market": "US",
                "timeframe": "1d",
                "symbol": symbol,
                "first_t": dates[0],
                "last_t": dates[-1],
            }
        )

    pd.DataFrame({"date": dates, "market": "US"}).to_parquet(
        root / "calendar.parquet", index=False
    )
    pd.DataFrame({"symbol": SYMBOLS, "market": "US"}).to_parquet(
        root / "symbols.parquet", index=False
    )
    pd.DataFrame(coverage).to_parquet(root / "coverage.parquet", index=False)


def run_test(test_file: Path, lake_root: Path) -> None:
    env = os.environ.copy()
    env["TAC_LAKE_DIR"] = str(lake_root)
    print(f"\n=== {test_file.relative_to(ROOT)} ===", flush=True)
    subprocess.run(
        [sys.executable, str(test_file)],
        cwd=ROOT,
        env=env,
        check=True,
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="fina-tac-lake-") as temp_dir:
        lake_root = Path(temp_dir)
        create_fixture(lake_root)
        print(
            f"Created deterministic TAC lake fixture with {len(SYMBOLS)} symbols "
            "and 157 business dates.",
            flush=True,
        )
        for test_file in TESTS:
            run_test(test_file, lake_root)

    print("\nTAC_LAKE_DIR integration smoke tests passed; temporary lake removed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
