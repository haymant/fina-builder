"""tac-qlib R&D MCP server (stdio transport).

Exposes the quant research workflow as MCP tools backed by tac-qlib + upstream qlib:

    prepare data  -> tac-engine lake tools (tradeac-lake skill; not here)
    preprocess    -> rd_dataset   (TACHandler + processor pipeline inspection)
    train         -> rd_train     (LightGBM on the lake, logged to mlflow)
    test          -> rd_evaluate  (IC / ICIR / Rank IC / Rank ICIR)
    predict       -> rd_predict   (persist pred.pkl / label.pkl)
    backtest      -> rd_backtest  (TopkDropoutStrategy + cost model + risk analysis)
    one-shot      -> rd_run_workflow (execute a qrun workflow yaml — in a background
                      thread, or in a separate process via run_in_new_process=true)

Run::

    .venv/bin/python -m tac_qlib.rd_server        # stdio MCP server

All tools return JSON-safe dicts. Logging goes to stderr; stdout is reserved for
the MCP protocol.
"""

from __future__ import annotations

import datetime as _dt
import copy
import json
import logging
import os
import pickle
import re
import shutil
import tempfile
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from tac_qlib.risk_limits import parse_limits

# Load the repo-root `.env` so the server reads the same env file whether
# spawned by opencode MCP, tac-app, or a shell. Existing process env (e.g.
# Coolify or `node --env-file`) wins — load_dotenv does not override
# already-set variables, mirroring tac-engine's dotenvy load.
#
# The module may resolve from the repo source (`tac-qlib/tac_qlib/`, e.g. when
# tac-app sets PYTHONPATH=<root>/tac-qlib) or from a wheel copy in site-packages
# (e.g. the Docker image's non-editable `uv pip install ./tac-qlib`, spawned via
# opencode). Locate the repo root by walking up until a `.env` file is found —
# fall back to the cwd so the container (no .env on disk, vars injected by
# Coolify) still picks up a local file if one is mounted.
from dotenv import load_dotenv

def _load_repo_env() -> None:
    # opencode (or a wrapper) may inject `{env:VAR}` substitutions as empty
    # strings for unset variables; drop those so the repo `.env` (or a real
    # injected value) can apply below.
    for _k in ("TAC_LAKE_DIR", "DATABASE_URL", "MLRUNS_URI"):
        if os.environ.get(_k) == "":
            os.environ.pop(_k, None)
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".env").is_file():
            load_dotenv(parent / ".env", override=False)
            return
    load_dotenv(Path.cwd() / ".env", override=False)

_load_repo_env()

server = MCPServer(
    name="tac-qlib-rd",
    title="TradeAC quant R&D",
    instructions=(
        "Tools for the quant R&D loop on the TradeAC parquet lake: dataset "
        "(preprocess), train, predict, evaluate, backtest, and one-shot qrun of "
        "a workflow yaml. Data preparation (bar/feature backfill) is done with the "
        "tac-engine lake tools (tradeac-lake skill)."
    ),
    version="0.1.0",
)

_INIT_STATE: Dict[str, Any] = {}


# --------------------------------------------------------------------------- utils
def _default_lake() -> str:
    """The lake root from ``TAC_LAKE_DIR`` (mandatory — no fallback)."""
    lake = os.environ.get("TAC_LAKE_DIR")
    if not lake:
        raise RuntimeError(
            "TAC_LAKE_DIR is not set. Point it at the TradeAC lake root, e.g. "
            "export TAC_LAKE_DIR=/home/data/lake (docker) or set an absolute "
            "path in your local .env."
        )
    return lake


def _default_mlruns_uri() -> str:
    """MLflow tracking URI: Postgres when ``$DATABASE_URL`` is set (no fallback).

    With ``$DATABASE_URL`` set the tracking store lives in the shared Postgres
    (MLflow's own ``experiments``/``runs``/... tables; artifacts stay on the
    filesystem under ``<lake>/mlruns``). The trace FK references Postgres
    ``runs(run_uuid)``, so the store MUST be Postgres whenever ``DATABASE_URL``
    exists — never a silent sqlite fallback. Only when ``DATABASE_URL`` is
    unset do we fall back to the lake sqlite store (with a loud warning).
    ``MLRUNS_URI`` overrides.
    """
    from tac_qlib.data.config import resolve_lake_root

    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    sqlite_uri = f"sqlite:///{resolve_lake_root(None)}/mlruns.db"
    print(
        "[rd_server] WARNING: DATABASE_URL not set — using the lake sqlite tracking store "
        f"({sqlite_uri}). Runs will NOT be in Postgres; traced experiments (FK to "
        "`runs(run_uuid)`) will fail to finalize. Set DATABASE_URL in the environment.",
        file=sys.stderr,
    )
    return sqlite_uri


def _tracking_sqlite_path(uri: str):
    """Extract the sqlite db path from an MLflow tracking uri (None for non-sqlite)."""
    uri = (uri or "").strip()
    if uri.startswith("sqlite:///"):
        return Path(uri[len("sqlite:///") :]).expanduser()
    if uri.startswith("sqlite://"):
        return Path(uri[len("sqlite://") :]).expanduser()
    return None


def _set_experiment_artifact_location(uri: str, exp_id: str, art_dir: str) -> bool:
    """Force an experiment's ``artifact_location`` to ``art_dir``.

    MLflow exposes no public API to change an experiment's artifact location
    after creation. Since runs derive their ``artifact_uri`` from it at
    ``create_run`` time (``append_to_uri_path(exp.artifact_location, run_id,
    "artifacts")``), a bare root like ``<lake>/mlruns`` makes runs land in
    ``mlruns/<run_id>/`` instead of ``mlruns/<exp_id>/<run_id>/``. For both the
    sqlite and postgres tracking stores the ``experiments`` table is
    authoritative, so patch it directly before any run is created.
    """
    if uri.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
        try:
            import psycopg

            with psycopg.connect(_postgres_dsn(uri)) as conn, conn.cursor() as cur:
                cur.execute(
                    "UPDATE experiments SET artifact_location = %s WHERE experiment_id = %s",
                    (art_dir, str(exp_id)),
                )
            return True
        except Exception:  # noqa: BLE001 - best-effort; runs still work, just not co-located
            return False
    db = _tracking_sqlite_path(uri)
    if db is None or not db.exists():
        return False
    try:
        import sqlite3

        conn = sqlite3.connect(db)
        try:
            conn.execute(
                "UPDATE experiments SET artifact_location=? WHERE experiment_id=?",
                (art_dir, str(exp_id)),
            )
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception:  # noqa: BLE001 - best-effort; runs still work, just not co-located
        return False


def _postgres_dsn(uri: str) -> str:
    """Normalise a postgres tracking uri to a psycopg/libpq conninfo string.

    MLflow URIs may be ``postgresql+psycopg://``, ``postgresql://`` or
    ``postgres://`` (the latter is not valid libpq); strip the SQLAlchemy
    driver suffix and normalise ``postgres://`` -> ``postgresql://``.
    """
    for prefix in ("postgresql+psycopg://", "postgresql://"):
        if uri.startswith(prefix):
            return "postgresql://" + uri[len(prefix) :]
    if uri.startswith("postgres://"):
        return "postgresql://" + uri[len("postgres://") :]
    return uri


def _pin_artifact_location(uri: str, exp_name: str) -> None:
    """Create (or fix) the experiment with artifacts pinned under the lake ``mlruns/``.

    MLflow's file artifact store defaults to ``./mlruns`` relative to the process
    cwd, so a run written by a server launched from another directory (e.g. the
    repo root) splits the DB (lake) from its artifacts (cwd). Pre-creating the
    experiment with an explicit ``artifact_location`` under the lake keeps both
    under ``$TAC_LAKE_DIR``.

    The location must include the experiment id (``<lake>/mlruns/<exp_id>``),
    otherwise runs land in ``<lake>/mlruns/<run_id>/`` and the experiment id is
    dropped from the on-disk layout. The id is only known after creation, so we
    create with a default location and then patch the sqlite ``experiments`` row
    to the id-suffixed path. Existing experiments (e.g. created before this
    function existed, or by an older pin) get their location corrected too.
    """
    try:
        from mlflow.tracking import MlflowClient

        from tac_qlib.data.config import resolve_lake_root

        art_root = str((resolve_lake_root(None) / "mlruns").resolve())
        client = MlflowClient(tracking_uri=uri)
        exp = client.get_experiment_by_name(exp_name)
        if exp is None:
            exp_id = client.create_experiment(exp_name)
        else:
            exp_id = exp.experiment_id
        _set_experiment_artifact_location(uri, exp_id, str(Path(art_root) / exp_id))
    except Exception:  # noqa: BLE001 - best-effort; runs still work, just not co-located
        pass


def _jsonable(obj: Any) -> Any:
    """Recursively convert numpy/pandas/datetime values to JSON-safe python types."""
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (pd.Timestamp, _dt.datetime, _dt.date, _dt.time)):
        return obj.isoformat()
    if isinstance(obj, float):
        return obj if not np.isnan(obj) and not np.isinf(obj) else None
    if obj is None or isinstance(obj, (str, int, bool)):
        return obj
    return str(obj)


def _resolve_universe(universe: Optional[str], lake_root: str, market: str) -> List[str]:
    if universe in (None, "", "all", "ALL"):
        from tac_qlib.data.config import LakeConfig

        return LakeConfig(lake_root, market).load_symbols()
    return [s.strip().upper() for s in str(universe).replace(" ", "").split(",") if s]


