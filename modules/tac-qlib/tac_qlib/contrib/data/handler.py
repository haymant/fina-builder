"""TACHandler: a qlib DataHandlerLP that builds datasets from the TradeAC lake.

This is the "custom DataHandler" entry point (Option B): the handler is referenced from the
workflow yaml's ``dataset.handler`` and reads OHLCV + pre-computed ta-lib features straight
from the lake parquet files through ``QLibDataLoader`` + the tac_qlib feature provider.

The standard qlib processor pipeline (``infer_processors`` / ``learn_processors``) still runs
on top, so existing recipes such as ``DropnaLabel``, ``CSZScoreNorm`` or ``RobustZScoreNorm``
keep working unchanged.
"""

from __future__ import annotations

import os
from inspect import getfullargspec
from typing import List, Optional, Tuple, Union

import numpy as np
import pandas as pd

from qlib.data.dataset import processor as processor_module
from qlib.data.dataset.handler import DataHandlerLP
from qlib.utils import get_callable_kwargs

from ...data.config import (
    LakeConfig,
    timeframe_for_freq,
    FEATURE_FAMILIES,
    NON_FEATURE_COLUMNS,
)

DEFAULT_INFER_PROCESSORS = [
    {"class": "DropAllNaN", "kwargs": {}},
    {
        "class": "TACProcessInf",
        "module_path": "tac_qlib.contrib.data.handler",
        "kwargs": {},
    },
    {
        "class": "TACZScoreNorm",
        "module_path": "tac_qlib.contrib.data.handler",
        "kwargs": {},
    },
    {"class": "Fillna", "kwargs": {}},
]
DEFAULT_LEARN_PROCESSORS = [
    {"class": "DropnaLabel"},
    {
        "class": "TACCSZScoreNorm",
        "module_path": "tac_qlib.contrib.data.handler",
        "kwargs": {"fields_group": "label"},
    },
]

#: always include raw OHLCV; ta-lib columns are discovered from the lake and appended.
RAW_FEATURE_FIELDS = ("$open", "$high", "$low", "$close", "$vwap", "$volume")

DEFAULT_LABEL = "Ref($close,-2)/Ref($close,-1)-1"


def _datetime_index_values(index):
    if isinstance(index, pd.MultiIndex):
        level = index.names.index("datetime") if "datetime" in index.names else 0
        return index.get_level_values(level)
    return index


def _datetime_group_level(index):
    """Return the date level without assuming it is literally named ``datetime``."""
    if isinstance(index, pd.MultiIndex) and "datetime" in index.names:
        return index.names.index("datetime")
    return 0


def _fit_window(df, start_time, end_time):
    """Select a fit window without assuming Qlib returned a two-level index."""
    dates = pd.to_datetime(_datetime_index_values(df.index), errors="coerce")
    if dates.isna().any():
        raise ValueError("Qlib data index contains values that are not valid datetimes")
    mask = np.ones(len(df), dtype=bool)
    if start_time is not None:
        mask &= dates >= pd.Timestamp(start_time)
    if end_time is not None:
        mask &= dates <= pd.Timestamp(end_time)
    return df.loc[mask]


def check_transform_proc(proc_l, fit_start_time, fit_end_time):
    """Port of ``qlib.contrib.data.handler.check_transform_proc`` (inject fit window into procs)."""
    new_l = []
    for p in proc_l:
        if not isinstance(p, processor_module.Processor):
            klass, pkwargs = get_callable_kwargs(p, processor_module)
            args = getfullargspec(klass).args
            if "fit_start_time" in args and "fit_end_time" in args:
                assert fit_start_time is not None and fit_end_time is not None, (
                    "Make sure `fit_start_time` and `fit_end_time` are not None."
                )
                pkwargs.update({"fit_start_time": fit_start_time, "fit_end_time": fit_end_time})
            proc_config = {"class": klass.__name__, "kwargs": pkwargs}
            if isinstance(p, dict) and "module_path" in p:
                proc_config["module_path"] = p["module_path"]
            new_l.append(proc_config)
        else:
            new_l.append(p)
    return new_l


