#!/usr/bin/env python3
"""
macro-pred.py — market-regime synthetic instruments + bull/bear probability from the TradeAC lake.

Reads 1d bars for an ETF universe straight from the lake parquet layout
    {lake}/market=US/timeframe=1d/symbol=*.parquet   (hive_partitioning=true)
builds an equal-weighted synthetic market index, computes market-level regime
features, saves each series as a "synthetic ticker" CSV (one value column,
date index — ingestible like any instrument price file), then fits a sklearn
logistic regression on forward 3-month returns and emits P_bull.

Features (all strictly backward-looking at t):
    MKT_PCT_ABOVE_200    fraction of universe above its 200-day MA
    MKT_ADV_DEC_RATIO    advancers / decliners on the day
    MKT_MA50_MA200       synthetic-index MA50/MA200 - 1 (golden-cross spread)
    MKT_REALVOL_21       21d realized vol of the equal-weight index (annualized)
    MKT_LOGRET_{5,21,63,126}  multi-horizon log returns of the equal-weight index
    MKT_LEADERSHIP_W5    top-decile minus bottom-decile mean 5d return (breadth of leadership)
Label:
    forward_logret_h63   log return of the index over the NEXT 63 trading days
    bull_h63             1 if forward log return > 0

Train on all days before --test-start (default 2021-01-01), test 2021 -> end.

Usage:
    python tac-qlib/examples/macro-pred.py \
        --lake /home/data/lake \
        --start 2000-01-04 --end 2026-08-22 \
        --test-start 2021-01-01 \
        --forward-horizon 63 \
        --outdir macro_out
"""
from __future__ import annotations

import argparse
import os
import sys

import duckdb
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, roc_auc_score
from sklearn.preprocessing import StandardScaler

DEFAULT_UNIVERSE = (
    "SPY,QQQ,DIA,IWM,MDY,VTI,VOO,VEA,VWO,VT,EFA,EEM,TLT,IEF,SHY,AGG,BND,"
    "LQD,HYG,JNK,EMB,GLD,SLV,USO,UNG,DBA,DBC,XLK,XLF,XLE,XLV,XLI,XLY,XLP,"
    "XLU,XLB,XLRE,ARKK,SMH,SOXX,IBB,XBI,ITA,XAR,ICLN,TAN,FDN,IGV,ESPO,REM"
)


def read_price_panel(lake: str, symbols: list[str], start: str, end: str) -> pd.DataFrame:
    bars = f"{lake}/market=US/timeframe=1d/symbol=*.parquet"
    sym_list = ",".join(f"'{s}'" for s in symbols)
    con = duckdb.connect()
    df = con.execute(
        f"""
        SELECT CAST(date AS DATE) AS date,
               regexp_extract(filename, 'symbol=([^/]+)\\.parquet', 1) AS symbol,
               c AS close
        FROM read_parquet('{bars}', hive_partitioning=true, filename=true)
        WHERE date BETWEEN DATE '{start}' AND DATE '{end}'
          AND symbol IN ({sym_list})
        ORDER BY date, symbol
        """
    ).fetchdf()
    con.close()
    if df.empty:
        raise RuntimeError("no bars returned — check lake path / backfill")
    panel = df.pivot(index="date", columns="symbol", values="close").sort_index()
    return panel


def syn_index(prices: pd.DataFrame) -> pd.Series:
    """Equal-weighted market proxy: cumprod of cross-sectional mean daily log return."""
    mean_log = np.log(prices / prices.shift(1)).mean(axis=1)
    return (mean_log.fillna(0.0) + 1.0).cumprod()


def compute_features(prices: pd.DataFrame) -> pd.DataFrame:
    idx = syn_index(prices)
    rets = prices.pct_change(fill_method=None)
    feats = pd.DataFrame(index=prices.index)

    ma200 = prices.rolling(200, min_periods=120).mean()
    feats["pct_above_200"] = (prices > ma200).sum(axis=1) / prices.notna().sum(axis=1)

    adv = (rets > 0).sum(axis=1)
    dec = (rets < 0).sum(axis=1)
    feats["adv_dec_ratio"] = adv / dec.replace(0, np.nan)

    ma50_i = idx.rolling(50, min_periods=30).mean()
    ma200_i = idx.rolling(200, min_periods=120).mean()
    feats["ma50_ma200"] = ma50_i / ma200_i - 1.0

    daily_log = np.log(prices / prices.shift(1)).mean(axis=1)
    feats["realized_vol_21"] = daily_log.rolling(21, min_periods=10).std() * np.sqrt(252)

    for w in (5, 21, 63, 126):
        feats[f"logret_eq_w{w}"] = daily_log.rolling(w, min_periods=w).sum()

    past5 = prices.pct_change(5, fill_method=None)
    rnk = past5.rank(axis=1, pct=True)
    feats["leadership_spread_w5"] = past5.where(rnk >= 0.9).mean(axis=1) - past5.where(
        rnk <= 0.1
    ).mean(axis=1)

    feats["syn_index"] = idx
    return feats.replace([np.inf, -np.inf], np.nan)