def _default_dates(lake_root: str, market: str):
    from tac_qlib.data.config import LakeConfig

    dates = LakeConfig(lake_root, market).load_calendar_dates()
    if not dates:
        raise ValueError(
            "lake calendar is empty; seed it first with tac-engine `backfill_lake_calendar`"
        )
    return dates[0], dates[-1]


def _ensure_init(lake_root: Optional[str], market: str) -> str:
    lake_root = str(Path(lake_root or _default_lake()).expanduser().resolve())
    market = (market or "US").upper()
    if _INIT_STATE.get("lake_root") == lake_root and _INIT_STATE.get("market") == market:
        return lake_root
    from tac_qlib.qlib_init import qlib_init

    uri = os.environ.get("MLRUNS_URI") or _default_mlruns_uri()
    exp_manager = {
        "class": "MLflowExpManager",
        "module_path": "qlib.workflow.expm",
        "kwargs": {"uri": uri, "default_exp_name": "tac-rd"},
    }
    qlib_init(provider_uri=lake_root, market=market, exp_manager=exp_manager)
    _INIT_STATE.update(lake_root=lake_root, market=market)
    return lake_root


def _feature_fields(features: Optional[str], freq: str, lake_root: str, market: str) -> List[str]:
    from tac_qlib.contrib.data.handler import TACHandler

    return TACHandler._normalize_feature_fields(features or None, freq, lake_root, market)


def _build_dataset(
    lake_root: str,
    market: str,
    universe: List[str],
    start_time: str,
    end_time: str,
    fit_start_time: str,
    fit_end_time: str,
    freq: str,
    features: Optional[str],
    label: Optional[str],
    train: Optional[tuple],
    valid: Optional[tuple],
    test: Optional[tuple],
):
    from qlib.data.dataset import DatasetH
    from tac_qlib.contrib.data.handler import TACHandler

    handler = TACHandler(
        instruments=universe,
        start_time=start_time,
        end_time=end_time,
        freq=freq,
        fit_start_time=fit_start_time,
        fit_end_time=fit_end_time,
        feature_fields=features,
        label=label,
        lake_root=lake_root,
        market=market,
    )
    segments = {}
    if train is not None:
        segments["train"] = train
    if valid is not None:
        segments["valid"] = valid
    if test is not None:
        segments["test"] = test
    dataset = DatasetH(handler=handler, segments=segments) if segments else None
    return dataset, handler


def _seg_stats(dataset, seg: str) -> dict:
    from qlib.data.dataset.handler import DataHandlerLP

    df = dataset.prepare(seg, col_set="feature", data_key=DataHandlerLP.DK_I)
    dates = df.index.get_level_values(0)
    insts = sorted(df.index.get_level_values(1).dropna().astype(str).unique())
    return {
        "rows": int(len(df)),
        "date_min": str(pd.Timestamp(dates.min()).date()),
        "date_max": str(pd.Timestamp(dates.max()).date()),
        "instruments": insts,
    }


def _nan_ratios(lake_root: str, market: str, universe: List[str], fields: List[str],
                start_time: str, end_time: str, freq: str) -> dict:
    from qlib.data import D

    out = {}
    for f in fields:
        df = D.features(universe, [f], start_time, end_time, freq)
        n = int(len(df))
        nn = int(df.iloc[:, 0].notna().sum())
        out[f] = {"rows": n, "non_nan": nn, "nan_ratio": round((n - nn) / n, 4) if n else None}
    return out


def _load_model(model_path: Optional[str], run_id: Optional[str], experiment_name: str):
    if model_path:
        with open(model_path, "rb") as fh:
            return pickle.load(fh)
    if run_id:
        return _load_artifact(experiment_name, run_id, "params.pkl")
    raise ValueError("provide either model_path or run_id")


def _load_artifact(experiment_name: str, run_id: str, name: str):
    from qlib.workflow import R

    exp = R.get_exp(experiment_name=experiment_name)
    rec = exp.get_recorder(recorder_id=run_id)
    if rec is None:
        raise ValueError(f"no recorder {run_id!r} in experiment {experiment_name!r}")
    return rec.load_object(name)


def _head_rows(pred: pd.DataFrame, top: int) -> List[dict]:
    rows = []
    for (ts, inst), v in list(pred.iloc[:, 0].items())[:top]:
        rows.append({"date": str(pd.Timestamp(ts).date()), "instrument": str(inst),
                     "score": round(float(v), 6)})
    return rows


# --------------------------------------------------------------------------- tools
@server.tool(structured_output=False)
def rd_status(lake_root: str = "", market: str = "US") -> dict:
    """Inspect the TradeAC lake: root, calendar range, symbols, per-symbol coverage windows and available ta-lib feature columns. Call this first to confirm the lake is populated before running dataset / train / predict / backtest tools."""
    lake_root = lake_root or _default_lake()
    from tac_qlib.data.config import LakeConfig

    cfg = LakeConfig(lake_root, market)
    root = str(cfg.lake_root)
    cal = cfg.load_calendar_dates()
    symbols = cfg.load_symbols()

    coverage = []
    cp = cfg.coverage_path()
    if cp.exists():
        df = pd.read_parquet(cp)
        if len(df):
            cols = [c for c in ("market", "timeframe", "symbol", "feed", "first_t", "last_t") if c in df.columns]
            for _, r in df[cols].sort_values(["symbol", "timeframe"]).iterrows():
                coverage.append(_jsonable(r.to_dict()))

    features = []
    from tac_qlib.contrib.data.handler import get_common_feature_fields

    for timeframe in ("1d", "1m", "1h"):
        try:
            fl = get_common_feature_fields(lake_root, market, timeframe)
        except Exception:
            fl = []
        if fl:
            features.append({"timeframe": timeframe, "columns": fl})

    return {
        "lake_root": root,
        "market": market.upper(),
        "calendar_days": len(cal),
        "calendar_start": str(pd.Timestamp(cal[0]).date()) if cal else None,
        "calendar_end": str(pd.Timestamp(cal[-1]).date()) if cal else None,
        "symbols": symbols,
        "symbol_count": len(symbols),
        "coverage": coverage,
        "features": features,
    }


@server.tool(structured_output=False)
def rd_dataset(
    lake_root: str = "",
    market: str = "US",
    universe: str = "all",
    start_time: str = "",
    end_time: str = "",
    fit_start_time: str = "",
    fit_end_time: str = "",
    freq: str = "day",
    features: str = "",
    label: str = "",
    train_start: str = "",
    train_end: str = "",
    valid_start: str = "",
    valid_end: str = "",
    test_start: str = "",
    test_end: str = "",
) -> dict:
    """Build (but do not train) the dataset for the given universe / window / segments and report the preprocessing outcome: final feature columns, per-segment row counts + date ranges, and raw NaN coverage per feature over the fit window (columns that are 100% NaN get dropped by DropAllNaN)."""
    lake_root = _ensure_init(lake_root, market)
    market = (market or "US").upper()
    universe_l = _resolve_universe(universe, lake_root, market)
    if not universe_l:
        raise ValueError("empty universe: the lake has no symbols; backfill bars first")

    if not start_time or not end_time:
        first, last = _default_dates(lake_root, market)
        start_time = start_time or str(pd.Timestamp(first).date())
        end_time = end_time or str(pd.Timestamp(last).date())
    fit_start_time = fit_start_time or start_time
    fit_end_time = fit_end_time or end_time

    fields = _feature_fields(features, freq, lake_root, market)
    label_expr = label or "Ref($close,-2)/Ref($close,-1)-1"

    train = (train_start, train_end) if train_start and train_end else None
    valid = (valid_start, valid_end) if valid_start and valid_end else None
    test = (test_start, test_end) if test_start and test_end else None

    dataset, handler = _build_dataset(
        lake_root, market, universe_l, start_time, end_time, fit_start_time, fit_end_time,
        freq, features or None, label_expr, train, valid, test,
    )

    segments = {}
    if dataset is not None:
        for name in ("train", "valid", "test"):
            if name in dataset.segments:
                segments[name] = _seg_stats(dataset, name)

    ratios = _nan_ratios(lake_root, market, universe_l, fields, fit_start_time, fit_end_time, freq)
    all_nan = [f for f, r in ratios.items() if r["non_nan"] == 0]
    nan_ratio = {f: r["nan_ratio"] for f, r in ratios.items() if r["nan_ratio"] and r["nan_ratio"] > 0}

    return {
        "lake_root": lake_root,
        "market": market,
        "freq": freq,
        "universe": universe_l,
        "universe_size": len(universe_l),
        "window": {"start": start_time, "end": end_time, "fit_start": fit_start_time, "fit_end": fit_end_time},
        "feature_fields": fields,
        "label": label_expr,
        "segments": segments,
        "all_nan_dropped": all_nan,
        "nan_ratio_nonzero": nan_ratio,
    }