def get_common_feature_fields(lake_root=None, market="US", timeframe="1d") -> List[str]:
    """Discover feature columns present in *every* feature file of the lake.

    Walks the `family=ta|sp` partition layout (plus any legacy flat files).
    TA and SP columns are disjoint by construction, so the common set is
    computed per family (columns shared by all symbol files of that family),
    then the per-family results are unioned. Returns sorted field names
    (without the ``$`` prefix). Empty if no features are persisted.
    """
    cfg = LakeConfig(lake_root, market)
    feat_dir = cfg.features_dir(timeframe)
    if not feat_dir.exists():
        return []
    import pyarrow.parquet as pq

    def _family_common(fam_dir: Path) -> set:
        common = None
        for p in sorted(fam_dir.glob("symbol=*.parquet")):
            try:
                cols = set(pq.read_schema(p).names) - set(NON_FEATURE_COLUMNS)
            except Exception:  # pragma: no cover - skip unreadable files
                continue
            common = cols if common is None else (common & cols)
            if not common:
                break
        return common or set()

    common: set = set()
    # family tier: features/market=*/timeframe=*/family=*/symbol=*.parquet
    for fam in FEATURE_FAMILIES:
        fam_dir = feat_dir / f"family={fam}"
        if fam_dir.is_dir():
            common |= _family_common(fam_dir)
    # legacy flat: features/market=*/timeframe=*/symbol=*.parquet
    if (feat_dir / "family=ta").exists() or (feat_dir / "family=sp").exists():
        pass  # family layout already covered
    else:
        common |= _family_common(feat_dir)
    return sorted(common)


class DropAllNaN(processor_module.Processor):
    """Drop feature columns that are all-NaN over the fit window.

    The lake can hold fully-empty indicator columns (e.g. a ta-lib output that was NaN
    from the start). Such columns carry no learnable signal and make ``ZScoreNorm.fit``
    warn on empty slices, so we drop them before any other processor runs. The drop set
    is fixed on the fit window once (during ``fit``), then applied consistently to every
    segment so train/valid/test keep identical feature columns.
    """

    def __init__(self, fit_start_time=None, fit_end_time=None):
        self.fit_start_time = fit_start_time
        self.fit_end_time = fit_end_time
        self.cols_to_drop = []

    def fit(self, df=None):
        if df is None or len(df) == 0:
            return self
        window = df
        if self.fit_start_time is not None and self.fit_end_time is not None:
            window = _fit_window(df, self.fit_start_time, self.fit_end_time)
        if len(window) == 0:
            return self
        self.cols_to_drop = [c for c in window.columns if window[c].isna().all()]
        return self

    def __call__(self, df):
        if self.cols_to_drop:
            return df.drop(columns=self.cols_to_drop, errors="ignore")
        return df


class TACZScoreNorm(processor_module.ZScoreNorm):
    """Qlib Z-score normalization with date selection for either index shape.

    Qlib's helper assumes a two-level (datetime, instrument) MultiIndex. The
    lake loader can instead return a single datetime index (notably for a
    one-symbol universe), so select the fit rows with a parsed date mask.
    """

    def fit(self, df=None):
        if df is None or len(df) == 0:
            return self
        window = _fit_window(df, self.fit_start_time, self.fit_end_time)
        if len(window) == 0:
            raise ValueError(
                "TACZScoreNorm fit window contains no rows; check handler fit dates and lake coverage"
            )
        cols = processor_module.get_group_columns(window, self.fields_group)
        self.mean_train = np.nanmean(window[cols].values, axis=0)
        self.std_train = np.nanstd(window[cols].values, axis=0)
        self.ignore = self.std_train == 0
        for index, ignored in enumerate(self.ignore):
            if ignored:
                self.std_train[index] = 1
                self.mean_train[index] = 0
        self.cols = cols
        return self


class TACProcessInf(processor_module.Processor):
    """Replace infinities with the finite cross-sectional mean for each date.

    Qlib's built-in ``ProcessInf`` parallelizes by resampling the datetime index
    level. Lake-backed Qlib frames can have an ordinary Index at that level
    (for example ISO-date strings), which pandas cannot resample. Grouping by
    the datetime level directly preserves Qlib's per-date behavior without
    requiring a DatetimeIndex or a resampling step.
    """

    @staticmethod
    def _replace_inf(frame):
        result = frame.copy()
        for column in result.columns:
            values = result[column]
            infinite = np.isinf(values)
            if infinite.any():
                result.loc[infinite, column] = values[~infinite].mean()
        return result

    def __call__(self, df):
        if isinstance(df.index, pd.MultiIndex) and "datetime" in df.index.names:
            result = df.groupby(level="datetime", group_keys=False, sort=False).apply(
                self._replace_inf
            )
        elif not isinstance(df.index, pd.MultiIndex):
            result = df.groupby(level=0, group_keys=False, sort=False).apply(
                self._replace_inf
            )
        else:
            result = self._replace_inf(df)
        return result.sort_index()


