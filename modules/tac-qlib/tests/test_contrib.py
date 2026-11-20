"""Smoke tests for the tac_qlib contrib package (model/strategy).

Covers the pieces a workflow YAML resolves via ``module_path``:

  - ``tac_qlib.contrib.model.rank_gbdt``  -> RankICLGBModel (+ rank feval)
  - ``tac_qlib.contrib.strategy.optimal_stop``  -> OptimalStopControl

The strategy smoke test runs a real (tiny) daily backtest through qlib's
executor against the TradeAC lake. The model smoke test checks data
preparation (per-day query groups) + the rank feval without a full fit.

Run::

    TAC_LAKE_DIR=/home/data/lake .venv/bin/python tests/test_contrib.py
"""

import os
import sys

import numpy as np
import pandas as pd

try:
    import pytest
except ImportError:  # pragma: no cover - direct script mode
    pytest = None

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

LAKE_ROOT = os.environ.get("TAC_LAKE_DIR")
if not LAKE_ROOT:
    if pytest is not None:
        pytest.skip("TAC_LAKE_DIR is required for contrib coverage", allow_module_level=True)
    raise RuntimeError("TAC_LAKE_DIR is required for contrib coverage")
CODES = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"]
START, END = "2026-06-01", "2026-07-31"


def _signal(close: pd.DataFrame) -> pd.Series:
    """3-day momentum score indexed (datetime, instrument) covering [START, END]."""
    mom = close.pct_change(3).stack()
    mom.index = mom.index.set_names(["datetime", "instrument"])
    return mom.dropna()


def main():
    from tac_qlib.qlib_init import qlib_init

    qlib_init(provider_uri=LAKE_ROOT, market="US", freq="day", log_level="WARN")
    from qlib.data import D

    close = D.features(CODES, ["$close"], START, END, freq="day")["$close"]
    close = close.unstack("instrument")
    sig = _signal(close)
    assert len(sig) > 0, "empty synthetic signal"
    print(f"[ok] synthetic signal: {len(sig)} rows, {sig.index.get_level_values(0).nunique()} days")

    # ---- OptimalStopControl end-to-end ------------------------------------
    from tac_qlib.contrib.strategy.optimal_stop import OptimalStopControl
    from qlib.contrib.evaluate import backtest_daily

    strat = OptimalStopControl(
        signal=sig, topk=2, entry_pct=0.8, exit_pct=0.5,
        max_hold_days=5, min_hold_days=1, sl=-0.05, notional=10_000.0,
    )
    report, positions = backtest_daily(
        start_time=START, end_time=END, strategy=strat, account=1_000_000,
        benchmark=None,
        exchange_kwargs={"codes": CODES, "deal_price": "$close", "freq": "day",
                         "open_cost": 0.0005, "close_cost": 0.0015, "min_cost": 5.0},
    )
    assert isinstance(report, pd.DataFrame) and "return" in report and len(report) >= 5
    assert not report["return"].isna().all()
    print(f"[ok] OptimalStopControl backtest: {len(report)} days, "
          f"end equity {float(report['return'].add(1).cumprod().iloc[-1]):.4f}")

    # ---- RankICLGBModel: instantiate + _prepare_data (per-day groups) ------
    from tac_qlib.contrib.data.handler import TACHandler
    from qlib.data.dataset import DatasetH

    h = TACHandler(
        instruments=CODES, start_time=START, end_time=END,
        fit_start_time=START, fit_end_time="2026-06-30", freq="day",
        lake_root=LAKE_ROOT, market="US",
        label="Ref($close,-6)/Ref($close,-1)-1",
    )
    ds = DatasetH(
        handler=h,
        segments={"train": (START, "2026-06-30"), "valid": ("2026-07-01", END)},
    )
    from tac_qlib.contrib.model.rank_gbdt import RankICLGBModel, rankic_feval

    model = RankICLGBModel(loss="mse", learning_rate=0.05, num_leaves=7, n_estimators=50)
    data = model._prepare_data(ds)
    lgb_ds, names = list(zip(*data))
    assert names == ("train", "valid")
    groups = lgb_ds[0].get_group()
    assert groups is not None and len(groups) >= 5, f"per-day query groups missing: {groups}"
    # every group size == number of instruments that day
    assert set(groups) <= {len(CODES), len(CODES) - 1}, f"unexpected group sizes {groups}"
    print(f"[ok] RankICLGBModel._prepare_data: groups={groups[:5]}... (n_days={len(groups)})")

    # rank feval on a hand-built lgb.Dataset
    import lightgbm as lgb

    y = np.array([1.0, 2.0, 3.0, 3.0, 2.0, 1.0])
    preds = np.array([1.0, 2.0, 3.0, 3.0, 2.0, 1.0])
    dv = lgb.Dataset(np.zeros((6, 2)), label=y, group=np.array([3, 3]))
    name, value, higher = rankic_feval(preds, dv)
    assert name == "rankic" and higher is True and abs(value - 1.0) < 1e-9
    print(f"[ok] rankic_feval: {name}={value:.4f} (higher_is_better={higher})")

    print("\nALL CONTRIB CHECKS PASSED")


if __name__ == "__main__":
    main()