@server.tool(structured_output=False)
def rd_train(
    wait: bool = True,
    lake_root: str = "",
    market: str = "US",
    universe: str = "all",
    train_start: str = "",
    train_end: str = "",
    valid_start: str = "",
    valid_end: str = "",
    test_start: str = "",
    test_end: str = "",
    freq: str = "day",
    features: str = "",
    label: str = "",
    learning_rate: float = 0.05,
    num_leaves: int = 15,
    num_boost_round: int = 200,
    early_stopping_rounds: int = 50,
    colsample_bytree: float = 0.8,
    subsample: float = 0.8,
    subsample_freq: int = 1,
    reg_alpha: float = 0.01,
    reg_lambda: float = 0.01,
    seed: int = 2026,
    experiment_name: str = "tac-rd",
    out_dir: str = "tac-rd-output",
    record_analysis: bool = True,
    benchmark: str = "",
    topk: int = 2,
    n_drop: int = 1,
    account: int = 1000000,
    risk_degree: float = 0.95,
    open_cost: float = 0.0005,
    close_cost: float = 0.0015,
    min_cost: float = 5.0,
    risk_limits: str = "",
) -> dict:
    """Fit a LightGBM (LGBModel, mse) on the lake dataset and log it to mlflow. When ``record_analysis`` is set (default), also runs SignalRecord / SigAnaRecord (ana_long_short) / PortAnaRecord on the test segment so the run records pred/label, IC/Rank IC series, long-short group returns and the portfolio backtest. The model is also pickled to <out_dir>/params.pkl so later steps can reuse it via model_path (or via the returned run_id). With ``wait=False`` the training runs in the background and the tool returns immediately — poll rd_exp_get_run / rd_exp_list for the newest run of ``experiment_name`` (status RUNNING until it finishes) and reuse its run_id. risk_limits: JSON spec recorded as run tag ``rd.risk_limits``; the run's PortAnaRecord backtest folds size/concentration caps into risk_degree (liquidity floor is applied by rd_backtest on the recorded pred)."""
    kwargs = dict(
        lake_root=lake_root, market=market, universe=universe,
        train_start=train_start, train_end=train_end,
        valid_start=valid_start, valid_end=valid_end,
        test_start=test_start, test_end=test_end,
        freq=freq, features=features, label=label,
        learning_rate=learning_rate, num_leaves=num_leaves,
        num_boost_round=num_boost_round, early_stopping_rounds=early_stopping_rounds,
        colsample_bytree=colsample_bytree, subsample=subsample,
        subsample_freq=subsample_freq, reg_alpha=reg_alpha, reg_lambda=reg_lambda,
        seed=seed, experiment_name=experiment_name, out_dir=out_dir,
        record_analysis=record_analysis, benchmark=benchmark, topk=topk, n_drop=n_drop,
        account=account, risk_degree=risk_degree, open_cost=open_cost,
        close_cost=close_cost, min_cost=min_cost, risk_limits=risk_limits,
    )
    if wait:
        return _rd_train_impl(**kwargs)
    threading.Thread(target=_rd_train_impl, kwargs=kwargs, daemon=True).start()
    return {
        "status": "started",
        "background": True,
        "experiment_name": experiment_name,
        "out_dir": out_dir,
        "note": ("training running in the background — poll rd_exp_get_run / rd_exp_list for the "
                 "newest run of this experiment (status RUNNING until it finishes), reuse its run_id, "
                 "then use the model via run_id or the params.pkl written to out_dir"),
    }


def _rd_train_impl(
    lake_root: str = "",
    market: str = "US",
    universe: str = "all",
    train_start: str = "",
    train_end: str = "",
    valid_start: str = "",
    valid_end: str = "",
    test_start: str = "",
    test_end: str = "",
    freq: str = "day",
    features: str = "",
    label: str = "",
    learning_rate: float = 0.05,
    num_leaves: int = 15,
    num_boost_round: int = 200,
    early_stopping_rounds: int = 50,
    colsample_bytree: float = 0.8,
    subsample: float = 0.8,
    subsample_freq: int = 1,
    reg_alpha: float = 0.01,
    reg_lambda: float = 0.01,
    seed: int = 2026,
    experiment_name: str = "tac-rd",
    out_dir: str = "tac-rd-output",
    record_analysis: bool = True,
    benchmark: str = "",
    topk: int = 2,
    n_drop: int = 1,
    account: int = 1000000,
    risk_degree: float = 0.95,
    open_cost: float = 0.0005,
    close_cost: float = 0.0015,
    min_cost: float = 5.0,
    risk_limits: str = "",
) -> dict:
    lake_root = _ensure_init(lake_root, market)
    market = (market or "US").upper()
    universe_l = _resolve_universe(universe, lake_root, market)
    if not (train_start and train_end):
        raise ValueError("train_start and train_end are required")
    test_start = test_start or train_end
    test_end = test_end or str(pd.Timestamp(pd.Timestamp(train_end) + pd.Timedelta(days=30)).date())

    first, _last = _default_dates(lake_root, market)
    start_time = min(str(pd.Timestamp(first).date()), train_start)
    end_time = test_end
    fit_start_time, fit_end_time = train_start, train_end

    label_expr = label or "Ref($close,-2)/Ref($close,-1)-1"
    train = (train_start, train_end)
    valid = (valid_start, valid_end) if valid_start and valid_end else None
    test = (test_start, test_end)

    dataset, handler = _build_dataset(
        lake_root, market, universe_l, start_time, end_time, fit_start_time, fit_end_time,
        freq, features or None, label_expr, train, valid, test,
    )

    from qlib.contrib.model.gbdt import LGBModel
    from qlib.workflow import R

    model = LGBModel(
        loss="mse",
        learning_rate=learning_rate,
        num_leaves=num_leaves,
        colsample_bytree=colsample_bytree,
        subsample=subsample,
        subsample_freq=subsample_freq,
        reg_alpha=reg_alpha,
        reg_lambda=reg_lambda,
        seed=seed,
    )

    feature_fields = _feature_fields(features, freq, lake_root, market)
    segments_cfg = {}
    for name, seg in (("train", train), ("valid", valid), ("test", test)):
        if seg:
            segments_cfg[name] = list(seg)
    config = {
        "qlib_init": {
            "provider_uri": lake_root,
            "region": market.lower(),
            "exp_manager": {"class": "MLflowExpManager", "module_path": "qlib.workflow.expm",
                            "kwargs": {"uri": os.environ.get("MLRUNS_URI") or _default_mlruns_uri(),
                                       "default_exp_name": experiment_name}},
        },
        "task": {
            "model": {"class": "LGBModel", "module_path": "qlib.contrib.model.gbdt", "kwargs": {
                "loss": "mse", "learning_rate": learning_rate, "num_leaves": num_leaves,
                "n_estimators": num_boost_round, "colsample_bytree": colsample_bytree,
                "subsample": subsample, "subsample_freq": subsample_freq,
                "reg_alpha": reg_alpha, "reg_lambda": reg_lambda, "seed": seed}},
            "dataset": {"class": "DatasetH", "module_path": "qlib.data.dataset", "kwargs": {
                "handler": {"class": "TACHandler", "module_path": "tac_qlib.contrib.data.handler", "kwargs": {
                    "instruments": universe_l, "start_time": start_time, "end_time": end_time,
                    "fit_start_time": fit_start_time, "fit_end_time": fit_end_time, "freq": freq,
                    "feature_fields": feature_fields, "label": label_expr,
                    "lake_root": lake_root, "market": market}},
                "segments": segments_cfg}},
            "record": [],
        },
    }

    t0 = time.time()
    record_warns: List[str] = []
    _pin_artifact_location(os.environ.get("MLRUNS_URI") or _default_mlruns_uri(), experiment_name)
    limits = parse_limits(risk_limits)
    eff_degree = risk_degree
    if limits:
        if limits.get("size_cap_pct"):
            eff_degree = min(eff_degree, limits["size_cap_pct"] * topk / 100.0)
        if limits.get("concentration_cap_pct"):
            eff_degree = min(eff_degree, limits["concentration_cap_pct"] / 100.0)
    with R.start(experiment_name=experiment_name):
        model.fit(dataset, num_boost_round=num_boost_round,
                  early_stopping_rounds=early_stopping_rounds, verbose_eval=0)
        R.save_objects(**{"params.pkl": model})
        R.save_objects(config=config)
        rec = R.get_recorder()
        try:
            R.set_tags(rd_experiment_id=str(rec.info.get("experiment_id", "")),
                       rd_run_id=str(rec.info.get("id", "")))
            if limits:
                R.set_tags(**{"rd.risk_limits": json.dumps(limits, sort_keys=True),
                              "rd.risk_degree_effective": str(eff_degree)})
        except Exception:  # noqa: BLE001 - tags are best-effort
            pass
        if record_analysis:
            try:
                from qlib.workflow.record_temp import PortAnaRecord, SigAnaRecord, SignalRecord

                SignalRecord(model=model, dataset=dataset, recorder=rec).generate()
                SigAnaRecord(recorder=rec, ana_long_short=True, ann_scaler=252).generate()
                port_config = {
                    "strategy": {
                        "class": "TopkDropoutStrategy",
                        "module_path": "qlib.contrib.strategy",
                        "kwargs": {"signal": "<PRED>", "topk": topk, "n_drop": n_drop,
                                   "only_tradable": True, "risk_degree": eff_degree},
                    },
                    "backtest": {
                        "start_time": test_start,
                        "end_time": test_end,
                        "account": account,
                        "exchange_kwargs": {"codes": universe_l, "deal_price": "$close", "freq": freq,
                                            "open_cost": open_cost, "close_cost": close_cost, "min_cost": min_cost},
                    },
                }
                if benchmark:
                    port_config["backtest"]["benchmark"] = benchmark
                PortAnaRecord(recorder=rec, config=port_config, risk_analysis_freq="1d").generate()
            except Exception as exc:  # noqa: BLE001 - analysis is best-effort; training already succeeded
                record_warns.append(f"analysis records failed: {exc}")
    fit_sec = round(time.time() - t0, 2)
    info = dict(rec.info)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "params.pkl", "wb") as fh:
        pickle.dump(model, fh)

    return {
        "experiment_name": experiment_name,
        "run_id": info.get("id"),
        "status": info.get("status"),
        "fit_seconds": fit_sec,
        "feature_fields": feature_fields,
        "label": label_expr,
        "segments": {s: _seg_stats(dataset, s) for s in ("train", "valid", "test") if s in dataset.segments},
        "model_path": str(out / "params.pkl"),
        "out_dir": str(out),
        "record_warnings": record_warns,
    }