def compute_labels(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    idx = syn_index(prices)
    fwd = np.log(idx.shift(-horizon) / idx)
    return pd.DataFrame(
        {"forward_logret": fwd, "bull": (fwd > 0).astype("Int64")}, index=prices.index
    )


def save_synthetic_tickers(feats: pd.DataFrame, labels: pd.DataFrame, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)
    names = {
        "pct_above_200": "MKT_PCT_ABOVE_200",
        "adv_dec_ratio": "MKT_ADV_DEC_RATIO",
        "ma50_ma200": "MKT_MA50_MA200",
        "realized_vol_21": "MKT_REALVOL_21",
        "logret_eq_w5": "MKT_LOGRET_5",
        "logret_eq_w21": "MKT_LOGRET_21",
        "logret_eq_w63": "MKT_LOGRET_63",
        "logret_eq_w126": "MKT_LOGRET_126",
        "leadership_spread_w5": "MKT_LEADERSHIP_W5",
        "syn_index": "MKT_SYN_INDEX",
    }
    for col, ticker in names.items():
        out = feats[[col]].copy()
        out.index.name = "date"
        out.to_csv(os.path.join(outdir, f"{ticker}.csv"))
    lab = labels.copy()
    lab.index.name = "date"
    lab.to_csv(os.path.join(outdir, "MKT_LABELS_H.csv"))
    print(f"synthetic tickers written to {outdir}/ ({len(names)} instruments + MKT_LABELS_H.csv)")


def fit_and_report(feats: pd.DataFrame, labels: pd.DataFrame, test_start: str) -> dict:
    feature_cols = [
        c
        for c in feats.columns
        if c not in ("syn_index",)
    ]
    df = feats[feature_cols].join(labels).dropna()
    df = df[df["bull"].notna()]
    y_all = df["bull"].astype(int)

    train = df.loc[df.index < pd.Timestamp(test_start)]
    test = df.loc[df.index >= pd.Timestamp(test_start)]
    X_tr, y_tr = train[feature_cols], y_all.loc[train.index]
    X_te, y_te = test[feature_cols], y_all.loc[test.index]

    scaler = StandardScaler().fit(X_tr)
    clf = LogisticRegression(max_iter=1000, solver="liblinear", class_weight="balanced").fit(
        scaler.transform(X_tr), y_tr
    )
    p_tr = clf.predict_proba(scaler.transform(X_tr))[:, 1]
    p_te = clf.predict_proba(scaler.transform(X_te))[:, 1]

    auc_tr = roc_auc_score(y_tr, p_tr)
    auc_te = roc_auc_score(y_te, p_te)
    acc_te = accuracy_score(y_te, p_te >= 0.5)

    print(f"\ntrain {train.index.min().date()} .. {train.index.max().date()}  n={len(train)}  (bull rate {y_tr.mean():.3f})")
    print(f"test  {test.index.min().date()} .. {test.index.max().date()}  n={len(test)}  (bull rate {y_te.mean():.3f})")
    print(f"AUC  train={auc_tr:.4f}  test={auc_te:.4f}")
    print(f"accuracy(test, thr=0.5) = {acc_te:.4f}")
    print("\nclassification report (test):")
    print(classification_report(y_te, p_te >= 0.5, digits=4, zero_division=0))

    print("coefficients (standardized):")
    for c, w in sorted(zip(feature_cols, clf.coef_[0]), key=lambda t: -abs(t[1])):
        print(f"  {c:>22} {w:+.3f}")

    proba = pd.Series(p_te, index=test.index, name="P_bull")
    strat = proba.map(lambda p: 1.0 if p >= 0.5 else 0.0) * test["forward_logret"].shift(1).fillna(0.0)
    bh = test["forward_logret"].fillna(0.0)
    print("\nlong-flat overlay on next-63d realized return (non-overlapping-ish view):")
    print(f"  always-long  : total {(bh.sum()):+.2%}   hit-rate {(bh > 0).mean():.3f}")
    print(f"  P_bull>=0.5  : total {(strat.sum()):+.2%}   days-on   {(proba >= 0.5).mean():.3f}")

    print(f"\nlatest labeled signal {proba.index.max().date()}: P_bull = {proba.iloc[-1]:.4f}"
          f"  -> {'BULL' if proba.iloc[-1] >= 0.5 else 'BEAR'}")

    latest = feats[feature_cols].iloc[[-1]].dropna()
    if not latest.empty:
        p_now = clf.predict_proba(scaler.transform(latest))[0, 1]
        print(f"today {feats.index[-1].date()}: P_bull = {p_now:.4f}"
              f"  -> {'BULL' if p_now >= 0.5 else 'BEAR'}")

    return {"p_test": proba, "auc_test": auc_te, "acc_test": acc_te}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--lake", default=os.environ.get("TAC_LAKE_DIR", "/home/data/lake"))
    ap.add_argument("--start", default="2000-01-04")
    ap.add_argument("--end", default="2026-08-22")
    ap.add_argument("--test-start", default="2021-01-01")
    ap.add_argument("--symbols", default=DEFAULT_UNIVERSE)
    ap.add_argument("--forward-horizon", type=int, default=63)
    ap.add_argument("--outdir", default="macro_out")
    ap.add_argument("--save", action="store_true", help="write synthetic-ticker CSVs")
    args = ap.parse_args(argv)

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    print(f"universe: {len(symbols)} symbols")

    prices = read_price_panel(args.lake, symbols, args.start, args.end)
    print(f"price panel: {prices.shape[0]} dates x {prices.shape[1]} symbols "
          f"({prices.index.min()} .. {prices.index.max()})")

    feats = compute_features(prices)
    labels = compute_labels(prices, args.forward_horizon)

    if args.save:
        save_synthetic_tickers(feats, labels, args.outdir)

    fit_and_report(feats, labels, args.test_start)


if __name__ == "__main__":
    sys.exit(main())