class TACCSRankNorm(processor_module.CSRankNorm):
    """Qlib rank normalization grouped by the actual date index level."""

    def __call__(self, df):
        result = df.copy()
        cols = processor_module.get_group_columns(result, self.fields_group)
        ranked = result[cols].groupby(
            level=_datetime_group_level(result.index), group_keys=False, sort=False
        ).rank(pct=True)
        result[cols] = (ranked - 0.5) * 3.46
        return result


class TACCSZScoreNorm(processor_module.CSZScoreNorm):
    """Qlib cross-sectional z-score normalization for either date-index shape."""

    def __call__(self, df):
        result = df.copy()
        groups = self.fields_group if isinstance(self.fields_group, list) else [self.fields_group]
        level = _datetime_group_level(result.index)
        for group in groups:
            cols = processor_module.get_group_columns(result, group)
            result[cols] = result[cols].groupby(
                level=level, group_keys=False, sort=False
            ).transform(self.zscore_func)
        return result


class BenchResidual(processor_module.Processor):
    """Subtract a benchmark instrument's forward return from the label, per datetime.

    Turns the training target from an absolute-return rank into a *residual* rank:
    ``r_i - r_bench`` is ranked cross-sectionally by the downstream ``CSRankNorm`` /
    ``CSZScoreNorm`` processors instead of ``r_i`` alone. Must be inserted BEFORE any
    per-date normalization so the ranking itself is computed on residual returns
    (ordering flips exactly where the benchmark trends).

    Stateless: ``fit`` is a no-op and the benchmark forward return is recomputed from
    the lake parquet on first ``__call__``. Rows whose benchmark value is missing are
    left untouched. Accepts ``fit_start_time``/``fit_end_time`` (ignored) so
    ``check_transform_proc`` can inject the fit window uniformly.

    NOTE: under any cross-sectional normalization downstream (``CSRankNorm`` /
    ``CSZScoreNorm``) this processor is a mathematical no-op: subtracting the same
    per-date constant preserves ranks, and z-scoring absorbs constant shifts. Use
    ``BenchBetaResidual`` for a target that actually reorders.
    """

    def __init__(
        self,
        benchmark="SPY",
        fields_group="label",
        lake_root=None,
        market="US",
        timeframe=None,
        freq="day",
        fit_start_time=None,
        fit_end_time=None,
    ):
        self.benchmark = benchmark
        self.fields_group = fields_group
        self.lake_root = lake_root
        self.market = market
        self.timeframe = timeframe or timeframe_for_freq(freq)
        self.fit_start_time = fit_start_time
        self.fit_end_time = fit_end_time
        self._bench_label = None

    def _load_bench_label(self):
        if self._bench_label is not None:
            return self._bench_label
        cfg = LakeConfig(self.lake_root, self.market)
        p = cfg.bar_path(self.timeframe, self.benchmark)
        if not p.exists():
            raise FileNotFoundError(f"BenchResidual: benchmark bar file not found: {p}")
        df = pd.read_parquet(p)
        s = pd.Series(df["c"].astype(float).values, index=pd.to_datetime(df["t"])).sort_index()
        s.index = s.index.normalize()
        # mirror Ref($close,-6)/Ref($close,-1)-1 on the benchmark's own calendar
        bench_label = s.shift(-6) / s.shift(-1) - 1
        self._bench_label = bench_label[~bench_label.index.duplicated(keep="last")]
        return self._bench_label

    def fit(self, df=None):
        return self

    def __call__(self, df):
        bl = self._load_bench_label()
        cols = processor_module.get_group_columns(df, self.fields_group)
        dt = df.index.get_level_values("datetime")
        aligned = bl.reindex(pd.DatetimeIndex(dt.unique())).reindex(dt)
        mask = aligned.notna().values
        out = df.copy()
        for c in cols:
            vals = df[c].values
            res = vals.copy()
            res[mask] = np.asarray(vals[mask], dtype=float) - aligned[mask].values
            out[c] = res
        return out