@server.tool(structured_output=False)
def rd_predict(
    model_path: str = "",
    run_id: str = "",
    experiment_name: str = "tac-rd",
    lake_root: str = "",
    market: str = "US",
    universe: str = "all",
    train_start: str = "",
    train_end: str = "",
    valid_start: str = "",
    valid_end: str = "",
    test_start: str = "",
    test_end: str = "",
    freq: str = "day",
    features: str = "",
    label: str = "",
    out_dir: str = "tac-rd-output",
    top: int = 5,
) -> dict:
    """Predict on the test segment with a fitted model (from model_path pickle or an mlflow run_id) and persist pred.pkl / label.pkl to out_dir. Returns the score head and summary stats."""
    lake_root = _ensure_init(lake_root, market)
    market = (market or "US").upper()
    universe_l = _resolve_universe(universe, lake_root, market)
    if not (test_start and test_end):
        raise ValueError("test_start and test_end are required")
    if not (train_start and train_end):
        first, _ = _default_dates(lake_root, market)
        train_start = str(pd.Timestamp(first).date())
        train_end = str((pd.Timestamp(test_start) - pd.Timedelta(days=1)).date())

    first, _last = _default_dates(lake_root, market)
    start_time = min(str(pd.Timestamp(first).date()), train_start)
    end_time = test_end
    fit_start_time, fit_end_time = train_start, train_end

    label_expr = label or "Ref($close,-2)/Ref($close,-1)-1"
    train = (train_start, train_end)
    valid = (valid_start, valid_end) if valid_start and valid_end else None
    test = (test_start, test_end)

    dataset, _handler = _build_dataset(
        lake_root, market, universe_l, start_time, end_time, fit_start_time, fit_end_time,
        freq, features or None, label_expr, train, valid, test,
    )

    model = _load_model(model_path or None, run_id or None, experiment_name)
    pred = model.predict(dataset, segment="test")
    pred_df = pred.to_frame("score")

    from qlib.data.dataset.handler import DataHandlerLP

    label_df = dataset.prepare("test", col_set="label", data_key=DataHandlerLP.DK_I)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pred_df.to_pickle(out / "pred.pkl")
    label_df.to_pickle(out / "label.pkl")

    s = pred_df.iloc[:, 0]
    return {
        "pred_path": str(out / "pred.pkl"),
        "label_path": str(out / "label.pkl"),
        "count": int(len(s)),
        "date_min": str(pd.Timestamp(s.index.get_level_values(0).min()).date()),
        "date_max": str(pd.Timestamp(s.index.get_level_values(0).max()).date()),
        "instruments": sorted(s.index.get_level_values(1).dropna().astype(str).unique()),
        "score_mean": round(float(s.mean()), 6),
        "score_std": round(float(s.std()), 6),
        "score_min": round(float(s.min()), 6),
        "score_max": round(float(s.max()), 6),
        "head": _head_rows(pred_df, int(top)),
    }


@server.tool(structured_output=False)
def rd_evaluate(
    pred_path: str = "",
    label_path: str = "",
    run_id: str = "",
    experiment_name: str = "tac-rd",
    ann_scaler: int = 252,
) -> dict:
    """Evaluate a saved prediction against the label with per-day IC / Rank IC (qlib calc_ic): mean, std, annual vol, IR, skew, kurtosis, max drawdown, plus the headline IC / ICIR / Rank IC / Rank ICIR metrics that SigAnaRecord logs. Loads pred.pkl / label.pkl from paths or from an mlflow run."""
    if pred_path:
        pred = pd.read_pickle(pred_path)
    elif run_id:
        pred = _load_artifact(experiment_name, run_id, "pred.pkl")
    else:
        raise ValueError("provide either pred_path or run_id")

    if label_path:
        label = pd.read_pickle(label_path)
    elif run_id:
        label = _load_artifact(experiment_name, run_id, "label.pkl")
    else:
        raise ValueError("a label is required to compute IC; pass label_path or run_id")

    from qlib.contrib.eva.alpha import calc_ic

    ic, ric = calc_ic(pred.iloc[:, 0], label.iloc[:, 0], dropna=True)

    def _stats(s: pd.Series) -> dict:
        s = s.dropna()
        mean = float(s.mean())
        std = float(s.std(ddof=1))
        return {
            "days": int(len(s)),
            "mean": round(mean, 6),
            "std": round(std, 6),
            "ann_vol": round(std * float(np.sqrt(ann_scaler)), 6),
            "ir": round(mean / std * float(np.sqrt(ann_scaler)), 6) if std > 0 else None,
            "skew": round(float(s.skew()), 6),
            "kurt": round(float(s.kurt()), 6),
            "maxdd": round(float((s.cumsum() - s.cumsum().cummax()).min()), 6),
        }

    ic_std, ric_std = float(ic.std(ddof=1)), float(ric.std(ddof=1))
    return {
        "IC": _stats(ic),
        "RankIC": _stats(ric),
        "headline": {
            "IC": round(float(ic.mean()), 6),
            "ICIR": round(float(ic.mean()) / ic_std, 6) if ic_std > 0 else None,
            "Rank IC": round(float(ric.mean()), 6),
            "Rank ICIR": round(float(ric.mean()) / ric_std, 6) if ric_std > 0 else None,
        },
    }


@server.tool(structured_output=False)
def rd_backtest(
    pred_path: str,
    start_time: str,
    end_time: str,
    lake_root: str = "",
    market: str = "US",
    topk: int = 2,
    n_drop: int = 1,
    risk_degree: float = 0.95,
    benchmark: str = "",
    account: float = 1000000.0,
    universe: str = "",
    open_cost: float = 0.0005,
    close_cost: float = 0.0015,
    min_cost: float = 5.0,
    out_dir: str = "tac-rd-output",
    risk_limits: str = "",
) -> dict:
    """Run a daily backtest of the saved prediction with TopkDropoutStrategy and a cost model, then compute risk analysis (mean, std, annualized return, information ratio, max drawdown). Writes report/positions/risk to out_dir. benchmark: any symbol the lake holds, or empty for none. risk_limits: JSON (liquidity_floor_adv, size_cap_pct, concentration_cap_pct) applied as a signal filter so the same spec that gates live also gates backtest."""
    lake_root = _ensure_init(lake_root, market)
    pred = pd.read_pickle(pred_path)
    if isinstance(pred, pd.DataFrame):
        col = "score" if "score" in pred.columns else pred.columns[0]
        pred = pred[col]
    pred = pred.astype(float).sort_index()
    insts = sorted(pred.index.get_level_values(1).dropna().astype(str).unique())
    codes = [s.strip().upper() for s in str(universe).replace(" ", "").split(",") if s] or insts

    from qlib.contrib.evaluate import backtest_daily, risk_analysis
    from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

    signal = pred
    limits_applied = {}
    limits = parse_limits(risk_limits)
    if limits:
        from tac_qlib.risk_limits import dollar_adv

        end_ts = pd.Timestamp(end_time)
        adv = dollar_adv(codes, lake_root, market, asof=end_ts.isoformat())
        floor = limits.get("liquidity_floor_adv")
        if floor:
            illiquid = sorted(s for s in insts if adv.get(str(s).upper(), 0.0) < floor)
            if illiquid:
                bad = {str(s).upper() for s in illiquid}
                inst_lev = signal.index.get_level_values(1).astype(str).str.upper()
                keep = ~inst_lev.isin(bad)
                signal = signal[keep]
                limits_applied["dropped_liquidity"] = sorted(bad)
                limits_applied["note"] = f"liquidity floor ${floor:,.0f} ADV dropped {len(bad)} symbols"

        # size / concentration caps fold into effective risk_degree (equal-weight TopkDropout)
        eff_degree = risk_degree
        if limits.get("size_cap_pct"):
            eff_degree = min(eff_degree, limits["size_cap_pct"] * topk / 100.0)
            limits_applied["size_cap_risk_degree"] = round(eff_degree, 4)
        if limits.get("concentration_cap_pct"):
            eff_degree = min(eff_degree, limits["concentration_cap_pct"] / 100.0)
            limits_applied["concentration_cap_risk_degree"] = round(eff_degree, 4)
        if abs(eff_degree - risk_degree) > 1e-9:
            limits_applied["risk_degree_from"] = risk_degree
            limits_applied["risk_degree"] = eff_degree

    strategy = TopkDropoutStrategy(
        signal=signal, topk=topk, n_drop=n_drop, only_tradable=True,
        risk_degree=eff_degree if limits else risk_degree,
    )
    report, positions = backtest_daily(
        start_time=start_time,
        end_time=end_time,
        strategy=strategy,
        account=account,
        benchmark=benchmark or None,
        exchange_kwargs={
            "codes": codes,
            "deal_price": "$close",
            "freq": "day",
            "open_cost": open_cost,
            "close_cost": close_cost,
            "min_cost": min_cost,
        },
    )

    risk = risk_analysis(report["return"], freq="day")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    report.to_csv(out / "report_normal.csv")
    pd.DataFrame({ts: pos.get_stock_amount_dict() for ts, pos in positions.items()}).T.to_csv(
        out / "positions_normal.csv"
    )
    risk.to_csv(out / "risk.csv")

    return {
        "start_time": start_time,
        "end_time": end_time,
        "trading_days": int(len(report)),
        "risk": {str(k): round(float(v), 6) for k, v in risk.iloc[:, 0].items()},
        "benchmark": benchmark or None,
        "topk": topk,
        "n_drop": n_drop,
        "risk_limits_applied": limits_applied,
        "artifacts": [str(out / n) for n in ("report_normal.csv", "positions_normal.csv", "risk.csv")],
    }


