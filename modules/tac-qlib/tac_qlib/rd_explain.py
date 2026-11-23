"""TradeAC R&D explain — read mlruns experiments/runs/artifacts for the R&D UI.

This module adds the ``rd_exp_*`` MCP tool category (experiments list, per-run input config,
metrics/evaluation, model + LightGBM tree dumps, hypothesis/evaluation notes) to the
tac-qlib rd_server.

All tools are pure readers over the local MLflow **sqlite** store + artifact files:

    mlruns.db  -> experiments / runs / tags / params / metrics / latest_metrics
    mlruns/<experiment_id>/<run_uuid>/artifacts/  -> config, params.pkl, pred.pkl, label.pkl,
        sig_analysis/{ic,ric,long_short_r,long_avg_r}.pkl,
        portfolio_analysis/{report,port_analysis,indicators}_*.pkl

Artifacts are Python pickles (pandas / qlib / lightgbm objects), so this module is
deliberately Python-side (see kb/guide/rd-explain.md for the architecture rationale).
"""

from __future__ import annotations

import datetime as _dt
import math
import json
import pickle
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

DEFAULT_URI = ""
DEFAULT_DEPTH = 5
DEFAULT_MAX_NODES = 256


def _default_tracking_uri() -> str:
    """Default MLflow tracking URI: Postgres ($DATABASE_URL) or lake sqlite.

    With ``$DATABASE_URL`` set the store is MLflow's Postgres backend (its own
    ``experiments``/``runs``/... tables); artifacts live under ``<lake>/mlruns``.
    Without it, the legacy unified lake sqlite store
    ``sqlite:///<lake>/mlruns.db`` is used. ``MLRUNS_URI`` overrides.
    """
    import os

    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    try:
        from tac_qlib.data.config import resolve_lake_root

        return f"sqlite:///{resolve_lake_root(None)}/mlruns.db"
    except Exception:  # noqa: BLE001 - fall back to the legacy repo-root store
        print(
            "[rd_explain] WARNING: DATABASE_URL not set — reading the lake sqlite tracking store. "
            "Traced runs live in Postgres when DATABASE_URL is set.",
            file=sys.stderr,
        )
        return "sqlite:///mlruns.db"


# --------------------------------------------------------------------------- tracking store
class _TrackingStore:
    """Dialect-agnostic MLflow tracking store (sqlite or postgres).

    Exposes ``execute(sql, params)`` returning a cursor-like object with
    ``fetchall()``/``fetchone()`` so the rest of this module's queries are
    unchanged; ``?`` placeholders are translated to ``%s`` for postgres.
    """

    def __init__(self, conn, *, pg: bool, uri: str, db: str, art_root: Path):
        self._conn = conn
        self.pg = pg
        self.uri = uri
        self.db = db
        self.art_root = art_root

    def execute(self, sql: str, params=()):
        if self.pg:
            cur = self._conn.cursor()
            cur.execute(sql.replace("?", "%s"), tuple(params))
            return cur
        return self._conn.execute(sql, params)

    def close(self) -> None:
        if self.pg:
            self._conn.commit()
            self._conn.close()
        else:
            self._conn.close()


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


def _postgres_art_root() -> Path:
    """Artifact root for the postgres store: ``<lake>/mlruns`` (files stay local)."""
    try:
        from tac_qlib.data.config import resolve_lake_root

        return resolve_lake_root(None) / "mlruns"
    except Exception:  # noqa: BLE001
        return Path.cwd() / "mlruns"


def _sqlite_paths(uri: str) -> Tuple[Path, Path]:
    """Resolve (db_path, artifact_root) from a sqlite MLflow uri."""
    if uri.startswith("sqlite:///"):
        db = Path(uri[len("sqlite:///") :])
    elif uri.startswith("sqlite://"):
        db = Path(uri[len("sqlite://") :])
    else:
        db = Path(uri)
    db = db.expanduser()
    if not db.is_absolute():
        db = Path.cwd() / db
    return db, db.parent / "mlruns"


def _open_store(uri: str) -> _TrackingStore:
    """Open a tracking store for an MLflow uri (postgres or sqlite)."""
    uri = (uri or _default_tracking_uri()).strip()
    if uri.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
        import psycopg

        conn = psycopg.connect(_postgres_dsn(uri))
        return _TrackingStore(conn, pg=True, uri=uri, db=uri, art_root=_postgres_art_root())

    db, art_root = _sqlite_paths(uri)
    if not db.exists():
        raise FileNotFoundError(f"mlruns sqlite db not found: {db}")
    conn = sqlite3.connect(db)
    return _TrackingStore(conn, pg=False, uri=uri, db=str(db), art_root=art_root)


def _rows(store: _TrackingStore, sql: str, params=()) -> List[tuple]:
    return store.execute(sql, params).fetchall()


def _run_artifact_root(art_root: Path, exp_id, run_id: str) -> Path:
    # MLflow records artifact_uri in runs; fall back to the standard layout.
    return art_root / str(exp_id) / run_id / "artifacts"


def _artifact_root_for_run(store: _TrackingStore, exp_id, run_id: str) -> Path:
    """Resolve the mlflow artifact root (the ``mlruns`` dir) for a specific run.

    The authoritative source is the run's recorded ``artifact_uri`` (e.g.
    ``<mlruns_root>/<exp>/<run>/artifacts``). Prefer the recorded location when it
    matches the ``<root>/<exp>/<run>/artifacts`` layout; otherwise fall back to
    the store's ``art_root``.
    """
    art_root = store.art_root
    meta = _run_meta(store, run_id) or {}
    uri = (meta.get("artifact_uri") or "").strip()
    if uri.startswith("file://"):
        uri = uri[len("file://") :]
    p = Path(uri).expanduser()
    if p.name == "artifacts" and p.parent.name == str(run_id):
        # strip <exp>/<run>/artifacts -> mlruns root; only trust it if the
        # run artifact dir actually exists there (mlflow may have written it
        # under a different cwd, and files can be moved after the fact).
        recorded_root = p.parent.parent.parent
        if (recorded_root / str(exp_id) / str(run_id) / "artifacts").exists():
            return recorded_root
    return art_root


# --------------------------------------------------------------------------- json utils
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


# --------------------------------------------------------------------------- tracking store

def _list_artifact_files(root: Path, prefix: str = "") -> List[dict]:
    if not root.exists():
        return []
    out = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out.append(
                {
                    "path": str(p.relative_to(root)) if prefix else p.name,
                    "size": p.stat().st_size,
                }
            )
    return out


def _load_pickle(path: Path) -> Tuple[Any, Optional[str]]:
    """Unpickle a qlib/mlflow artifact. Returns (object, error)."""
    try:
        with open(path, "rb") as fh:
            return pickle.load(fh), None
    except Exception as exc:  # noqa: BLE001 - surface any unpickling failure as a warning
        return None, f"unpickle {path.name}: {exc}"


def _load_series(path: Path) -> Optional[pd.Series]:
    obj, err = _load_pickle(path)
    if err:
        return None
    if isinstance(obj, pd.Series):
        return obj
    if isinstance(obj, pd.DataFrame) and obj.shape[1] >= 1:
        return obj.iloc[:, 0]
    return None


def _date_of(ts: Any) -> str:
    return str(pd.Timestamp(ts).date())


# --------------------------------------------------------------------------- db helpers
def _experiment_row(conn: _TrackingStore, experiment_id) -> Optional[dict]:
    rows = _rows(
        conn,
        "SELECT experiment_id, name, artifact_location, lifecycle_stage, creation_time, "
        "last_update_time FROM experiments WHERE experiment_id = ?",
        (int(experiment_id),),
    )
    if not rows:
        return None
    r = rows[0]
    return {
        "experiment_id": r[0],
        "name": r[1],
        "artifact_location": r[2],
        "lifecycle_stage": r[3],
        "creation_time": r[4],
        "last_update_time": r[5],
    }


def _run_meta(conn: _TrackingStore, run_id: str) -> Optional[dict]:
    rows = _rows(
        conn,
        "SELECT run_uuid, name, source_type, source_name, status, start_time, end_time, "
        "source_version, lifecycle_stage, artifact_uri, experiment_id FROM runs WHERE run_uuid = ?",
        (run_id,),
    )
    if not rows:
        return None
    r = rows[0]
    return {
        "run_id": r[0],
        "name": r[1],
        "source_type": r[2],
        "source_name": r[3],
        "status": r[4],
        "start_time": r[5],
        "end_time": r[6],
        "git_commit": r[7],
        "lifecycle_stage": r[8],
        "artifact_uri": r[9],
        "experiment_id": r[10],
    }


def _tags_of(conn: _TrackingStore, run_id: str) -> Dict[str, str]:
    return {k: v for k, v in _rows(conn, "SELECT key, value FROM tags WHERE run_uuid = ?", (run_id,))}


def _params_of(conn: _TrackingStore, run_id: str) -> Dict[str, str]:
    return {k: v for k, v in _rows(conn, "SELECT key, value FROM params WHERE run_uuid = ?", (run_id,))}


def _latest_metrics_of(conn: _TrackingStore, run_id: str) -> Dict[str, Any]:
    rows = _rows(
        conn,
        "SELECT key, value FROM latest_metrics WHERE run_uuid = ? ORDER BY key",
        (run_id,),
    )
    return {k: v for k, v in rows}


def _step_metrics_of(conn: _TrackingStore, run_id: str) -> Dict[str, list]:
    rows = _rows(
        conn,
        "SELECT key, value, step, timestamp FROM metrics WHERE run_uuid = ? ORDER BY key, step",
        (run_id,),
    )
    out: Dict[str, list] = {}
    for k, v, step, ts in rows:
        out.setdefault(k, []).append({"step": step, "value": v, "timestamp": ts})
    return out


