"""End-to-end example: train a LightGBM on TradeAC lake data and backtest it.

Reads OHLCV + ta-lib features straight from the TradeAC parquet lake through the
tac-qlib providers and the ``TACHandler``, then runs the standard qlib research
loop (LightGBM + TopkDropoutStrategy + daily backtest).

Usage::

    .venv/bin/python tac-qlib/examples/run_backtest.py                          # defaults
    .venv/bin/python tac-qlib/examples/run_backtest.py --features '$close,$rsi_14,$sma_5,$macd' \\
        --universe AAPL,MSFT,TSLA,USO,SLV,TLT --output ./backtest_out

The lake has ~5 months of 1d bars (2026-02-09 .. 2026-08-06); the default split is
train 2026-03-01..2026-05-31 / valid 2026-06-01..2026-06-30 / test 2026-07-01..2026-08-06.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lake-root", default=os.environ.get("TAC_LAKE_DIR"))
    p.add_argument("--market", default="US")
    p.add_argument("--universe", default="AAPL,MSFT,TSLA,USO,SLV,TLT",
                   help="comma-separated instruments (default: the 1d-bar symbols)")
    p.add_argument("--features", default="$open,$high,$low,$close,$vwap,$volume,$amount",
                   help="comma-separated feature fields ($-prefixed)")
    p.add_argument("--label", default="Ref($close,-2)/$close-1")
    p.add_argument("--train-start", default="2026-03-01")
    p.add_argument("--train-end", default="2026-05-31")
    p.add_argument("--valid-end", default="2026-06-30")
    p.add_argument("--test-end", default="2026-08-06")
    p.add_argument("--topk", type=int, default=2)
    p.add_argument("--n-drop", type=int, default=1)
    p.add_argument("--init-cash", type=float, default=1_000_000.0)
    p.add_argument("--output", default="backtest_output")
    return p.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("lightgbm").setLevel(logging.WARNING)
    os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")  # qlib's mlflow file store opt-in

    universe = [s.strip().upper() for s in args.universe.split(",") if s.strip()]
    feature_fields = [f.strip() for f in args.features.split(",") if f.strip()]

    from tac_qlib.qlib_init import qlib_init

    qlib_init(provider_uri=args.lake_root, market=args.market, freq="day")

    from qlib.data.dataset import DatasetH
    from tac_qlib.contrib.data.handler import TACHandler

    valid_start = str(pd.Timestamp(args.train_end) + pd.Timedelta(days=1)).split()[0]
    test_start = str(pd.Timestamp(args.valid_end) + pd.Timedelta(days=1)).split()[0]

    # ---- dataset ---------------------------------------------------------
    handler = TACHandler(
        instruments=universe,
        start_time=args.train_start,
        end_time=args.test_end,
        freq="day",
        fit_start_time=args.train_start,
        fit_end_time=args.train_end,
        feature_fields=feature_fields,
        label=args.label,
        lake_root=args.lake_root,
        market=args.market,
    )
    dataset = DatasetH(
        handler=handler,
        segments={
            "train": (args.train_start, args.train_end),
            "valid": (valid_start, args.valid_end),
            "test": (test_start, args.test_end),
        },
    )

    # ---- train ------------------------------------------------------------
    from qlib.contrib.model.gbdt import LGBModel

    model = LGBModel(n_estimators=200, learning_rate=0.05, num_leaves=15, colsample_bytree=0.8,
                     subsample=0.8, subsample_freq=1, reg_alpha=0.01, reg_lambda=0.01)

    t0 = time.time()
    from qlib.workflow import R

    with R.start(experiment_name="tac-lake-demo"):
        model.fit(dataset)
    print(f"[train] fitted LGBModel in {time.time() - t0:.1f}s")

    # ---- predict ----------------------------------------------------------
    pred = model.predict(dataset)  # (datetime, instrument) MultiIndex Series
    print(f"[predict] {len(pred)} signals on test segment {test_start}..{args.test_end}")
    print(pred.head(5))

    # ---- backtest ---------------------------------------------------------
    from qlib.contrib.evaluate import backtest_daily, risk_analysis
    from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

    strategy = TopkDropoutStrategy(signal=pred, topk=args.topk, n_drop=args.n_drop,
                                   only_tradable=True, risk_degree=0.95)
    t0 = time.time()
    report_normal, positions_normal = backtest_daily(
        start_time=test_start,
        end_time=args.test_end,
        strategy=strategy,
        account=args.init_cash,
        benchmark=None,  # the lake has no index quotes
        exchange_kwargs={
            "codes": universe,
            "deal_price": "$close",
            "freq": "day",
            "open_cost": 0.0005,
            "close_cost": 0.0015,
            "min_cost": 5.0,
        },
    )
    print(f"[backtest] ran in {time.time() - t0:.1f}s over {len(report_normal)} trading days")

    risk = risk_analysis(report_normal["return"], freq="day")
    print("\n=== backtest risk analysis ===")
    print(risk.round(6).to_string())

    # ---- save -------------------------------------------------------------
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    pred.to_frame("score").to_pickle(out / "pred.pkl")
    report_normal.to_csv(out / "report_normal.csv")
    pd.DataFrame({ts: pos.get_stock_amount_dict() for ts, pos in positions_normal.items()}).T.to_csv(
        out / "positions_normal.csv"
    )
    risk.to_csv(out / "risk.csv")
    print(f"\nsaved artifacts to {out}/  (pred.pkl, report_normal.csv, positions_normal.csv, risk.csv)")


if __name__ == "__main__":
    main()