@server.tool(structured_output=False)
def rd_risk_calibrate(
    pred_path: str,
    start_time: str,
    end_time: str,
    lake_root: str = "",
    market: str = "US",
    topk: int = 2,
    n_drop: int = 1,
    risk_degree: float = 0.95,
    benchmark: str = "",
    account: float = 1000000.0,
    universe: str = "",
    open_cost: float = 0.0005,
    close_cost: float = 0.0015,
    min_cost: float = 5.0,
    risk_limits: str = "",
    out_dir: str = "tac-rd-calibrate",
) -> dict:
    """Prove the risk-limit spec: run limit-vs-no-limit A/B plus a sensitivity grid over each limit dimension (size_cap_pct, concentration_cap_pct, liquidity_floor_adv), and compare Sharpe / Calmar / max drawdown / ann. return. Pass the round's `risk_limits` spec as the A/B candidate. Returns rows ordered by Sharpe and the raw per-run risk dicts; use it (B2) to pick the spec that keeps live ≈ backtest."""
    lake_root = _ensure_init(lake_root, market)
    pred = pd.read_pickle(pred_path)
    if isinstance(pred, pd.DataFrame):
        col = "score" if "score" in pred.columns else pred.columns[0]
        pred = pred[col]
    pred = pred.astype(float).sort_index()
    insts = sorted(pred.index.get_level_values(1).dropna().astype(str).unique())
    codes = [s.strip().upper() for s in str(universe).replace(" ", "").split(",") if s] or insts

    from qlib.contrib.evaluate import backtest_daily, risk_analysis
    from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

    from tac_qlib.risk_limits import dollar_adv

    adv = dollar_adv(codes, lake_root, market, asof=str(pd.Timestamp(end_time).date()))

    def _run(spec: dict) -> dict:
        signal = pred
        applied = {}
        floor = spec.get("liquidity_floor_adv")
        if floor:
            bad = {str(s).upper() for s in insts if adv.get(str(s).upper(), 0.0) < floor}
            if bad:
                inst_lev = signal.index.get_level_values(1).astype(str).str.upper()
                signal = signal[~inst_lev.isin(bad)]
                applied["dropped_liquidity"] = sorted(bad)
        eff = risk_degree
        if spec.get("size_cap_pct"):
            eff = min(eff, spec["size_cap_pct"] * topk / 100.0)
        if spec.get("concentration_cap_pct"):
            eff = min(eff, spec["concentration_cap_pct"] / 100.0)
        strategy = TopkDropoutStrategy(
            signal=signal, topk=topk, n_drop=n_drop, only_tradable=True, risk_degree=eff,
        )
        report, _positions = backtest_daily(
            start_time=start_time, end_time=end_time, strategy=strategy, account=account,
            benchmark=benchmark or None,
            exchange_kwargs={
                "codes": codes, "deal_price": "$close", "freq": "day",
                "open_cost": open_cost, "close_cost": close_cost, "min_cost": min_cost,
            },
        )
        risk = risk_analysis(report["return"], freq="day")
        r = {str(k): float(v) for k, v in risk.iloc[:, 0].items()}
        return {"risk": r, "applied": applied}

    def _sharpe(r: dict) -> float:
        return r.get("information_ratio") or r.get("sharpe_of_daily_return") or 0.0

    cand = parse_limits(risk_limits)
    rows = []
    runs = {}

    base = _run({})
    runs["baseline"] = base
    rows.append({"label": "baseline (no limits)", **{k: round(v, 6) for k, v in base["risk"].items()}})

    if cand:
        ab = _run(cand)
        runs["candidate"] = ab
        rows.append({"label": f"candidate {json.dumps(cand)}", **{k: round(v, 6) for k, v in ab["risk"].items()}})

        grid = []
        if cand.get("size_cap_pct"):
            for pct in (5, 10, 15, 20):
                spec = dict(cand, size_cap_pct=float(pct))
                grid.append((f"size_cap {pct}%", spec))
        if cand.get("concentration_cap_pct"):
            for pct in (20, 30, 40, 50):
                spec = dict(cand, concentration_cap_pct=float(pct))
                grid.append((f"conc {pct}%", spec))
        if cand.get("liquidity_floor_adv"):
            for floor in (1e6, 2.5e6, 5e6, 1e7):
                spec = dict(cand, liquidity_floor_adv=float(floor))
                grid.append((f"liquidity ${floor:,.0f}", spec))
        for label, spec in grid:
            r = _run(spec)
            runs[label] = r
            rows.append({"label": label, **{k: round(v, 6) for k, v in r["risk"].items()}})

    rows.sort(key=lambda row: -_sharpe(row))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "risk_calibration.json", "w") as fh:
        json.dump({"rows": rows, "runs": runs, "candidate": cand}, fh, indent=2, default=str)

    headline = {k: _sharpe(r["risk"]) for k, r in runs.items()}
    best = max(headline, key=headline.get) if headline else None
    return {
        "start_time": start_time,
        "end_time": end_time,
        "trading_days": None,
        "best_by_sharpe": best,
        "sharpes": {k: round(v, 4) for k, v in headline.items()},
        "comparison": rows,
        "artifacts": [str(out / "risk_calibration.json")],
    }