def _headline(metrics: Dict[str, Any]) -> Dict[str, Any]:
    return {k: metrics[k] for k in ("IC", "ICIR", "Rank IC", "Rank ICIR") if k in metrics}


_EXCESS_RETURN_KEYS = (
    "1day.excess_return_with_cost.annualized_return",
    "1day.annualized_return",
    "annualized_return",
)


def _excess_return(metrics: Dict[str, Any]) -> Optional[float]:
    for k in _EXCESS_RETURN_KEYS:
        v = metrics.get(k)
        if isinstance(v, (int, float)) and math.isfinite(v):
            return float(v)
    return None


def _max_drawdown(metrics: Dict[str, Any]) -> Optional[float]:
    for k in ("1day.excess_return_with_cost.max_drawdown", "1day.max_drawdown", "max_drawdown"):
        v = metrics.get(k)
        if isinstance(v, (int, float)) and math.isfinite(v):
            return float(v)
    return None


def _full_headline(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """IC/ICIR/RankIC/RankICIR plus AnnReturn and MaxDD for the best-run summary."""
    h: Dict[str, Any] = {}
    for k in ("IC", "ICIR", "Rank IC", "Rank ICIR"):
        if k in metrics:
            h[k] = metrics[k]
    ann = _excess_return(metrics)
    if ann is not None:
        h["AnnReturn"] = ann
    dd = _max_drawdown(metrics)
    if dd is not None:
        h["MaxDD"] = dd
    return h


# --------------------------------------------------------------------------- notes
def _notes_path(art_root: Path, exp_id, run_id: str) -> Path:
    return art_root / str(exp_id) / run_id / "rd-notes.json"


def _load_notes(art_root: Path, exp_id, run_id: str) -> dict:
    p = _notes_path(art_root, exp_id, run_id)
    if not p.exists():
        return {"hypothesis": "", "evaluation": "", "updated_at": None}
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return {"hypothesis": "", "evaluation": "", "updated_at": None}


# --------------------------------------------------------------------------- input config
def _resolve_universe_from_config(hkw: Dict[str, Any], qlib_init: Dict[str, Any]) -> Tuple[List[str], str]:
    """Resolve ``instruments`` ("all"/list) to concrete symbols when the lake is available."""
    instruments = hkw.get("instruments")
    if isinstance(instruments, list):
        return [str(s).upper() for s in instruments], "explicit"
    if instruments not in (None, "all", "ALL"):
        return [str(s).strip().upper() for s in str(instruments).split(",") if str(s).strip()], "explicit"
    lake_root = hkw.get("lake_root") or (qlib_init or {}).get("provider_uri")
    market = str(hkw.get("market") or (qlib_init or {}).get("region") or "US").upper()
    try:
        from tac_qlib.data.config import LakeConfig

        symbols = LakeConfig(lake_root, market).load_symbols()
        return symbols, "lake"
    except Exception as exc:  # noqa: BLE001
        return [], f"unresolved ({exc})"


def _feature_fields_from_config(hkw: Dict[str, Any]) -> List[str]:
    freq = hkw.get("freq", "day")
    features = hkw.get("feature_fields") or hkw.get("features")
    try:
        from tac_qlib.contrib.data.handler import TACHandler
        from tac_qlib.data.config import resolve_lake_root

        return TACHandler._normalize_feature_fields(features, freq, str(resolve_lake_root(None)), "US")
    except Exception:  # noqa: BLE001 - feature list normalization needs the lake for defaults
        if isinstance(features, list):
            return list(features)
        if isinstance(features, str):
            return [f.strip() for f in features.split(",") if f.strip()]
        return []


def _workflow_yaml_from_config(config: dict) -> str:
    """Serialize a saved config as cloneable YAML without host-owned settings."""
    from io import StringIO
    from ruamel.yaml import YAML

    workflow_config = _jsonable(config)
    workflow_config.pop("qlib_init", None)
    workflow_config.pop("rd_reproducibility", None)
    handler_kwargs = (
        (((workflow_config.get("task") or {}).get("dataset") or {}).get("kwargs") or {})
        .get("handler", {})
        .get("kwargs", {})
    )
    if isinstance(handler_kwargs, dict):
        handler_kwargs.pop("lake_root", None)

    yaml_buffer = StringIO()
    yaml_writer = YAML(typ="safe", pure=True)
    yaml_writer.default_flow_style = False
    yaml_writer.dump(workflow_config, yaml_buffer)
    return yaml_buffer.getvalue()


def _run_input(art_root: Path, exp_id, run_id: str) -> dict:
    root = _run_artifact_root(art_root, exp_id, run_id)
    config = None
    err = None
    if (root / "config").exists():
        config, err = _load_pickle(root / "config")
    elif (root / "config.json").exists():
        try:
            config = json.loads((root / "config.json").read_text())
        except Exception as exc:  # noqa: BLE001
            err = f"config.json: {exc}"
    if config is None:
        out: Dict[str, Any] = {
            "source": "partial" if err else "reconstructed",
            "warning": err or "no `config` artifact recorded on this run; input is not fully recoverable",
            "config": None,
        }
        # Best-effort model settings recovered from the saved fitted model.
        model, _ = _load_model(art_root, exp_id, run_id)
        if model is not None:
            out["model"] = {
                "class": type(model).__name__,
                "module_path": None,
                "kwargs": _jsonable(_model_params(model)),
            }
        return out

    task = config.get("task", {}) or {}
    model = task.get("model", {}) or {}
    dataset = task.get("dataset", {}) or {}
    dkw = dataset.get("kwargs", {}) or {}
    handler = dkw.get("handler", {}) or {}
    hkw = handler.get("kwargs", {}) or {}
    qlib_init = config.get("qlib_init", {}) or {}

    universe, universe_source = _resolve_universe_from_config(hkw, qlib_init)
    features = _feature_fields_from_config(hkw)

    return {
        "source": "config-artifact",
        "config": _jsonable(config),
        "config_yaml": _workflow_yaml_from_config(config),
        "qlib_init": _jsonable(qlib_init),
        "model": _jsonable(model),
        "dataset": {
            "class": dataset.get("class"),
            "module_path": dataset.get("module_path"),
            "handler": _jsonable(handler),
            "handler_kwargs": _jsonable(hkw),
            "segments": _jsonable(dkw.get("segments")),
            "features": features,
            "label": hkw.get("label"),
            "universe": universe,
            "universe_size": len(universe),
            "universe_source": universe_source,
        },
        "record": _jsonable(task.get("record")),
    }


# --------------------------------------------------------------------------- result / eval
def _ic_series(art_root: Path, exp_id, run_id: str, pred=None, label=None) -> Tuple[List[dict], Optional[str]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    ic = _load_series(root / "sig_analysis" / "ic.pkl")
    ric = _load_series(root / "sig_analysis" / "ric.pkl")
    if ic is None:
        ic = _load_series(root / "ic.pkl")
    if ric is None:
        ric = _load_series(root / "ric.pkl")
    if ic is not None and ric is not None:
        out = []
        for ts, i in ic.items():
            out.append({"date": _date_of(ts), "ic": _jsonable(float(i)), "ric": _jsonable(float(ric.get(ts, np.nan)))})
        return out, None
    # Fallback: compute per-day IC/Rank IC from pred/label.
    if pred is None or label is None:
        return [], "ic.pkl / ric.pkl missing and pred/label unavailable to recompute"
    try:
        from qlib.contrib.eva.alpha import calc_ic

        i2, r2 = calc_ic(pred, label, dropna=True)
        out = []
        for ts, i in i2.items():
            out.append({"date": _date_of(ts), "ic": _jsonable(float(i)), "ric": _jsonable(float(r2.get(ts, np.nan)))})
        return out, None
    except Exception as exc:  # noqa: BLE001
        return [], f"failed to recompute IC: {exc}"


def _group_analysis(pred, label, n_groups: int = 5) -> Tuple[List[dict], Optional[pd.Series], Optional[pd.Series]]:
    """Quantile-group return analysis, mirroring qlib ``analysis_model._group_return``.

    Sorts the cross-section by prediction each day, splits into ``n_groups`` blocks and
    averages the label inside each block. Returns (cumulative per-group series incl.
    long-short / long-average, per-day long-short, per-day long-average).
    """
    if pred is None or label is None:
        return [], None, None
    try:
        df = pd.concat([pred.rename("score"), label.rename("label")], axis=1).dropna(subset=["score", "label"])
    except Exception:  # noqa: BLE001 - best-effort analysis
        return [], None, None
    if df.empty or df.index.nlevels < 2:
        return [], None, None
    df = df.sort_values("score", ascending=False)
    per_day: Dict[str, pd.Series] = {}
    for grp in range(1, n_groups + 1):
        per_day[f"Group{grp}"] = df.groupby(level=0, group_keys=False)["label"].apply(
            lambda x, g=grp: x.iloc[len(x) // n_groups * (g - 1) : len(x) // n_groups * g].mean()
        )
    all_mean = df.groupby(level=0)["label"].mean()
    per_day["long-short"] = per_day["Group1"] - per_day[f"Group{n_groups}"]
    per_day["long-average"] = per_day["Group1"] - all_mean

    groups: List[dict] = []
    for key, s in per_day.items():
        cum = s.cumsum().dropna()
        groups.append(
            {
                "key": key,
                "label": "Long-Short" if key == "long-short" else "Long-Average" if key == "long-average" else f"Group {key[5:]}",
                "points": [{"date": _date_of(ts), "value": _jsonable(float(v))} for ts, v in cum.items()],
            }
        )
    return groups, per_day["long-short"].dropna(), per_day["long-average"].dropna()


def _histogram(s, n_bins: int = 20) -> List[dict]:
    """Simple bin counts for a value series -> [{bin, count}]."""
    s = pd.Series(s).dropna()
    if len(s) < 2 or s.nunique() < 2:
        return []
    counts, edges = np.histogram(s.to_numpy(), bins=n_bins)
    return [
        {"bin": float((edges[i] + edges[i + 1]) / 2), "count": int(c)}
        for i, c in enumerate(counts)
        if c > 0
    ]


def _group_returns(art_root: Path, exp_id, run_id: str, pred=None, label=None) -> Tuple[dict, Optional[str]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    ls = _load_series(root / "sig_analysis" / "long_short_r.pkl")
    la = _load_series(root / "sig_analysis" / "long_avg_r.pkl")
    if ls is None:
        ls = _load_series(root / "long_short_r.pkl")
    if la is None:
        la = _load_series(root / "long_avg_r.pkl")

    groups, ls_daily, la_daily = _group_analysis(pred, label)
    distribution = {
        "long_short": _histogram(ls_daily),
        "long_average": _histogram(la_daily),
    }

    # Per-day long-short / long-average (frontend cumsums them); prefer the recorded
    # artifacts and fall back to the on-the-fly computation from pred/label.
    ls_pts = [{"date": _date_of(ts), "value": _jsonable(float(v))} for ts, v in ls.items()] if ls is not None else []
    la_pts = [{"date": _date_of(ts), "value": _jsonable(float(v))} for ts, v in la.items()] if la is not None else []
    if not ls_pts and ls_daily is not None:
        ls_pts = [{"date": _date_of(ts), "value": _jsonable(float(v))} for ts, v in ls_daily.items()]
    if not la_pts and la_daily is not None:
        la_pts = [{"date": _date_of(ts), "value": _jsonable(float(v))} for ts, v in la_daily.items()]

    warn = None
    if ls is None and la is None and (pred is None or label is None):
        warn = "long_short_r.pkl / long_avg_r.pkl missing and pred/label unavailable to recompute"
    return {
        "long_short": ls_pts,
        "long_avg": la_pts,
        "groups": groups,
        "distribution": distribution,
    }, warn


def _monthly_ic(ic_series: List[dict]) -> List[dict]:
    """Aggregate the daily IC / Rank IC series into a year x month grid."""
    rows: Dict[str, Dict[str, list]] = {}
    for p in ic_series:
        ym = p["date"][:7]
        row = rows.setdefault(ym, {"ic": [], "ric": []})
        if p.get("ic") is not None:
            row["ic"].append(p["ic"])
        if p.get("ric") is not None:
            row["ric"].append(p["ric"])
    out = []
    for ym in sorted(rows):
        r = rows[ym]
        out.append(
            {
                "month": ym,
                "year": int(ym[:4]),
                "month_of_year": int(ym[5:7]),
                "ic": round(float(np.mean(r["ic"])), 4) if r["ic"] else None,
                "ric": round(float(np.mean(r["ric"])), 4) if r["ric"] else None,
            }
        )
    return out


def _ic_histogram(ic_series: List[dict]) -> dict:
    ic = [p["ic"] for p in ic_series if p.get("ic") is not None]
    ric = [p["ric"] for p in ic_series if p.get("ric") is not None]
    return {"ic": _histogram(pd.Series(ic)), "ric": _histogram(pd.Series(ric))}


def _autocorrelation(pred) -> List[dict]:
    """Per-day rank autocorrelation of the prediction (lag 1), mirroring qlib ``_pred_autocorr``."""
    if pred is None:
        return []
    s = pred.dropna()
    if s.empty or s.index.nlevels < 2:
        return []
    df = s.to_frame("score")
    df["score_last"] = df.groupby(level=1, group_keys=False)["score"].shift(1)
    ac = df.groupby(level=0, group_keys=False).apply(
        lambda x: x["score"].rank(pct=True).corr(x["score_last"].rank(pct=True))
    )
    out = []
    for ts, v in ac.items():
        if v is not None and np.isfinite(v):
            out.append({"date": _date_of(ts), "value": _jsonable(float(v))})
    return out


def _explanation(headline: Dict[str, Any], risk: Dict[str, Any], ic_series: List[dict]) -> List[str]:
    """Auto-generated findings interpreting the headline / risk metrics and daily IC."""
    lines: List[str] = []
    ic = headline.get("IC")
    icir = headline.get("ICIR")
    if ic is not None:
        icir_txt = f" (ICIR {icir:+.2f})" if icir is not None else ""
        lines.append(f"Average daily IC {ic:+.4f}{icir_txt} across the test window.")
        if icir is not None:
            if abs(icir) >= 0.5:
                lines.append("ICIR above 0.5 in magnitude — the signal's predictive power is unlikely to be pure luck.")
            elif abs(icir) >= 0.2:
                lines.append("ICIR in the 0.2–0.5 range — weak but persistent predictive power.")
            else:
                lines.append("ICIR below 0.2 in magnitude — the signal is barely distinguishable from noise.")
    if ic_series:
        valid = [p["ic"] for p in ic_series if p.get("ic") is not None]
        if valid:
            pos = sum(1 for v in valid if v > 0) / len(valid)
            lines.append(f"IC was positive on {pos * 100:.0f}% of days ({len(valid)} days).")
    ann = risk.get("annualized_return") or risk.get("1day.annualized_return")
    mdd = risk.get("max_drawdown") or risk.get("1day.max_drawdown")
    sharpe = risk.get("information_ratio") or risk.get("1day.information_ratio")
    if ann is not None:
        lines.append(f"Backtest annualized return {ann * 100:+.1f}% with max drawdown {mdd * 100:.1f}%." if mdd is not None else f"Backtest annualized return {ann * 100:+.1f}%.")
        if sharpe is not None:
            lines.append(f"Information ratio (Sharpe) {sharpe:.2f}.")
    return lines


def _flatten_risk(df: pd.DataFrame) -> Dict[str, Any]:
    """Normalize a risk-analysis DataFrame to flat metric keys.

    qlib's ``port_analysis_*.pkl`` rows may carry a MultiIndex like
    ``(excess_return_with_cost, annualized_return)``. We emit both prefixed keys
    (``excess_return_with_cost.annualized_return``) and, for the preferred
    ``excess_return_with_cost`` analysis, bare metric names so the UI and the
    explanation generator can read ``annualized_return`` / ``max_drawdown`` /
    ``information_ratio`` directly.
    """
    col = df.columns[0]
    out: Dict[str, Any] = {}
    for idx, row in df.iterrows():
        val = row[col]
        try:
            val = _jsonable(float(val))
        except (TypeError, ValueError):  # noqa: S110 - non-numeric rows are skipped
            continue
        if isinstance(idx, tuple):
            analysis, metric = idx
            out[f"{analysis}.{metric}"] = val
            if analysis == "excess_return_with_cost" and metric not in out:
                out[metric] = val
        else:
            out[str(idx)] = val
    return out


def _backtest(art_root: Path, exp_id, run_id: str) -> Tuple[List[dict], Dict[str, Any], Optional[str], Optional[str], Dict[str, Any]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    warn = None
    report = None
    for cand in (
        "portfolio_analysis/report_normal_1day.pkl",
        "portfolio_analysis/report_normal_1d.pkl",
        "report_normal_1day.pkl",
        "report_normal_1d.pkl",
    ):
        p = root / cand
        if p.exists():
            obj, err = _load_pickle(p)
            if err:
                warn = err
            elif isinstance(obj, pd.DataFrame) and len(obj):
                report = obj
            break

    pts: List[dict] = []
    has_bench = False
    ann: Dict[str, Any] = {}
    if report is not None:
        cum = report["return"].fillna(0).cumsum()
        bench = report["bench"].fillna(0).cumsum() if "bench" in report.columns else None
        has_bench = bench is not None and bool(report["bench"].abs().sum())
        # qlib annualizes day-frequency returns with the 238 scaler (see
        # qlib.contrib.evaluate.risk_analysis, sum mode): mean * 238.
        ann["return_annualized"] = _jsonable(float(report["return"].fillna(0).mean() * 238))
        ann["benchmark_annualized"] = _jsonable(float(report["bench"].fillna(0).mean() * 238)) if has_bench else None
        for idx, r in report.iterrows():
            rec = {"date": _date_of(idx), "return": _jsonable(float(r.get("return", 0)))}
            rec["cum_return"] = _jsonable(float(cum.loc[idx]))
            if bench is not None:
                rec["cum_benchmark"] = _jsonable(float(bench.loc[idx]))
            pts.append(rec)

    risk: Dict[str, Any] = {}
    for cand in (
        "portfolio_analysis/port_analysis_1day.pkl",
        "portfolio_analysis/port_analysis_1d.pkl",
        "port_analysis_1day.pkl",
        "port_analysis_1d.pkl",
    ):
        p = root / cand
        if p.exists():
            obj, _ = _load_pickle(p)
            if isinstance(obj, pd.DataFrame) and len(obj):
                risk = _flatten_risk(obj)
                break
    if not risk and report is not None:
        try:
            from qlib.contrib.evaluate import risk_analysis

            ra = risk_analysis(report["return"], freq="day")
            risk = {str(k): _jsonable(float(v)) for k, v in ra.iloc[:, 0].items()}
        except Exception as exc:  # noqa: BLE001
            warn = (warn + "; " if warn else "") + f"risk_analysis failed: {exc}"

    benchmark = _backtest_benchmark(art_root, exp_id, run_id)
    if not benchmark and not has_bench:
        benchmark = None
    return pts, risk, warn, benchmark, ann


def _pred_stats(art_root: Path, exp_id, run_id: str) -> Tuple[Optional[dict], Optional[str]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    pred = _load_series(root / "pred.pkl")
    if pred is None:
        return None, "pred.pkl missing"
    s = pred.dropna()
    insts = sorted(s.index.get_level_values(1).dropna().astype(str).unique()) if s.index.nlevels > 1 else []
    return {
        "count": int(len(s)),
        "date_min": _date_of(s.index.get_level_values(0).min()),
        "date_max": _date_of(s.index.get_level_values(0).max()),
        "instruments": insts,
        "instrument_count": len(insts),
        "mean": round(float(s.mean()), 6),
        "std": round(float(s.std(ddof=1)), 6) if len(s) > 1 else None,
        "min": round(float(s.min()), 6),
        "max": round(float(s.max()), 6),
    }, None


def _strategy_kwargs(art_root: Path, exp_id, run_id: str) -> dict:
    """Recover the PortAnaRecord strategy kwargs (topk, n_drop, benchmark) from the saved config."""
    root = _run_artifact_root(art_root, exp_id, run_id)
    config, _ = _load_pickle(root / "config") if (root / "config").exists() else (None, None)
    if not config:
        return {}
    try:
        for rec in config.get("task", {}).get("record", []) or []:
            if str(rec.get("class", "")).endswith("PortAnaRecord"):
                strategy = ((rec.get("kwargs", {}) or {}).get("config", {}) or {}).get("strategy", {}) or {}
                return dict(strategy.get("kwargs", {}) or {})
    except Exception:  # noqa: BLE001 - best-effort recovery
        pass
    return {}


def _blotter_topk(art_root: Path, exp_id, run_id: str, default: int = 2) -> int:
    """Recover the strategy ``topk`` from the recorded config (PortAnaRecord)."""
    topk = _strategy_kwargs(art_root, exp_id, run_id).get("topk")
    return int(topk) if topk else default


def _backtest_benchmark(art_root: Path, exp_id, run_id: str) -> Optional[str]:
    """Best-effort benchmark symbol from the recorded config (may be empty for legacy runs)."""
    bm = (_strategy_kwargs(art_root, exp_id, run_id).get("benchmark") or "").strip()
    return bm or None


def _order_trades(root: Path) -> Tuple[List[dict], Optional[str]]:
    """Extract per-day per-symbol executed trades from the OrderIndicator artifact.

    ``indicators_*_obj.pkl`` holds the qlib ``OrderIndicator`` whose history maps
    each trading day to per-symbol series: amount (signed shares), deal price,
    trade value, trade cost and trade direction (1 buy / 0 sell).
    """
    cands = (
        "portfolio_analysis/indicators_normal_1day_obj.pkl",
        "portfolio_analysis/indicators_1day_obj.pkl",
        "portfolio_analysis/indicators_normal_1day.pkl",
        "indicators_normal_1day_obj.pkl",
        "indicators_1day_obj.pkl",
    )
    io = None
    for cand in cands:
        p = root / cand
        if p.exists():
            obj, err = _load_pickle(p)
            if err:
                return [], err
            if obj is not None and hasattr(obj, "order_indicator_his"):
                io = obj
                break
    if io is None:
        return [], "order/trade indicator artifact missing (no backtest trades recorded)"

    def _to_series(sd):
        try:
            return pd.Series(sd.data, index=list(sd.index))
        except Exception:  # noqa: BLE001 - qlib SingleData -> pandas
            return pd.Series(dtype=float)

    trades: List[dict] = []
    for ts, v in io.order_indicator_his.items():
        d = getattr(v, "data", v)
        if not isinstance(d, dict):
            continue
        amt = _to_series(d.get("amount"))
        if not len(amt):
            continue
        price = _to_series(d.get("trade_price"))
        value = _to_series(d.get("trade_value"))
        cost = _to_series(d.get("trade_cost"))
        tdir = _to_series(d.get("trade_dir"))
        for sym in amt.index:
            a = float(amt[sym])
            if abs(a) < 1e-9:
                continue
            trades.append(
                {
                    "date": _date_of(ts),
                    "symbol": str(sym),
                    "side": "BUY" if float(tdir.get(sym, 1)) >= 0.5 else "SELL",
                    "amount": a,
                    "price": _jsonable(float(price.get(sym, np.nan))),
                    "value": _jsonable(float(value.get(sym, np.nan))),
                    "cost": _jsonable(float(cost.get(sym, np.nan))),
                }
            )
    trades.sort(key=lambda t: (t["date"], t["symbol"]))
    return trades, None


def _fifo_trade_pnl(trades: List[dict]) -> Tuple[float, float]:
    """FIFO tax-lot accounting for trade-level P&L.

    Every BUY opens a lot (with its leading signal). Every SELL consumes the
    oldest open lots first (FIFO): realized P&L = sell proceeds minus the
    matched lots' all-in cost basis, and the trade inherits the entry date,
    entry price and the leading signal of the matched lot(s). Returns
    (realized_pnl, unrealized_pnl).
    """
    lots: Dict[str, List[dict]] = {}
    realized_total = 0.0
    for t in trades:
        sym = t["symbol"]
        t.setdefault("signal_score", None)
        t.setdefault("signal_rank", None)
        t["entry_date"] = None
        t["entry_price"] = None
        t["entry_score"] = None
        t["realized_pnl"] = None
        if t["side"] == "BUY":
            amount = float(t["amount"])
            if amount <= 0:
                continue
            unit_cost = (float(t["value"] or 0) + float(t["cost"] or 0)) / amount
            lots.setdefault(sym, []).append(
                {"qty": amount, "unit_cost": unit_cost, "date": t["date"], "score": t["signal_score"]}
            )
        else:
            qty_sell = -float(t["amount"])
            proceeds = -float(t["value"] or 0) - float(t["cost"] or 0)
            open_lots = lots.setdefault(sym, [])
            remaining = qty_sell
            basis = 0.0
            matched = []
            while remaining > 1e-9 and open_lots:
                lot = open_lots[0]
                take = min(remaining, lot["qty"])
                basis += take * lot["unit_cost"]
                matched.append((take, lot))
                lot["qty"] -= take
                remaining -= take
                if lot["qty"] < 1e-9:
                    open_lots.pop(0)
            realized = proceeds - basis
            realized_total += realized
            t["realized_pnl"] = round(realized, 6)
            t["entry_date"] = matched[0][1]["date"] if matched else None
            t["entry_score"] = matched[0][1]["score"] if matched else None
            if matched and qty_sell > 0:
                t["entry_price"] = round(sum(take * lot["unit_cost"] for take, lot in matched) / qty_sell, 6)

    unrealized_total = 0.0
    return realized_total, unrealized_total


def _blotter(art_root: Path, exp_id, run_id: str) -> Tuple[dict, List[str]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    warnings: List[str] = []

    report = None
    for cand in (
        "portfolio_analysis/report_normal_1day.pkl",
        "portfolio_analysis/report_1day.pkl",
        "report_normal_1day.pkl",
        "report_1day.pkl",
    ):
        p = root / cand
        if p.exists():
            obj, err = _load_pickle(p)
            if err:
                warnings.append(err)
            elif isinstance(obj, pd.DataFrame) and len(obj):
                report = obj
            break

    positions: Optional[dict] = None
    for cand in (
        "portfolio_analysis/positions_normal_1day.pkl",
        "portfolio_analysis/positions_1day.pkl",
        "positions_normal_1day.pkl",
        "positions_1day.pkl",
    ):
        p = root / cand
        if p.exists():
            obj, err = _load_pickle(p)
            if err:
                warnings.append(err)
            elif isinstance(obj, dict) and len(obj):
                positions = obj
            break

    trades, trade_warn = _order_trades(root)
    if trade_warn:
        warnings.append(trade_warn)

    pred = _load_series(root / "pred.pkl")
    topk = _blotter_topk(art_root, exp_id, run_id)

    signal_map: Dict[Tuple[str, str], float] = {}
    signal_rank_map: Dict[Tuple[str, str], int] = {}
    signal_rows: List[dict] = []
    if pred is not None and pred.index.nlevels >= 2:
        df = pred.to_frame("score").dropna()
        df = df.reset_index()
        df.columns = ["date", "symbol", "score"][: df.shape[1]]
        df["date"] = df["date"].map(_date_of)
        df["rank"] = df.groupby("date")["score"].rank(ascending=False, method="first").astype(int)
        traded_dates = {(t["date"], t["symbol"]) for t in trades}
        for _, r in df.iterrows():
            key = (str(r["date"]), str(r["symbol"]))
            score = float(r["score"])
            rank = int(r["rank"])
            signal_map[key] = score
            signal_rank_map[key] = rank
            signal_rows.append(
                {
                    "date": str(r["date"]),
                    "symbol": str(r["symbol"]),
                    "score": round(score, 6),
                    "rank": rank,
                    "selected": rank <= topk,
                    "traded": key in traded_dates,
                }
            )
    elif pred is None:
        warnings.append("pred.pkl missing; signal blotter unavailable")

    for t in trades:
        key = (t["date"], t["symbol"])
        t["signal_score"] = signal_map.get(key)
        t["signal_rank"] = signal_rank_map.get(key)
    _fifo_trade_pnl(trades)

    # Daily report series + P&L
    daily: List[dict] = []
    initial_account = None
    final_account = None
    if report is not None:
        prev = None
        for idx, row in report.iterrows():
            acc = float(row.get("account", np.nan))
            if initial_account is None and not np.isnan(acc):
                initial_account = acc
            pnl_day = acc - prev if prev is not None else 0.0
            prev = acc
            daily.append(
                {
                    "date": _date_of(idx),
                    "account": round(acc, 6) if not np.isnan(acc) else None,
                    "value": _jsonable(float(row.get("value", np.nan))),
                    "cash": _jsonable(float(row.get("cash", np.nan))),
                    "return": _jsonable(float(row.get("return", np.nan))),
                    "cost_ratio": _jsonable(float(row.get("cost", np.nan))),
                    "pnl_day": round(pnl_day, 6),
                }
            )
        if daily:
            final_account = daily[-1]["account"]

    # Final position snapshot + position history
    position_history: List[dict] = []
    current: List[dict] = []
    final_prices: Dict[str, float] = {}
    if positions is not None:
        for ts, pos in positions.items():
            pos_d = getattr(pos, "position", {}) or {}
            for sym, info in pos_d.items():
                if sym in ("cash", "now_account_value"):
                    continue
                if not isinstance(info, dict):
                    continue
                amount = float(info.get("amount", 0))
                if abs(amount) < 1e-9:
                    continue
                price = _jsonable(float(info.get("price", np.nan)))
                position_history.append(
                    {"date": _date_of(ts), "symbol": str(sym), "amount": round(amount, 6), "price": price}
                )
                final_prices[str(sym)] = float(info.get("price", np.nan)) if info.get("price") is not None else np.nan
        position_history.sort(key=lambda r: (r["date"], r["symbol"]))

    # FIFO open-lot ledger -> per-symbol avg cost, unrealized P&L, entry signal.
    unrealized_by_symbol: Dict[str, float] = {}
    avg_cost_by_symbol: Dict[str, float] = {}
    position_entry_by_symbol: Dict[str, Optional[str]] = {}
    first_score_by_symbol: Dict[str, Optional[float]] = {}
    realized_by_symbol: Dict[str, float] = {}
    if trades:
        lots: Dict[str, List[dict]] = {}
        for t in trades:
            sym = t["symbol"]
            if t["side"] == "BUY" and float(t["amount"]) > 0:
                amount = float(t["amount"])
                unit_cost = (float(t["value"] or 0) + float(t["cost"] or 0)) / amount
                lots.setdefault(sym, []).append(
                    {"qty": amount, "unit_cost": unit_cost, "date": t["date"], "score": t["signal_score"]}
                )
            elif t["side"] == "SELL":
                open_lots = lots.setdefault(sym, [])
                remaining = -float(t["amount"])
                while remaining > 1e-9 and open_lots:
                    lot = open_lots[0]
                    take = min(remaining, lot["qty"])
                    lot["qty"] -= take
                    remaining -= take
                    if lot["qty"] < 1e-9:
                        open_lots.pop(0)
        for sym, open_lots in lots.items():
            price = final_prices.get(sym, np.nan)
            qty = sum(lot["qty"] for lot in open_lots)
            if qty > 1e-9:
                basis = sum(lot["qty"] * lot["unit_cost"] for lot in open_lots)
                avg_cost_by_symbol[sym] = basis / qty
                position_entry_by_symbol[sym] = open_lots[0]["date"]
                first_score_by_symbol[sym] = open_lots[0]["score"]
                if np.isfinite(price):
                    unrealized_by_symbol[sym] = sum(
                        lot["qty"] * (price - lot["unit_cost"]) for lot in open_lots
                    )

    realized_by_symbol: Dict[str, float] = {}
    for t in trades:
        if t["side"] == "SELL" and t["realized_pnl"] is not None:
            realized_by_symbol[t["symbol"]] = realized_by_symbol.get(t["symbol"], 0.0) + t["realized_pnl"]

    if positions:
        last_pos = getattr(list(positions.values())[-1], "position", {}) or {}
        for sym, info in last_pos.items():
            if sym in ("cash", "now_account_value") or not isinstance(info, dict):
                continue
            amount = float(info.get("amount", 0))
            if abs(amount) < 1e-9:
                continue
            price = float(info.get("price", np.nan)) if info.get("price") is not None else np.nan
            weight = float(info.get("weight", 0)) if info.get("weight") is not None else np.nan
            days_held = int(info.get("count_day", 0)) if info.get("count_day") is not None else 0
            current.append(
                {
                    "symbol": str(sym),
                    "amount": round(amount, 6),
                    "price": round(price, 6) if np.isfinite(price) else None,
                    "value": round(amount * price, 2) if np.isfinite(price) else None,
                    "weight": round(weight, 4) if np.isfinite(weight) else None,
                    "days_held": days_held,
                    "avg_cost": round(avg_cost_by_symbol.get(sym, np.nan), 6)
                    if sym in avg_cost_by_symbol
                    else None,
                    "position_entry_date": position_entry_by_symbol.get(sym),
                    "entry_score": round(first_score_by_symbol[sym], 6)
                    if first_score_by_symbol.get(sym) is not None
                    else None,
                    "realized_pnl": round(realized_by_symbol.get(sym, 0.0), 2),
                    "unrealized_pnl": round(unrealized_by_symbol.get(sym, 0.0), 2),
                }
            )

    realized_total = round(sum(realized_by_symbol.values()), 2)
    unrealized_total = round(sum(unrealized_by_symbol.values()), 2)

    summary: Dict[str, Any] = {
        "initial_account": round(initial_account, 2) if initial_account is not None else None,
        "final_account": round(final_account, 2) if final_account is not None else None,
        "pnl_inception": round(final_account - initial_account, 2)
        if initial_account is not None and final_account is not None
        else None,
        "realized_pnl": realized_total,
        "unrealized_pnl": unrealized_total,
        "total_cost": round(sum(float(t.get("cost") or 0.0) for t in trades), 2),
        "trading_days": len(daily),
        "topk": topk,
        "n_trades": len(trades),
        "n_buys": sum(1 for t in trades if t["side"] == "BUY"),
        "n_sells": sum(1 for t in trades if t["side"] == "SELL"),
    }

    return {
        "summary": summary,
        "daily": daily,
        "positions": current,
        "position_history": position_history,
        "trades": trades,
        "signals": signal_rows,
        "warnings": warnings,
    }, warnings


# --------------------------------------------------------------------------- model / tree
def _load_model(art_root: Path, exp_id, run_id: str) -> Tuple[Any, Optional[str]]:
    root = _run_artifact_root(art_root, exp_id, run_id)
    p = root / "params.pkl"
    if not p.exists():
        return None, "params.pkl missing"
    return _load_pickle(p)


def _model_params(model: Any) -> Dict[str, Any]:
    """Best-effort training params recovered from a saved fitted model."""
    try:
        params = dict(model.params)
    except Exception:  # noqa: BLE001 - params are best-effort
        params = {}
    if not params:
        booster = getattr(model, "model", None)
        if booster is None:
            # Ensemble: sub-models carry `.params`; recover from the first one.
            subs = getattr(model, "_models", None) or []
            if subs:
                try:
                    params = dict(subs[0].params)
                except Exception:  # noqa: BLE001
                    params = {}
        if not params and booster is not None:
            try:
                params = dict(booster.params)
            except Exception:  # noqa: BLE001 - params are best-effort
                params = {}
    return params


_COLUMN_NAME = re.compile(r"^Column_\d+$")


def _resolve_feature_names(art_root: Path, exp_id, run_id: str, feature_names: List[str]) -> List[str]:
    """Map LightGBM's ``Column_N`` placeholders to the real handler feature fields.

    qlib trains on numpy arrays, so the booster reports ``Column_0..N``. The saved config
    artifact carries the resolved ``feature_fields``; when their order/length match the
    booster columns, substitute the real names so the tree and importances are readable.
    """
    if not feature_names or not all(_COLUMN_NAME.match(n) for n in feature_names):
        return feature_names
    root = _run_artifact_root(art_root, exp_id, run_id)
    config, _ = _load_pickle(root / "config") if (root / "config").exists() else (None, None)
    if not config:
        # Legacy runs trained before the config artifact was persisted: reconstruct the
        # handler's default feature list from the current lake (raw OHLCV + common ta-lib).
        try:
            from tac_qlib.contrib.data.handler import TACHandler
            from tac_qlib.data.config import resolve_lake_root

            real = TACHandler._normalize_feature_fields(None, "day", str(resolve_lake_root(None)), "US")
            if len(real) == len(feature_names):
                return list(real)
        except Exception:  # noqa: BLE001, S110 - best-effort reconstruction
            pass
        return feature_names
    dkw = ((config.get("task", {}) or {}).get("dataset", {}) or {}).get("kwargs", {}) or {}
    hkw = (dkw.get("handler", {}) or {}).get("kwargs", {}) or {}
    real = _feature_fields_from_config(hkw)
    if len(real) == len(feature_names):
        return list(real)
    return feature_names


def _flatten_tree(node: dict, depth: int, max_depth: int, feature_names: List[str], nodes: List[dict]) -> bool:
    """Flatten one LightGBM tree node recursively (pre-order).

    Each node gets ``id = len(nodes)`` at append time; children are appended right after
    their parent, so ``left`` is ``id+1`` and ``right`` starts where the left subtree ends.
    Returns False when the depth or node budget is hit (parent then marks that child None).
    """
    if node is None or depth > max_depth or len(nodes) >= DEFAULT_MAX_NODES:
        return False
    idx = len(nodes)
    if "leaf_value" in node:
        nodes.append(
            {
                "id": idx,
                "depth": depth,
                "leaf": True,
                "value": _jsonable(float(node.get("leaf_value", np.nan))),
                "count": int(node.get("leaf_count", 0)),
            }
        )
        return True
    sf = node.get("split_feature")
    feat = feature_names[sf] if isinstance(sf, int) and sf < len(feature_names) else str(sf)
    nodes.append(
        {
            "id": idx,
            "depth": depth,
            "leaf": False,
            "feature": feat,
            "threshold": _jsonable(float(node.get("threshold", np.nan))),
            "gain": _jsonable(float(node.get("split_gain", np.nan))),
            "count": int(node.get("internal_count", 0)),
        }
    )
    left_ok = _flatten_tree(node.get("left_child"), depth + 1, max_depth, feature_names, nodes)
    nodes[idx]["left"] = idx + 1 if left_ok else None
    right_start = len(nodes)
    right_ok = _flatten_tree(node.get("right_child"), depth + 1, max_depth, feature_names, nodes)
    nodes[idx]["right"] = right_start if right_ok else None
    return True


def _model_dump(art_root: Path, exp_id, run_id: str, tree_id: int, max_depth: int, seed: int = 0) -> Tuple[Optional[dict], Optional[str]]:
    model, err = _load_model(art_root, exp_id, run_id)
    if err:
        return None, err
    if model is None:
        return None, "model object missing"
    booster = getattr(model, "model", None)
    # Ensemble models (RankICEnsembleLGBModel) hold one fitted sub-model per
    # seed in `_models` with no top-level `.model` booster. Dump a specific
    # member (default seed 0) so the tree/importance view works per seed.
    sub_index = None
    if booster is None:
        subs = getattr(model, "_models", None) or []
        if subs:
            sub_index = min(int(seed), len(subs) - 1)
            booster = getattr(subs[sub_index], "model", None)
    if booster is None or not hasattr(booster, "dump_model"):
        return None, f"model type {type(model).__name__} has no LightGBM booster to dump"

    try:
        dump = booster.dump_model()
    except Exception as exc:  # noqa: BLE001
        return None, f"dump_model failed: {exc}"

    feature_names = _resolve_feature_names(art_root, exp_id, run_id, list(dump.get("feature_names") or []))
    tree_info = dump.get("tree_info") or []
    if not tree_info:
        return None, "empty tree_info"
    num_trees = len(tree_info)
    tree = tree_info[tree_id % num_trees]

    # A single tree is only weakly representative of a boosted model; expose
    # "milestone" tree ids (first / middle / best-iteration) so the UI can offer
    # quick jumps instead of defaulting to the least-informative tree 0.
    best_it = None
    for attr in ("best_iteration", "best_iter"):
        v = getattr(model, attr, None)
        if v is not None:
            best_it = int(v)
            break
    if best_it is None and sub_index is not None:
        subs = getattr(model, "_models", None) or []
        if subs:
            for attr in ("best_iteration", "best_iter"):
                v = getattr(subs[sub_index], attr, None)
                if v is not None:
                    best_it = int(v)
                    break
    best_tree_id = (best_it - 1) if best_it else (num_trees // 2)
    milestones = {
        "first": 0,
        "mid": max(0, num_trees // 2),
        "best": max(0, min(best_tree_id, num_trees - 1)),
    }

    importances = {}
    try:
        imp = booster.feature_importance(importance_type="gain")
        for i, name in enumerate(feature_names):
            importances[name] = round(float(imp[i]), 4) if i < len(imp) else 0.0
    except Exception:  # noqa: BLE001
        pass

    nodes: List[dict] = []
    _flatten_tree(tree.get("tree_structure"), 0, int(max_depth), feature_names, nodes)

    return {
        "class": type(model).__name__,
        "sub_model": sub_index,
        "seed_count": len(getattr(model, "_models", None) or []) or 1,
        "num_trees": num_trees,
        "best_iteration": best_it,
        "milestone_tree_ids": milestones,
        "feature_names": feature_names,
        "feature_importances": importances,
        "tree_id": tree_id % num_trees,
        "tree_index": tree.get("tree_index", tree_id % num_trees),
        "num_leaves": tree.get("num_leaves"),
        "truncated": len(nodes) >= DEFAULT_MAX_NODES,
        "nodes": nodes,
    }, None


# --------------------------------------------------------------------------- tools
def rd_exp_list(uri: str = "") -> dict:
    """List all MLflow experiments with run counts, latest run headline IC metrics, and best-excess-return headline."""
    resolved_uri = (uri or _default_tracking_uri()).strip()
    try:
        store = _open_store(resolved_uri)
    except FileNotFoundError as exc:
        # A new local checkout may have a valid lake directory before any
        # training has created the MLflow SQLite store. Read-only discovery
        # should render an empty state; preserve other backend failures.
        if resolved_uri.startswith("sqlite://"):
            db, _ = _sqlite_paths(resolved_uri)
            return {
                "uri": uri,
                "db": str(db),
                "experiments": [],
                "warnings": [f"R&D tracking store is not initialized yet: {exc}"],
            }
        raise
    exps = []
    for r in _rows(store, "SELECT experiment_id, name, artifact_location, lifecycle_stage, creation_time, last_update_time FROM experiments ORDER BY creation_time"):
        exp_id = r[0]
        run_count = _rows(store, "SELECT COUNT(*) FROM runs WHERE experiment_id = ?", (exp_id,))[0][0]
        latest = None
        lr = _rows(store, "SELECT run_uuid, name, status, start_time FROM runs WHERE experiment_id = ? ORDER BY start_time DESC LIMIT 1", (exp_id,))
        if lr:
            latest = {
                "run_id": lr[0][0],
                "name": lr[0][1],
                "status": lr[0][2],
                "start_time": lr[0][3],
                "headline": _headline(_latest_metrics_of(store, lr[0][0])),
            }
        # Best run by excess return across all runs in the experiment
        best_headline: Dict[str, Any] = {}
        all_runs = _rows(store, "SELECT run_uuid FROM runs WHERE experiment_id = ?", (exp_id,))
        best_val = -math.inf
        for run_row in all_runs:
            metrics = _latest_metrics_of(store, run_row[0])
            val = _excess_return(metrics)
            if val is not None and val > best_val:
                best_val = val
                best_headline = _full_headline(metrics)
        exps.append(
            {
                "experiment_id": exp_id,
                "name": r[1],
                "artifact_location": r[2],
                "lifecycle_stage": r[3],
                "creation_time": r[4],
                "last_update_time": r[5],
                "run_count": run_count,
                "latest_run": latest,
                "best_headline": best_headline,
            }
        )
    store.close()
    return {"uri": uri, "db": store.db, "experiments": _jsonable(exps)}


def rd_exp_get_experiment(experiment_id: str, uri: str = "") -> dict:
    """Return one experiment and its runs (meta, params, tags, latest metrics, notes, artifact files)."""
    store = _open_store(uri)

    exp = _experiment_row(store, experiment_id)
    if exp is None:
        raise ValueError(f"experiment_id {experiment_id!r} not found (see rd_exp_list)")
    runs = []
    for r in _rows(store, "SELECT run_uuid FROM runs WHERE experiment_id = ? ORDER BY start_time DESC", (int(experiment_id),)):
        run_id = r[0]
        meta = _run_meta(store, run_id)
        run_art_root = _artifact_root_for_run(store, int(experiment_id), run_id)
        runs.append(
            {
                "meta": meta,
                "params": _params_of(store, run_id),
                "tags": _tags_of(store, run_id),
                "metrics": _latest_metrics_of(store, run_id),
                "notes": _load_notes(run_art_root, experiment_id, run_id),
                "artifacts": _list_artifact_files(_run_artifact_root(run_art_root, experiment_id, run_id)),
            }
        )
    store.close()
    return {"experiment": _jsonable(exp), "runs": _jsonable(runs)}


def rd_exp_get_run(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """Return one run in full: meta, params, tags, per-step metrics, artifact files and notes."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    out = {
        "meta": meta,
        "params": _params_of(store, run_id),
        "tags": _tags_of(store, run_id),
        "metrics": _step_metrics_of(store, run_id),
        "metrics_latest": _latest_metrics_of(store, run_id),
        "headline": _headline(_latest_metrics_of(store, run_id)),
        "notes": _load_notes(art_root, exp_id, run_id),
        "artifacts": _list_artifact_files(_run_artifact_root(art_root, exp_id, run_id)),
    }
    store.close()
    return _jsonable(out)


def rd_exp_input(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """Return the input configuration of a run: qlib_init, model kwargs, dataset handler kwargs, segments, features, universe. Source is the saved `config` artifact (canonical) or reconstructed."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()
    out = _run_input(art_root, exp_id, run_id)
    out["run_id"] = run_id
    out["experiment_id"] = exp_id
    return _jsonable(out)


def rd_exp_dataset(run_id: str, group: str = "train", instrument: str = "", page: int = 1,
                   page_size: int = 50, sort: str = "asc", experiment_id: str = "", uri: str = "",
                   representation: str = "raw") -> dict:
    """Return a bounded page of rows from a persisted run dataset.

    The run artifact owns the configuration and lake location; callers may only
    select a validated segment, instrument, page, and date direction.
    """
    if group not in {"train", "valid", "test", "backtest"}:
        raise ValueError("group must be train, valid, test, or backtest")
    if sort not in {"asc", "desc"}:
        raise ValueError("sort must be asc or desc")
    if representation not in {"raw", "inference"}:
        raise ValueError("representation must be raw or inference")
    if not isinstance(page, int) or not 1 <= page <= 100000:
        raise ValueError("page must be between 1 and 100000")
    if not isinstance(page_size, int) or not 1 <= page_size <= 200:
        raise ValueError("page_size must be between 1 and 200")
    store = _open_store(uri)
    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()
    root = _run_artifact_root(art_root, exp_id, run_id)
    config, err = _load_pickle(root / "config") if (root / "config").exists() else (None, "config artifact missing")
    if not isinstance(config, dict):
        raise ValueError(err or "persisted run configuration is unavailable")
    task = config.get("task", {}) or {}
    dkw = ((task.get("dataset", {}) or {}).get("kwargs", {}) or {})
    hkw = dict(((dkw.get("handler", {}) or {}).get("kwargs", {}) or {}))
    qlib_cfg = config.get("qlib_init", {}) or {}
    lake_root = str(hkw.get("lake_root") or qlib_cfg.get("provider_uri") or "")
    if not lake_root:
        from tac_qlib.data.config import resolve_lake_root
        lake_root = str(resolve_lake_root(None))
    market = str(hkw.get("market") or qlib_cfg.get("region") or "US").upper()
    if str(hkw.get("freq") or "day") != "day":
        raise ValueError("only daily datasets are supported")
    instruments, universe_source = _resolve_universe_from_config(hkw, qlib_cfg)
    if not instruments:
        raise ValueError("run dataset instrument universe is unavailable")
    instruments = [str(value).upper() for value in instruments]
    selected = str(instrument or instruments[0]).upper()
    if selected not in instruments:
        raise ValueError(f"instrument {selected!r} is not in the run dataset universe")
    segments = dict(dkw.get("segments", {}) or {})
    backtest = {}
    for record in task.get("record", []) or []:
        if isinstance(record, dict) and record.get("class") == "PortAnaRecord":
            backtest = (((record.get("kwargs") or {}).get("config") or {}).get("backtest") or {})
            break
    if group == "backtest":
        start, end = backtest.get("start_time"), backtest.get("end_time")
        if not start or not end:
            raise ValueError("this run has no persisted PortAnaRecord backtest window")
        segments[group] = [start, end]
    if group not in segments:
        raise ValueError(f"dataset segment {group!r} is unavailable for this run")
    from tac_qlib.qlib_init import qlib_init
    from qlib.data.dataset import DatasetH
    from qlib.data.dataset.handler import DataHandlerLP
    from tac_qlib.contrib.data.handler import TACHandler
    qlib_init(provider_uri=lake_root, market=market)
    handler_kwargs = {key: value for key, value in hkw.items() if key not in {"instruments", "lake_root", "market"}}
    handler_kwargs.update(instruments=instruments, lake_root=lake_root, market=market)
    handler = TACHandler(**handler_kwargs)
    dataset = DatasetH(handler=handler, segments={group: tuple(segments[group])})
    # DataHandlerLP distinguishes source values (DK_R) from values after the
    # configured inference processor pipeline (DK_I). Keep that choice explicit
    # at the service boundary instead of silently presenting normalized values.
    data_key = DataHandlerLP.DK_R if representation == "raw" else DataHandlerLP.DK_I
    data = dataset.prepare(group, col_set=["feature", "label"], data_key=data_key)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = [str(col[-1]) for col in data.columns]
    data = data.reset_index()
    date_column = "datetime" if "datetime" in data.columns else "date"
    if date_column not in data.columns:
        date_column = data.columns[0]
    data["instrument"] = data["instrument"].astype(str).str.upper()
    data = data[data["instrument"] == selected].copy()
    data[date_column] = pd.to_datetime(data[date_column], errors="coerce")
    data = data.dropna(subset=[date_column]).sort_values([date_column, "instrument"], ascending=(sort == "asc"))
    feature_fields = [field for field in _feature_fields_from_config(hkw) if field in data.columns]
    columns = ["date", "instrument", *feature_fields]
    if group == "backtest":
        close = "$close" if "$close" in data.columns else "close"
        if close not in data.columns:
            raise ValueError("backtest deal_price requires $close in the run dataset")
        data["deal_price"] = data[close]
        columns.append("deal_price")
    else:
        label_columns = [column for column in data.columns if str(column).upper().startswith("LABEL")]
        if not label_columns:
            raise ValueError(f"{group} label column is unavailable")
        data["label"] = data[label_columns[0]]
        columns.append("label")
    total = len(data)
    observed_range = []
    if total:
        observed_range = [data[date_column].min().date().isoformat(), data[date_column].max().date().isoformat()]
    requested_segment = [str(segments[group][0]), str(segments[group][1])]
    start = (page - 1) * page_size
    page_data = data.iloc[start:start + page_size]
    def clean(value):
        if pd.isna(value): return None
        if isinstance(value, (np.integer, np.floating)): return value.item()
        return value
    rows = []
    for _, row in page_data.iterrows():
        item = {"date": pd.Timestamp(row[date_column]).isoformat(), "instrument": selected}
        item.update({column: clean(row[column]) for column in columns[2:]})
        rows.append(item)
    return _jsonable({"run_id": run_id, "experiment_id": exp_id, "group": group, "instrument": selected,
                      "instruments": instruments, "universe_source": universe_source, "columns": columns,
                      "rows": rows, "page": page, "page_size": page_size, "total": total,
                      "has_next": start + len(rows) < total, "sort": sort,
                      "representation": representation, "data_key": data_key,
                      "provenance": {"source": "run-config", "feature_fields": feature_fields,
                                     "requested_segment": requested_segment, "observed_range": observed_range,
                                     "segments": segments},
                      "warnings": []})


def rd_exp_result(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """Return the results of a run: headline metrics, per-day IC/Rank IC series, group returns, prediction stats, and the backtest report + risk analysis."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    latest = _latest_metrics_of(store, run_id)
    step = _step_metrics_of(store, run_id)
    store.close()

    root = _run_artifact_root(art_root, exp_id, run_id)
    pred = _load_series(root / "pred.pkl")
    label = _load_series(root / "label.pkl") if (root / "label.pkl").exists() else None

    ic_series, ic_warn = _ic_series(art_root, exp_id, run_id, pred, label)
    grp, grp_warn = _group_returns(art_root, exp_id, run_id, pred, label)
    bt_pts, risk, bt_warn, benchmark, bt_ann = _backtest(art_root, exp_id, run_id)
    pstats, p_warn = _pred_stats(art_root, exp_id, run_id)

    warnings = [w for w in (ic_warn, grp_warn, bt_warn, p_warn) if w]
    return _jsonable(
        {
            "run_id": run_id,
            "experiment_id": exp_id,
            "metrics": latest,
            "metrics_by_step": step,
            "headline": _headline(latest),
            "ic_series": ic_series,
            "ic_histogram": _ic_histogram(ic_series),
            "monthly_ic": _monthly_ic(ic_series),
            "autocorrelation": _autocorrelation(pred),
            "group_returns": grp,
            "pred_stats": pstats,
            "backtest": {
                "report": bt_pts,
                "risk": risk,
                "benchmark": benchmark,
                "return_annualized": bt_ann.get("return_annualized"),
                "benchmark_annualized": bt_ann.get("benchmark_annualized"),
            },
            "explanation": _explanation(_headline(latest), risk, ic_series),
            "warnings": warnings,
        }
    )


def rd_exp_model(run_id: str, tree_id: int = 0, max_depth: int = DEFAULT_DEPTH, seed: int = 0, experiment_id: str = "", uri: str = "") -> dict:
    """Return a run's model: hyper-parameters, feature importances, structure stats, and a pruned LightGBM decision tree for a given (seed, tree_id).

    - ``seed``: for ensemble models, which per-seed sub-model to inspect (0-indexed; default 0). Ignored for plain models.
    - ``tree_id``: which boosting tree to render (default 0). ``tree.milestone_tree_ids`` gives quick jumps (first/mid/best).
    """
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()

    root = _run_artifact_root(art_root, exp_id, run_id)
    config, _ = _load_pickle(root / "config") if (root / "config").exists() else (None, None)
    hyperparams: Dict[str, Any] = {}
    model_class = None
    model_module = None
    if config:
        model_cfg = (config.get("task", {}) or {}).get("model", {}) or {}
        hyperparams = dict(model_cfg.get("kwargs", {}) or {})
        model_class = model_cfg.get("class")
        model_module = model_cfg.get("module_path")

    if not hyperparams and not model_class:
        # Legacy / reconstructed runs: recover settings from the fitted model.
        model, _ = _load_model(art_root, exp_id, run_id)
        if model is not None:
            hyperparams = _model_params(model)
            if not model_class:
                model_class = type(model).__name__

    tree, warn = _model_dump(art_root, exp_id, run_id, int(tree_id), int(max_depth), int(seed))
    out: Dict[str, Any] = {
        "run_id": run_id,
        "experiment_id": exp_id,
        "model_class": model_class,
        "model_module": model_module,
        "hyperparams": _jsonable(hyperparams),
        "tree": tree,
    }
    if warn:
        out["warning"] = warn
    return _jsonable(out)


def rd_exp_blotter(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """Trade-level execution blotter for a run's backtest: FIFO tax-lot realized/unrealized P&L per trade and per position, daily equity/cost curve, position history, and the signal blotter (cross-sectional rank, selected topk, traded flag)."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()

    payload, warnings = _blotter(art_root, exp_id, run_id)
    return _jsonable(
        {
            "run_id": run_id,
            "experiment_id": exp_id,
            **payload,
        }
    )


def rd_exp_get_notes(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """Read the hypothesis/evaluation notes recorded for a run (sidecar rd-notes.json)."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()
    notes = _load_notes(art_root, exp_id, run_id)
    return _jsonable({"run_id": run_id, "experiment_id": exp_id, **notes})


def rd_exp_set_notes(run_id: str, hypothesis: str = "", evaluation: str = "", experiment_id: str = "", uri: str = "") -> dict:
    """Record hypothesis / evaluation notes for a run (sidecar rd-notes.json next to the run dir)."""
    store = _open_store(uri)

    meta = _run_meta(store, run_id)
    if meta is None:
        raise ValueError(f"run_id {run_id!r} not found")
    exp_id = int(experiment_id) if experiment_id else meta["experiment_id"]
    art_root = _artifact_root_for_run(store, exp_id, run_id)
    store.close()
    p = _notes_path(art_root, exp_id, run_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    notes = {"hypothesis": hypothesis, "evaluation": evaluation, "updated_at": _dt.datetime.now().isoformat(timespec="seconds")}
    p.write_text(json.dumps(notes, indent=2))
    return _jsonable({"run_id": run_id, "experiment_id": exp_id, "path": str(p), **notes})


# --------------------------------------------------------------------------- deletion
def _mlflow_store(uri: str):
    """The real MLflow tracking store (postgres/sqlite) for hard deletes."""
    from mlflow.tracking._tracking_service.utils import _get_store

    return _get_store(uri)


def _delete_rd_experiments(uri: str, run_ids: List[str]) -> int:
    """Delete traced ``rd_experiments`` rows referencing the given mlflow run ids.

    The trace table's FK to ``runs(run_uuid)`` is ``ON DELETE CASCADE``, but we
    delete explicitly so the rows are removed even against a legacy ``SET NULL``
    constraint (or a soft-deleted run that never hits the FK). Returns count.
    """
    if not run_ids:
        return 0
    if uri.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
        import psycopg

        with psycopg.connect(_postgres_dsn(uri)) as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM rd_experiments WHERE experiment_ref_id = ANY(%s)",
                (run_ids,),
            )
            return cur.rowcount
    db, _art = _sqlite_paths(uri)
    conn = sqlite3.connect(db)
    try:
        ph = ",".join("?" for _ in run_ids)
        cur = conn.execute(
            f"DELETE FROM rd_experiments WHERE experiment_ref_id IN ({ph})", run_ids
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def _delete_run_artifacts(art_root: Path, exp_id, run_id: str) -> int:
    """Remove the on-disk mlflow artifact dir(s) for a run. Returns count removed."""
    removed = 0
    for candidate in (art_root / str(exp_id) / run_id, art_root / run_id):
        if candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)
            removed += 1
    return removed


def _delete_art_root(uri: str) -> Path:
    if uri.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
        return _postgres_art_root()
    return _sqlite_paths(uri)[1]


def rd_exp_delete(experiment_id: str, uri: str = "") -> dict:
    """HARD-delete an MLflow experiment: all its runs + metrics/params/tags, the traced
    ``rd_experiments`` rows that reference those runs, and the on-disk artifact files.
    Use ``rd_exp_list`` for ids. Irreversible."""
    from mlflow.entities import ViewType

    uri = (uri or _default_tracking_uri()).strip()
    store = _mlflow_store(uri)
    try:
        exp = store.get_experiment(experiment_id)
    except Exception as exc:  # noqa: BLE001 - not found / bad id
        raise ValueError(f"experiment_id {experiment_id!r} not found (see rd_exp_list): {exc}")
    run_ids = [
        r.info.run_id
        for r in store.search_runs([experiment_id], "", ViewType.ALL, max_results=50000)
    ]

    traced_deleted = _delete_rd_experiments(uri, run_ids)
    art_root = _delete_art_root(uri)
    notes: List[str] = []

    for run_id in run_ids:
        try:
            store._hard_delete_run(run_id)
        except Exception as exc:  # noqa: BLE001 - best-effort per run
            notes.append(f"run {run_id}: {exc}")
        _delete_run_artifacts(art_root, experiment_id, run_id)

    try:
        store.delete_experiment(experiment_id)  # soft (required before hard)
        store._hard_delete_experiment(experiment_id)  # purge
    except Exception as exc:  # noqa: BLE001 - best-effort
        notes.append(f"experiment: {exc}")
    exp_dir = art_root / str(experiment_id)
    if exp_dir.is_dir():
        shutil.rmtree(exp_dir, ignore_errors=True)
        notes.append(f"removed {exp_dir}")

    return {
        "experiment_id": experiment_id,
        "experiment_name": getattr(exp, "name", None),
        "runs_deleted": len(run_ids),
        "traced_experiments_deleted": traced_deleted,
        "notes": notes,
    }


def rd_exp_delete_run(run_id: str, experiment_id: str = "", uri: str = "") -> dict:
    """HARD-delete a single MLflow run (metrics/params/tags), the traced
    ``rd_experiments`` row that references it, and its on-disk artifact files.
    Irreversible."""
    uri = (uri or _default_tracking_uri()).strip()
    store = _mlflow_store(uri)
    try:
        run = store.get_run(run_id)
    except Exception as exc:  # noqa: BLE001 - not found / bad id
        raise ValueError(f"run_id {run_id!r} not found: {exc}")
    exp_id = experiment_id or str(run.info.experiment_id)

    traced_deleted = _delete_rd_experiments(uri, [run_id])
    try:
        store._hard_delete_run(run_id)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"could not hard-delete run {run_id}: {exc}")
    removed = _delete_run_artifacts(_delete_art_root(uri), exp_id, run_id)

    return {
        "run_id": run_id,
        "experiment_id": exp_id,
        "traced_experiments_deleted": traced_deleted,
        "artifact_dirs_removed": removed,
    }


# --------------------------------------------------------------------------- lineage graph
def rd_exp_lineage(uri: str = "") -> dict:
    """Return the full experiment/run lineage as a node+edge graph for the R&D lineage view.

    Nodes are the traced `rd_experiments` rows (one per evolution step, each
    carrying its own `experiment_ref_id` = an mlflow run) and edges are their
    `evolved_from` self-FK links. Each node is enriched with: the mlflow
    experiment id/name it belongs to, the run's headline metrics (IC/ICIR/
    Rank IC/Rank ICIR from the traced metrics or the run's latest_metrics), its
    git branch / rational / status, and any trading rounds + order counts
    linked to it. This is the same Postgres store as the mlflow tracking db
    when `$DATABASE_URL` is set, so no recursive CTE / PGQ is needed — load all
    nodes and build edges client-side.
    """
    store = _open_store(uri)

    nodes: List[dict] = []
    edges: List[dict] = []
    try:
        rows = _rows(store, "SELECT * FROM rd_experiments ORDER BY id")
        cols = [c[0] for c in store.execute("SELECT * FROM rd_experiments LIMIT 0").description or ()]
    except Exception as exc:  # noqa: BLE001 - table may not exist yet
        store.close()
        return {"uri": uri, "nodes": [], "edges": [], "note": f"rd_experiments not available: {exc}"}

    def _col(row: tuple, name: str):
        try:
            return row[cols.index(name)]
        except (ValueError, IndexError):
            return None

    exp_ids_by_name: Dict[str, Any] = {}
    try:
        for r in _rows(store, "SELECT experiment_id, name FROM experiments"):
            exp_ids_by_name[str(r[1])] = r[0]
    except Exception:  # noqa: BLE001
        pass

    for row in rows:
        row_id = _col(row, "id")
        ref_id = _col(row, "experiment_ref_id")
        evolved = _col(row, "evolved_from")
        name = _col(row, "experiment_name")
        metrics = _col(row, "metrics") or {}

        headline = {}
        if metrics:
            headline = _headline(metrics)
        # Prefer the run's live IC-family metrics when the traced snapshot is
        # a trade-day summary (no IC/ICIR) — the /rd result view reads these.
        if ref_id:
            try:
                run_headline = _headline(_latest_metrics_of(store, ref_id))
            except Exception:  # noqa: BLE001
                run_headline = {}
            if run_headline:
                headline = run_headline if not headline else {**headline, **run_headline}

        # linked trading rounds + order counts (same postgres db)
        rounds = []
        try:
            for r in _rows(
                store,
                "SELECT id, target_date, status FROM trading_rounds WHERE rd_experiment_id = ? ORDER BY target_date",
                (row_id,),
            ):
                n_orders = 0
                n_filled = 0
                try:
                    cnt = _rows(
                        store,
                        "SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'filled') FROM round_orders WHERE round_id = ?",
                        (r[0],),
                    )[0]
                    n_orders, n_filled = cnt[0], cnt[1]
                except Exception:  # noqa: BLE001 - orders may be empty
                    pass
                rounds.append(
                    {
                        "round_id": r[0],
                        "target_date": str(r[1]) if r[1] is not None else None,
                        "status": r[2],
                        "orders": n_orders,
                        "filled": n_filled,
                    }
                )
        except Exception:  # noqa: BLE001 - rounds table may not exist
            pass

        nodes.append(
            {
                "id": row_id,
                "evolved_from": evolved,
                "experiment_name": name,
                "mlflow_experiment_id": exp_ids_by_name.get(str(name)) if name else None,
                "run_id": ref_id,
                "git_branch": _col(row, "git_branch"),
                "rational": _col(row, "rational"),
                "details": _col(row, "details"),
                "evaluation": _col(row, "evaluation"),
                "status": _col(row, "status"),
                "mlruns_dir": _col(row, "mlruns_dir"),
                "start_ts": _col(row, "start_ts"),
                "end_ts": _col(row, "end_ts"),
                "headline": headline,
                "rounds": rounds,
            }
        )
        if evolved:
            edges.append({"source": evolved, "target": row_id})

    store.close()
    return {"uri": uri, "db": store.db, "nodes": _jsonable(nodes), "edges": _jsonable(edges)}


# --------------------------------------------------------------------------- registration
def register_tools(server) -> None:
    """Attach all ``rd_exp_*`` tools to an ``MCPServer`` instance (called by rd_server.py)."""
    for fn in (
        rd_exp_list,
        rd_exp_get_experiment,
        rd_exp_get_run,
        rd_exp_input,
        rd_exp_dataset,
        rd_exp_result,
        rd_exp_model,
        rd_exp_blotter,
        rd_exp_get_notes,
        rd_exp_set_notes,
        rd_exp_delete,
        rd_exp_delete_run,
        rd_exp_lineage,
    ):
        server.tool(structured_output=False)(fn)