class BenchBetaResidual(processor_module.Processor):
    """Residualize the label against a beta-scaled benchmark move: ``r_i - b_i * r_bench``.

    Unlike a plain constant subtraction (see ``BenchResidual``), the name-specific rolling
    beta ``b_i`` makes this survive cross-sectional normalization: in up-weeks high-beta
    names lose rank, in down-weeks they gain — exactly the relative structure an absolute-
    return ranking hides.

    Beta is estimated from *past* data only (rolling ``window`` trading days of daily close
    returns of each instrument vs the benchmark, both read up to and including ``t``), so
    no lookahead enters the target. The benchmark leg uses the same horizon as the label
    expression (``Ref($close,-6)/Ref($close,-1)-1`` by default via ``horizon``/``base``,
    matching the yaml's 6-day label). Rows with missing beta or benchmark values keep
    their raw label.

    Requires ``$close`` to be present in the feature group (it always is for TACHandler).
    Stateless; accepts ``fit_start_time``/``fit_end_time`` (ignored) for uniform kwargs
    injection. Must be inserted BEFORE any per-date normalization processor.
    """

    def __init__(
        self,
        benchmark="SPY",
        fields_group="label",
        lake_root=None,
        market="US",
        timeframe=None,
        freq="day",
        window=63,
        horizon=6,
        base=1,
        feature_field="$close",
        fit_start_time=None,
        fit_end_time=None,
    ):
        self.benchmark = benchmark
        self.fields_group = fields_group
        self.lake_root = lake_root
        self.market = market
        self.timeframe = timeframe or timeframe_for_freq(freq)
        self.window = int(window)
        self.horizon = int(horizon)
        self.base = int(base)
        self.feature_field = feature_field
        self.fit_start_time = fit_start_time
        self.fit_end_time = fit_end_time
        self._bench = None

    def _load_bench_close(self):
        if self._bench is not None:
            return self._bench
        cfg = LakeConfig(self.lake_root, self.market)
        p = cfg.bar_path(self.timeframe, self.benchmark)
        if not p.exists():
            raise FileNotFoundError(f"BenchBetaResidual: benchmark bar file not found: {p}")
        df = pd.read_parquet(p)
        s = pd.Series(df["c"].astype(float).values, index=pd.to_datetime(df["t"])).sort_index()
        s.index = s.index.normalize()
        self._bench = s[~s.index.duplicated(keep="last")]
        return self._bench

    def fit(self, df=None):
        return self

    def __call__(self, df):
        bench = self._load_bench_close()

        # benchmark forward return over the same horizon as the label expression
        fwd = bench.shift(-(self.base + self.horizon - 1)) / bench.shift(-self.base) - 1

        px_col = ("feature", self.feature_field)
        if px_col not in df.columns:
            raise KeyError(f"BenchBetaResidual: {self.feature_field} not found in features")
        px = df[px_col].unstack("instrument").sort_index()
        rets = px / px.shift(1) - 1
        bret = bench.reindex(px.index).pct_change()

        # rolling beta per instrument using data <= t (no lookahead)
        cov = rets.rolling(self.window, min_periods=max(10, self.window // 2)).cov(bret)
        var = bret.rolling(self.window, min_periods=max(10, self.window // 2)).var()
        beta = cov.div(var, axis=0)

        contrib = beta.mul(fwd.reindex(px.index), axis=0)
        cols = list(processor_module.get_group_columns(df, self.fields_group))
        out = df.copy()
        for c in cols:
            lab = df[c].unstack("instrument").reindex(px.index)
            resid = lab - contrib.where(contrib.notna() & lab.notna(), 0.0)
            new_vals = resid.stack()
            new_vals.index.names = df.index.names
            # residual where available, raw label otherwise (e.g. beta warm-up rows)
            out[c] = new_vals.reindex(out.index).fillna(df[c])
        return out


class TACHandler(DataHandlerLP):
    """DataHandlerLP backed by the TradeAC parquet lake.

    Parameters mirror ``Alpha158``: ``instruments``/``start_time``/``end_time``/``freq`` define
    the queried window; ``feature_fields`` selects the features (default: raw OHLCV + all common
    ta-lib columns found in the lake); ``label`` is a qlib expression for the target.
    """

    def __init__(
        self,
        instruments="all",
        start_time=None,
        end_time=None,
        freq="day",
        infer_processors=DEFAULT_INFER_PROCESSORS,
        learn_processors=DEFAULT_LEARN_PROCESSORS,
        fit_start_time=None,
        fit_end_time=None,
        process_type=DataHandlerLP.PTYPE_A,
        filter_pipe=None,
        feature_fields=None,
        label=DEFAULT_LABEL,
        lake_root=None,
        market="US",
        **kwargs,
    ):
        # default the processor fit window to the queried window (like Alpha158 without a split)
        if fit_start_time is None:
            fit_start_time = start_time
        if fit_end_time is None:
            fit_end_time = end_time

        infer_processors = check_transform_proc(infer_processors, fit_start_time, fit_end_time)
        learn_processors = check_transform_proc(learn_processors, fit_start_time, fit_end_time)

        feature_fields = self._normalize_feature_fields(feature_fields, freq, lake_root, market)
        if not feature_fields:
            raise ValueError(
                "no feature fields available for the lake; set `feature_fields` explicitly "
                "(e.g. ['$close', '$rsi_14', '$sma_20'])"
            )

        label_expr, label_names = self._normalize_label(label)

        data_loader = {
            "class": "QlibDataLoader",
            "kwargs": {
                "config": {
                    "feature": (feature_fields, feature_fields),
                    "label": (label_expr, label_names),
                },
                "filter_pipe": filter_pipe,
                "freq": freq,
            },
        }
        super().__init__(
            instruments=instruments,
            start_time=start_time,
            end_time=end_time,
            data_loader=data_loader,
            infer_processors=infer_processors,
            learn_processors=learn_processors,
            process_type=process_type,
            **kwargs,
        )

    # ------------------------------------------------------------------ config
    @staticmethod
    def _normalize_feature_fields(feature_fields, freq, lake_root, market) -> List[str]:
        if feature_fields is None:
            common = get_common_feature_fields(lake_root, market, timeframe_for_freq(freq))
            feature_fields = list(RAW_FEATURE_FIELDS) + ["$" + f for f in common if "$" + f not in RAW_FEATURE_FIELDS]
        elif isinstance(feature_fields, str):
            feature_fields = [f.strip() for f in feature_fields.split(",") if f.strip()]
        fields = [f if f.startswith("$") else "$" + f for f in feature_fields]
        # de-dup while preserving order
        seen, out = set(), []
        for f in fields:
            if f not in seen:
                seen.add(f)
                out.append(f)
        return out

    @staticmethod
    def _normalize_label(label) -> Tuple[List[str], List[str]]:
        if isinstance(label, str):
            return [label], ["LABEL0"]
        if isinstance(label, (list, tuple)):
            if len(label) == 2 and isinstance(label[0], str):
                return [label[0]], list(label[1]) if isinstance(label[1], (list, tuple)) else [label[1]]
            return list(label), ["LABEL%d" % i for i in range(len(label))]
        raise TypeError(f"unsupported label config: {label!r}")

    # ------------------------------------------------------------------ utils
    def get_label_config(self):
        return DEFAULT_LABEL

    @staticmethod
    def discover_feature_fields(lake_root=None, market="US", freq="day") -> List[str]:
        return get_common_feature_fields(lake_root, market, timeframe_for_freq(freq))


__all__ = [
    "TACHandler",
    "DropAllNaN",
    "TACCSRankNorm",
    "TACCSZScoreNorm",
    "TACZScoreNorm",
    "TACProcessInf",
    "BenchResidual",
    "BenchBetaResidual",
    "get_common_feature_fields",
]


# Register custom TAC processors with Qlib's resolver, mirroring how Qlib registers its own
# processors in ``qlib.data.dataset.processor``. Explicit module paths remain in service-owned
# normalized workflow configs; registration also supports direct handler configuration.
processor_module.DropAllNaN = DropAllNaN
processor_module.TACCSRankNorm = TACCSRankNorm
processor_module.TACCSZScoreNorm = TACCSZScoreNorm
processor_module.BenchResidual = BenchResidual
processor_module.BenchBetaResidual = BenchBetaResidual