@server.tool(structured_output=False)
def rd_strategy_targets(
    pred_path: str,
    signal_date: str = "",
    account: float = 1000000.0,
    risk_degree: float = 0.95,
    topk: int = 2,
    n_drop: int = 1,
    prices: str = "",
    risk_limits: str = "",
    equity: float = 0.0,
    peak_equity: float = 0.0,
) -> dict:
    """Turn a saved prediction into a deterministic target order list for one signal date, applying the same TopkDropout selection the backtest uses: rank the cross-sectional scores, drop the top n_drop, take the next topk as buys, sized at account * risk_degree / topk per name. With `prices` (JSON {symbol: price}) also floors to whole shares (qty) and reports expected_price. risk_limits: JSON (liquidity_floor_adv, size_cap_pct, concentration_cap_pct, drawdown_pause_pct) applied as pre-gates — same spec rd_backtest uses. equity/peak_equity enable the drawdown_pause gate (equity <= (1-pause_pct) * peak -> no buys). Chains straight into tac-engine place_order — no manual strategy replication. signal_date defaults to the last day in the prediction."""
    pred = pd.read_pickle(pred_path)
    if isinstance(pred, pd.DataFrame):
        col = "score" if "score" in pred.columns else pred.columns[0]
        scores_all = pred[col]
    else:
        scores_all = pred
    scores_all = scores_all.sort_index()
    dates = sorted(pd.Index(scores_all.index.get_level_values(0)).unique())
    if not dates:
        raise ValueError("prediction is empty — no signal dates")

    target_date = pd.Timestamp(signal_date) if signal_date else dates[-1]
    if target_date in dates:
        resolved = target_date
        note = None
    else:
        past = [d for d in dates if d <= target_date]
        resolved = past[-1] if past else dates[0]
        note = f"requested {target_date.date()} not in prediction; using {pd.Timestamp(resolved).date()}"

    day = scores_all.loc[resolved]
    day = day[day.notna()]

    ranking = day.sort_values(ascending=False)

    # ---- risk limits: drawdown pause gate, liquidity filter, sizing caps ----
    limits = parse_limits(risk_limits)
    limits_applied = {}
    if limits:
        from tac_qlib.risk_limits import apply_to_ranking, dollar_adv, drawdown_pause

        paused, pause_reason = drawdown_pause(equity, peak_equity, limits)
        if paused:
            return {
                "signal_date": str(pd.Timestamp(resolved).date()),
                "strategy": "TopkDropout",
                "reason": f"drawdown_pause: {pause_reason} — no targets",
                "risk_limits_applied": {"drawdown_pause_pct": limits["drawdown_pause_pct"], "paused": True},
                "targets": [],
                "ranking": [
                    {"symbol": s, "rank": i + 1, "score": round(float(v), 6)}
                    for i, (s, v) in enumerate(ranking.head(20).items())
                ],
            }

        floor = limits.get("liquidity_floor_adv")
        if floor:
            insts = [str(s) for s in ranking.index]
            adv = dollar_adv(insts, _default_lake(), "US", asof=str(pd.Timestamp(resolved).date()), lookback=20)
            ranking, applied = apply_to_ranking(ranking, adv, limits, account, risk_degree, topk)
        else:
            ranking, applied = apply_to_ranking(ranking, {}, limits, account, risk_degree, topk)
        limits_applied.update(applied)

    order = ranking.nlargest(topk + n_drop)
    if len(order) < topk + n_drop:
        return {
            "signal_date": str(pd.Timestamp(resolved).date()),
            "strategy": "TopkDropout",
            "reason": f"only {len(order)} names with a score on {pd.Timestamp(resolved).date()} (need {topk + n_drop}) — no targets",
            "targets": [],
            "risk_limits_applied": limits_applied or None,
            "ranking": [
                {"symbol": s, "rank": i + 1, "score": round(float(v), 6)}
                for i, (s, v) in enumerate(ranking.head(20).items())
            ],
        }
    targets = order.iloc[n_drop:]

    per_name_notional = round(limits_applied.get("per_name_notional", account * risk_degree / topk), 2)
    price_map = {}
    if prices:
        import json

        price_map = json.loads(prices)
    out_targets = []
    for symbol, score in targets.items():
        item = {
            "symbol": str(symbol),
            "rank": int(ranking.index.get_loc(symbol)) + 1,
            "score": round(float(score), 6),
            "side": "buy",
            "notional": per_name_notional,
        }
        price = price_map.get(str(symbol))
        if price:
            qty = int(per_name_notional // float(price))
            item["qty"] = qty
            item["expected_price"] = float(price)
            item["invested"] = round(qty * float(price), 2)
        out_targets.append(item)

    return {
        "signal_date": str(pd.Timestamp(resolved).date()),
        "date_note": note,
        "strategy": "TopkDropout",
        "topk": topk,
        "n_drop": n_drop,
        "risk_degree": risk_degree,
        "account": round(account, 2),
        "per_name_notional": per_name_notional,
        "risk_limits_applied": limits_applied or None,
        "count": len(out_targets),
        "targets": out_targets,
        "ranking": [
            {"symbol": s, "rank": i + 1, "score": round(float(v), 6)}
            for i, (s, v) in enumerate(ranking.head(20).items())
        ],
    }


def _spawn_subprocess_workflow(config_path: str, experiment_name: str, uri_folder: str = "") -> dict:
    """Run a workflow in a fresh process, redirecting its stdout/stderr to a log file.

    ``qlib.init`` sets process-global ``C``/``R`` singletons, so concurrent
    in-process background workflow threads would race. A subprocess gets a clean
    qlib, survives crashes, and releases memory when it exits. Because this
    server speaks MCP over stdio, the child MUST NOT inherit this process's
    stdout — everything it prints is diverted to ``<lake>/logs/rd-workflow-<exp>-<ts>.log``.

    The child writes to the same mlflow tracking store (Postgres or the lake
    sqlite), so the parent's ``rd_exp_*`` pollers see the run as it progresses.
    """
    from tac_qlib.data.config import resolve_lake_root

    cp = Path(config_path).expanduser().resolve()
    if not cp.exists():
        raise ValueError(f"config not found: {cp}")

    lake = resolve_lake_root(None)
    log_dir = lake / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", experiment_name or "workflow")[:64]
    log_path = log_dir / f"rd-workflow-{safe}-{_dt.datetime.now():%Y%m%d-%H%M%S}.log"

    cmd = [sys.executable, "-m", "tac_qlib.rd_server", "--child-workflow", str(cp), experiment_name]
    if uri_folder:
        cmd.append(uri_folder)

    with open(log_path, "ab") as logf:
        proc = subprocess.Popen(
            cmd,
            stdout=logf,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            # Own session (setsid): decouples the workflow from the MCP client's
            # process group so aborting a chat tool call / disconnecting a client
            # cannot SIGKILL a long training run mid-flight.
            start_new_session=True,
        )
    return {
        "status": "started",
        "background": True,
        "process_mode": "subprocess",
        "pid": proc.pid,
        "config_path": str(cp),
        "experiment_name": experiment_name,
        "log_path": str(log_path),
        "note": ("workflow running in a separate process — poll rd_exp_get_run / rd_exp_list for the "
                 "newest run of this experiment (status RUNNING until it finishes), then reuse its run_id. "
                 f"Child logs: {log_path}"),
    }


def _prepare_submitted_workflow(config_yaml: str, experiment_name: str = "") -> tuple[str, dict]:
    """Validate declarative YAML and stage its normalized form in a private lake temp dir."""
    from tac_qlib.data.config import resolve_lake_root
    from tac_qlib.workflows.rd_workflow_yaml import prepare_rd_workflow_yaml

    lake = resolve_lake_root(None).resolve()
    _config, summary, normalized_yaml = prepare_rd_workflow_yaml(
        config_yaml,
        lake_root=str(lake),
        expected_experiment_name=experiment_name or None,
    )
    staging = lake / ".rd-workflow-tmp"
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    if staging.is_symlink() or staging.resolve() != staging:
        raise RuntimeError("R&D workflow staging directory must remain inside the configured lake")
    try:
        os.chmod(staging, 0o700)
    except OSError:
        pass
    fd, staged_path = tempfile.mkstemp(prefix="rd-workflow-user-", suffix=".yaml", dir=staging)
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            os.chmod(staged_path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(normalized_yaml)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(staged_path).unlink(missing_ok=True)
        raise
    return staged_path, summary


def _cleanup_submitted_workflow(config_path: str) -> None:
    """Delete only files created by _prepare_submitted_workflow."""
    try:
        from tac_qlib.data.config import resolve_lake_root
        path = Path(config_path).absolute()
        expected = resolve_lake_root(None).resolve() / ".rd-workflow-tmp"
        if not expected.is_symlink() and path.parent == expected and path.name.startswith("rd-workflow-user-") and path.suffix == ".yaml" and not path.is_symlink():
            path.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001 - cleanup must not mask a workflow result
        pass


@server.tool(structured_output=False)
def rd_validate_workflow(config_yaml: str) -> dict:
    """Validate bounded workflow YAML and preflight its lake data without creating a run."""
    try:
        from tac_qlib.data.config import resolve_lake_root
        from tac_qlib.workflows.rd_workflow_yaml import prepare_rd_workflow_yaml

        lake = str(resolve_lake_root(None).resolve())
        runtime_cfg, summary, _normalized = prepare_rd_workflow_yaml(
            config_yaml, lake_root=lake
        )
        task = runtime_cfg["task"]
        handler = task["dataset"]["kwargs"]["handler"]["kwargs"]
        segments = task["dataset"]["kwargs"]["segments"]
        data = rd_dataset(
            lake_root=lake,
            market=handler["market"],
            universe=handler["instruments"],
            start_time=handler["start_time"],
            end_time=handler["end_time"],
            fit_start_time=handler["fit_start_time"],
            fit_end_time=handler["fit_end_time"],
            freq=handler["freq"],
            features=handler["feature_fields"],
            label=handler["label"],
            train_start=segments["train"][0],
            train_end=segments["train"][1],
            valid_start=segments["valid"][0],
            valid_end=segments["valid"][1],
            test_start=segments["test"][0],
            test_end=segments["test"][1],
        )
        summary["dataset_preflight"] = {
            "universe_size": data["universe_size"],
            "universe": data["universe"],
            "segments": data["segments"],
            "feature_fields": data["feature_fields"],
            "all_nan_dropped": data["all_nan_dropped"],
        }
        return {"valid": True, **summary}
    except Exception as exc:
        logging.getLogger(__name__).exception("rd_validate_workflow preflight failed")
        if isinstance(exc, (ValueError, RuntimeError)):
            detail = str(exc).strip() or type(exc).__name__
            detail = re.sub(r"([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", detail, flags=re.IGNORECASE)
            detail = re.sub(r"(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+", r"\1=[REDACTED]", detail, flags=re.IGNORECASE)
            message = f"Workflow validation or persisted-lake preflight failed: {detail}"
        elif isinstance(exc, (FileNotFoundError, PermissionError)):
            message = "Could not read required data from the configured lake. Check its path and requested symbol/date/feature coverage."
        elif isinstance(exc, (IndexError, KeyError)):
            message = "The configured lake does not appear to cover the requested symbols or date segments. Check its calendar, bars, and features."
        else:
            message = f"Unexpected {type(exc).__name__} during R&D preflight. Check the R&D service log for details."
        raise ToolError(message) from exc


@server.tool(structured_output=False)
def rd_run_workflow(config_path: str = "", experiment_name: str = "", uri_folder: str = "", wait: bool = False, run_in_new_process: bool = False, config_yaml: str = "") -> dict:
    """Execute a full qrun workflow yaml in one shot (render jinja -> init qlib from its qlib_init -> train model -> run all records: SignalRecord, SigAnaRecord, PortAnaRecord). Returns run info, mlflow metrics and saved artifact list. Equivalent to: qrun <config> --experiment_name <name>.

    A 4-year training run can outlive the MCP call timeout, so `wait` defaults to False: the workflow runs in a background thread and the tool returns immediately with `status: started`. Poll rd_exp_get_run / rd_exp_list for the newest run of `experiment_name` (status RUNNING until it finishes), then reuse its run_id. Set wait=True only for small windows that finish within the call timeout.

    `run_in_new_process=true` runs the workflow in a separate OS process (stdout/stderr redirected to <lake>/logs/rd-workflow-<exp>-<ts>.log, returned as `log_path`). qlib init sets process-global state, so use this for concurrent or long workflows — it isolates crashes and releases memory, and the same rd_exp_* polling works because the child writes to the same mlflow store."""
    if config_yaml:
        if config_path or uri_folder or wait or run_in_new_process:
            raise ValueError("submitted YAML runs accept only config_yaml and experiment_name; execution mode is service-owned")
        staged_path, summary = _prepare_submitted_workflow(config_yaml, experiment_name)
        try:
            result = _spawn_subprocess_workflow(staged_path, summary["experiment_name"])
        except Exception:
            _cleanup_submitted_workflow(staged_path)
            raise
        # Paths are deliberately omitted from the renderer-facing response.
        return {
            "status": result.get("status", "started"),
            "background": True,
            "process_mode": "subprocess",
            "experiment_name": summary["experiment_name"],
            "config_sha256": summary["config_sha256"],
            "determinism_profile": summary["determinism_profile"],
            "seed": summary["seed"],
            "note": "workflow submitted to an isolated Qlib worker; poll rd_exp_get_run or rd_exp_list for its persisted run",
        }
    if not config_path:
        raise ValueError("config_path or config_yaml is required")
    if run_in_new_process:
        return _spawn_subprocess_workflow(config_path, experiment_name, uri_folder)
    kwargs = {"config_path": config_path, "experiment_name": experiment_name, "uri_folder": uri_folder}
    if wait:
        return _rd_run_workflow_impl(**kwargs)
    threading.Thread(target=_rd_run_workflow_impl, kwargs=kwargs, daemon=True).start()
    return {
        "status": "started",
        "background": True,
        "config_path": config_path,
        "experiment_name": experiment_name,
        "note": ("workflow running in the background — poll rd_exp_get_run / rd_exp_list for the "
                 "newest run of this experiment (status RUNNING until it finishes), then reuse its run_id"),
    }


def _workflow_preflight_problems(cfg_path: str) -> list[str]:
    """Pre-flight validation for child workflows; tolerant of plain installs.

    A missing ``tac_qlib.workflows`` package (older/plain site-packages copies
    without the workflows dir) must only SKIP structural validation, never
    refuse to run: refusal here happens before MLflow creates any run, which
    made deployed servers silently produce nothing. Broken installs that fail
    with anything other than ImportError still fail loudly, and real validator
    findings (or a crash while validating a parseable config) still refuse.
    """
    try:
        from tac_qlib.workflows.validate_workflow import validate as _validate_wf
    except ImportError as _imp_exc:
        print(
            f"[rd_server] WARNING: pre-flight validator unavailable ({_imp_exc!r}); "
            "skipping structural validation",
            flush=True,
        )
        return []
    try:
        return list(_validate_wf(Path(cfg_path)))
    except Exception as _exc:  # noqa: BLE001 - validator crash must not silently pass
        return [f"pre-flight validator crashed: {_exc!r}"]


def _rd_run_workflow_impl(config_path: str, experiment_name: str = "workflow", uri_folder: str = "") -> dict:
    cp = Path(config_path).expanduser()
    if not cp.exists():
        raise ValueError(f"config not found: {cp}")

    import qlib
    from qlib.cli.run import render_template, sys_config
    from qlib.config import C
    from qlib.model.trainer import task_train
    from ruamel.yaml import YAML

    # Make the resolved lake root visible to workflow YAML jinja (`{{ LAKE }}`,
    # set from `TAC_LAKE_DIR`): qlib's render_template only substitutes env vars,
    # so pin TAC_LAKE_DIR to the same lake the server resolves, regardless of
    # the process cwd.
    from tac_qlib.data.config import resolve_lake_root

    os.environ.setdefault("TAC_LAKE_DIR", str(resolve_lake_root(None)))

    rendered = render_template(str(cp))
    cfg = YAML(typ="safe", pure=True).load(rendered)
    from tac_qlib.workflows.rd_workflow_yaml import workflow_fingerprint
    config_sha256 = workflow_fingerprint(cfg)
    model_cfg = ((cfg.get("task") or {}).get("model") or {})
    model_kwargs = model_cfg.get("kwargs") or {}
    deterministic_profile = "lightgbm-seeded-single-thread-v1" if model_cfg.get("class") in {"LGBModel", "RankICLGBModel"} and model_kwargs.get("num_threads") == 1 else "workflow-config-only"
    sys_config(cfg, str(cp))
    cfg["rd_reproducibility"] = {
        "config_sha256": config_sha256,
        "determinism_profile": deterministic_profile,
        "seed": model_kwargs.get("seed"),
    }

    qlib_init_cfg = cfg.get("qlib_init", {}) or {}
    from tac_qlib.data.config import resolve_lake_root

    lake_root = resolve_lake_root(None)
    unified = _default_mlruns_uri()
    use_postgres = unified.startswith("postgresql+psycopg://")
    if "exp_manager" in qlib_init_cfg:
        # DATABASE_URL set -> the unified store is Postgres and the trace FK
        # references its `runs` table: never let a workflow pin sqlite/file.
        # Without DATABASE_URL, normalize a relative `sqlite:///mlruns.db` (and
        # the lake's own `sqlite:///{{ LAKE }}/mlruns.db`, rendered to
        # `sqlite:////<lake>/mlruns.db`) to the unified store; other absolute /
        # `file:` / `http(s)` uris are left untouched.
        em_kwargs = qlib_init_cfg["exp_manager"].setdefault("kwargs", {})
        if use_postgres:
            em_kwargs["uri"] = unified
        else:
            em_uri = (em_kwargs.get("uri") or "").strip()
            lake_mlruns_sqlite = f"sqlite:///{lake_root}/mlruns.db"
            if em_uri.startswith("sqlite:///") and (
                not em_uri.startswith("sqlite:////") or em_uri.startswith(lake_mlruns_sqlite)
            ):
                em_kwargs["uri"] = unified
        qlib.init(**qlib_init_cfg)
        exp_manager = qlib_init_cfg["exp_manager"]
    else:
        exp_manager = C["exp_manager"]
        if use_postgres:
            exp_manager["kwargs"]["uri"] = unified
        else:
            uri_dir = Path(uri_folder).expanduser() if uri_folder else lake_root / "mlruns"
            exp_manager["kwargs"]["uri"] = "file:" + str(uri_dir.resolve())
        qlib.init(**qlib_init_cfg, exp_manager=exp_manager)

    task = cfg.get("task", {}) or {}
    _pin_artifact_location(exp_manager["kwargs"]["uri"], experiment_name)
    recorder = task_train(task, experiment_name=experiment_name)
    artifact_cfg = copy.deepcopy(cfg)
    artifact_manager = ((artifact_cfg.get("qlib_init") or {}).get("exp_manager") or {})
    artifact_manager_kwargs = artifact_manager.get("kwargs") or {}
    if "uri" in artifact_manager_kwargs:
        artifact_manager_kwargs["uri"] = "<host-managed>"
    recorder.save_objects(config=artifact_cfg)
    try:
        recorder.set_tags(**{
            "rd.experiment_id": str(getattr(recorder, "experiment_id", "")),
            "rd.run_id": str(recorder.id),
            "rd.config_sha256": config_sha256,
            "rd.determinism_profile": deterministic_profile,
            "rd.seed": str(model_kwargs.get("seed", "")),
        })
    except Exception:  # noqa: BLE001 - tags are best-effort
        pass

    info = dict(recorder.info)
    metrics = {k: (float(v) if not isinstance(v, dict) else None) for k, v in recorder.list_metrics().items()}

    artifacts = []
    try:
        artifacts = [fi.path for fi in recorder.client.list_artifacts(recorder.id)]
    except Exception:
        pass

    return {
        "config_path": str(cp),
        "config_sha256": config_sha256,
        "determinism_profile": deterministic_profile,
        "experiment_name": experiment_name,
        "run_id": info.get("id"),
        "status": info.get("status"),
        "qlib_init": _jsonable({**qlib_init_cfg, "exp_manager": {**(qlib_init_cfg.get("exp_manager") or {}), "kwargs": {**((qlib_init_cfg.get("exp_manager") or {}).get("kwargs") or {}), "uri": "<host-managed>"}}}),
        "model": _jsonable(task.get("model")),
        "dataset": _jsonable(task.get("dataset")),
        "records": _jsonable(task.get("record")),
        "metrics": metrics,
        "artifacts": artifacts,
    }


@server.tool(structured_output=False)
def rd_factor_attribution(
    start_time: str,
    end_time: str,
    portfolio_equity: str = "",
    benchmark: str = "SPY",
    lake_root: str = "",
    market: str = "US",
    risk_free: float = 0.0,
    ann_scaler: int = 252,
    realized_slippage_bps: float = 0.0,
    realized_cost_bps: float = 0.0,
    expected_slippage_bps: float = 0.0,
    expected_cost_bps: float = 0.0,
    drift_warn_bps: float = 50.0,
) -> dict:
    """Factor-based P&L attribution for a live window: decompose the account's return into beta (benchmark exposure) and alpha (residual edge), then flag drift when realized execution cost (from round_metrics) exceeds the backtest assumption (from the calibration).

    Pass the account equity curve from tac-engine `get_portfolio_history` as `portfolio_equity` — a JSON array of `{"t":<iso date>,"e":<equity>}` (or `{"date":..., "equity":...}`). Benchmark daily bars are read from the lake. Realized execution drag comes from `round_metrics` (slippage_bps + cost_pct_of_gross); the expected values are the backtest/calibration assumption. `drift_alarm` fires when realized − expected > drift_warn_bps."""
    lake_root = _ensure_init(lake_root, market)

    df = None
    if portfolio_equity:
        rows = json.loads(portfolio_equity)
        rec = []
        for r in rows:
            t = r.get("t") or r.get("date")
            e = r.get("e") or r.get("equity")
            if t is not None and e is not None:
                rec.append({"t": pd.Timestamp(t), "e": float(e)})
        if rec:
            df = pd.DataFrame(rec).assign(t=lambda x: pd.to_datetime(x["t"]).dt.normalize()).set_index("t").sort_index()
            df = df[~df.index.duplicated(keep="last")]
            df = df[(df.index >= pd.Timestamp(start_time).normalize()) & (df.index <= pd.Timestamp(end_time).normalize())]

    from tac_qlib.data.config import LakeConfig

    cfg = LakeConfig(lake_root, market)
    bench_sym = str(benchmark or "SPY").upper()
    bench_p = cfg.bar_path("1d", bench_sym)
    if not bench_p.exists():
        for candidate in ("IVV", "QQQ", "VOO", "SPY"):
            p = cfg.bar_path("1d", candidate)
            if p.exists():
                bench_sym = candidate
                bench_p = p
                break
    bench = pd.read_parquet(bench_p)
    bcol = bench["t"] if "t" in bench.columns else bench["date"]
    bench = bench.assign(_t=pd.to_datetime(bcol).dt.normalize()).set_index("_t").sort_index()
    bench = bench[(bench.index >= pd.Timestamp(start_time).normalize()) & (bench.index <= pd.Timestamp(end_time).normalize())]
    bench_ret = bench["c"].astype(float).pct_change().dropna()

    if df is None or len(df) < 2:
        return {
            "start_time": start_time,
            "end_time": end_time,
            "benchmark": bench_sym,
            "benchmark_note": f"requested {benchmark or 'SPY'}, used {bench_sym} (lake)",
            "error": "portfolio_equity missing or has <2 points — pass the get_portfolio_history equity curve as portfolio_equity",
            "benchmark_return_pct": round(float(bench_ret.sum() * 100), 4) if len(bench_ret) else None,
        }

    port_ret = df["e"].pct_change().dropna()
    joined = pd.concat([port_ret.rename("port"), bench_ret.rename("bench")], axis=1, join="inner").dropna()
    if len(joined) < 3:
        return {
            "start_time": start_time,
            "end_time": end_time,
            "benchmark": bench_sym,
            "benchmark_note": f"requested {benchmark or 'SPY'}, used {bench_sym} (lake)",
            "error": f"only {len(joined)} overlapping return days with benchmark — need >=3",
            "benchmark_return_pct": round(float(bench_ret.sum() * 100), 4) if len(bench_ret) else None,
        }

    p = joined["port"]
    b = joined["bench"]
    beta = float(np.cov(p, b)[0, 1] / np.var(b))
    ann_port = (1 + p.mean()) ** ann_scaler - 1
    ann_bench = (1 + b.mean()) ** ann_scaler - 1
    alpha_ann = ann_port - risk_free - beta * (ann_bench - risk_free)

    equity0 = float(df["e"].iloc[0])
    equity1 = float(df["e"].iloc[-1])
    pnl = equity1 - equity0
    pnl_beta = beta * (equity1 / equity0 - 1) * equity0
    pnl_alpha = pnl - pnl_beta

    realized_bps = None
    drift_alarm = None
    realized = realized_slippage_bps + realized_cost_bps
    expected = expected_slippage_bps + expected_cost_bps
    if realized > 0 or expected > 0:
        realized_bps = round(realized, 2)
        if realized > expected + drift_warn_bps:
            drift_alarm = (
                f"drift: realized cost {realized:.1f} bps exceeds backtest assumption "
                f"{expected:.1f} bps by {realized - expected:.1f} bps (> {drift_warn_bps:g} bps warn) — "
                f"re-check sizing / calibration (rd_risk_calibrate)"
            )
        elif realized > expected:
            drift_alarm = (
                f"watch: realized cost {realized:.1f} bps vs backtest assumption "
                f"{expected:.1f} bps (within {drift_warn_bps:g} bps warn threshold)"
            )

    return {
        "start_time": start_time,
        "end_time": end_time,
        "benchmark": bench_sym,
        "benchmark_note": f"requested {benchmark or 'SPY'}, used {bench_sym} (lake)",
        "days": len(joined),
        "equity_start": round(equity0, 2),
        "equity_end": round(equity1, 2),
        "pnl_total": round(pnl, 2),
        "return_pct": round(float((equity1 / equity0 - 1) * 100), 4),
        "benchmark_return_pct": round(float(bench_ret.sum() * 100), 4),
        "beta": round(beta, 4),
        "alpha_annualized_pct": round(float(alpha_ann * 100), 4),
        "attribution": {
            "pnl_beta": round(pnl_beta, 2),
            "pnl_alpha": round(pnl_alpha, 2),
            "alpha_share_pct": round(float(pnl_alpha / pnl * 100), 2) if abs(pnl) > 1e-9 else None,
        },
        "realized_cost_bps": realized_bps,
        "drift_alarm": drift_alarm,
        "correlation": round(float(np.corrcoef(p, b)[0, 1]), 4),
    }


# --------------------------------------------------------------------------- entry
def main() -> None:
    import argparse
    import logging

    from tac_qlib.rd_explain import register_tools
    from tac_qlib.trace import register_trace_tools

    parser = argparse.ArgumentParser(prog="tac_qlib.rd_server", description="TradeAC quant R&D MCP server (stdio)")
    parser.add_argument(
        "--child-workflow",
        nargs="+",
        default=None,
        help=argparse.SUPPRESS,  # internal: run one workflow and exit (spawned by rd_run_workflow run_in_new_process)
    )
    args, _ = parser.parse_known_args()

    if args.child_workflow:
        # Re-exec into a dedicated transient systemd user unit: opencode (and
        # therefore this server + every child) lives inside a tmux-spawn scope
        # whose teardown SIGKILLs ALL member processes — setsid/double-fork do
        # not escape a cgroup kill. A private service unit does.
        # POSIX/systemd only; silently no-op elsewhere or on re-entry.
        if os.environ.get("TAC_RD_IN_SYSTEMD") != "1" and shutil.which("systemd-run"):
            try:
                # Real path of our redirected stdout (Popen stdout=logf), not
                # sys.stdout.name which is the literal "<stdout>" placeholder.
                try:
                    log_hint = os.readlink("/proc/self/fd/1")
                except OSError:
                    log_hint = None
                unit = f"tac-rd-wf-{re.sub(r'[^A-Za-z0-9_-]+', '_', (args.child_workflow[1] if len(args.child_workflow) > 1 else 'workflow'))[:48]}-{os.getpid()}"
                cmd = ["systemd-run", "--user", "--collect", "--quiet", f"--unit={unit}"]
                if log_hint and log_hint.startswith("/"):
                    cmd += [f"--property=StandardOutput=append:{log_hint}", f"--property=StandardError=append:{log_hint}"]
                # Pass the environment via an 0600 EnvironmentFile instead of
                # --setenv per var: secrets must never land on a command line
                # (visible in ps and in any error echo).
                fd, env_file = tempfile.mkstemp(prefix="tac-rd-env-", suffix=".conf")
                with os.fdopen(fd, "w") as ef:
                    for key, val in os.environ.items():
                        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) and "\n" not in val:
                            ef.write(f"{key}={val}\n")
                    ef.write("TAC_RD_IN_SYSTEMD=1\n")
                os.chmod(env_file, 0o600)
                try:
                    cmd.append(f"--property=EnvironmentFile={env_file}")
                    cmd += [sys.executable, "-m", "tac_qlib.rd_server", "--child-workflow"] + list(args.child_workflow)
                    proc = subprocess.run(cmd, capture_output=True, text=True)
                    if proc.returncode != 0:
                        tail = (proc.stderr or "").strip()[-300:]
                        raise RuntimeError(f"systemd-run exit {proc.returncode}: {tail}")
                    print(f"[rd_server] re-executed under systemd user unit {unit}", flush=True)
                finally:
                    os.unlink(env_file)
                return
            except Exception as exc:  # noqa: BLE001 - fall through to direct run
                print(f"[rd_server] systemd-run re-exec failed ({exc}); running directly", flush=True)
        # Detach into our own session/process group ASAP: the MCP client (or a
        # chat tool abort) signals whole process groups, which used to SIGKILL
        # long training runs mid-flight. POSIX only; ignore on other platforms.
        try:
            os.setsid()
        except Exception:  # noqa: BLE001 - already a session leader / non-POSIX
            pass
        # Double-fork (direct-spawn mode ONLY): reparents to init so PPID-tree
        # sweeps can't reach us. Under our own systemd unit this must NOT run —
        # the middle process's immediate exit would make systemd tear down the
        # whole unit cgroup, killing the training grandchild.
        if os.environ.get("TAC_RD_IN_SYSTEMD") != "1":
            try:
                if os.fork() > 0:
                    sys.exit(0)
            except OSError:  # noqa: BLE001 - non-POSIX / fork restricted
                pass
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
        logging.getLogger("lightgbm").setLevel(logging.WARNING)
        logging.getLogger("mlflow").setLevel(logging.WARNING)
        os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
        cfg = args.child_workflow[0]
        name = args.child_workflow[1] if len(args.child_workflow) > 1 else "workflow"
        uri = args.child_workflow[2] if len(args.child_workflow) > 2 else ""
        print(f"[rd_server] child-workflow: {cfg} experiment={name} uri_folder={uri!r}", flush=True)
        try:
            from tac_qlib.data.config import resolve_lake_root as _resolve_lake_root

            os.environ.setdefault("TAC_LAKE_DIR", str(_resolve_lake_root(None)))
        except Exception:  # noqa: BLE001 - env pinning is best-effort; validator tolerates raw {{ LAKE }}
            pass
        try:
            _problems = _workflow_preflight_problems(cfg)
            if _problems:
                print("[rd_server] workflow config FAILED pre-flight validation; refusing to run:", flush=True)
                for _p in _problems:
                    print(f"  - {_p}", flush=True)
                sys.exit(2)
            _rd_run_workflow_impl(config_path=cfg, experiment_name=name, uri_folder=uri)
        except Exception:  # noqa: BLE001 - log the traceback (stderr -> the parent's log file) and fail loudly
            import traceback

            traceback.print_exc()
            sys.exit(1)
        finally:
            _cleanup_submitted_workflow(cfg)
        return

    register_tools(server)
    register_trace_tools(server)
    logging.getLogger("qlib").setLevel(logging.WARNING)
    logging.getLogger("lightgbm").setLevel(logging.WARNING)
    logging.getLogger("mlflow").setLevel(logging.WARNING)
    os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
