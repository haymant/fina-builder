"""Bounded, renderer-safe R&D Qlib workflow YAML.

Only a small declarative subset is accepted. Runtime paths, provider classes,
tracking URIs, Python imports, Jinja and arbitrary Qlib constructors are owned
by the service, never by a submitted document.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from typing import Any

from ruamel.yaml import YAML

MAX_WORKFLOW_YAML_BYTES = 128 * 1024
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MODEL_CLASSES = {
    "LGBModel": "qlib.contrib.model.gbdt",
    "RankICLGBModel": "tac_qlib.contrib.model.rank_gbdt",
}
RECORD_MODULES = {
    "SignalRecord": "qlib.workflow.record_temp",
    "SigAnaRecord": "qlib.workflow.record_temp",
    "PortAnaRecord": "qlib.workflow.record_temp",
}
PROCESSORS = {
    "DropAllNaN",
    "ProcessInf",
    "TACProcessInf",
    "CSRankNorm",
    "ZScoreNorm",
    "Fillna",
}
TAC_PROCESSOR_MODULE = "tac_qlib.contrib.data.handler"
MODEL_KWARGS = {
    "loss", "learning_rate", "num_leaves", "n_estimators", "num_boost_round",
    "early_stopping_rounds", "min_data_in_leaf", "lambda_l1", "lambda_l2",
    "max_depth", "max_bin", "min_child_samples", "min_child_weight",
    "colsample_bytree", "subsample", "subsample_freq", "reg_alpha", "reg_lambda",
    "rank_eval", "seed", "num_threads", "feature_fraction_seed", "bagging_seed",
    "data_random_seed", "deterministic", "force_col_wise",
}
HANDLER_KWARGS = {
    "instruments", "start_time", "end_time", "fit_start_time", "fit_end_time",
    "freq", "market", "label", "feature_fields", "infer_processors", "learn_processors",
}


def _mapping(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{where} must be a YAML mapping")
    return value


def _keys(value: dict[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        raise ValueError(f"{where} contains unsupported key(s): {', '.join(extra)}")


def _text(value: Any, where: str, *, required: bool = True, max_length: int = 4096) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > max_length:
        raise ValueError(f"{where} must be a non-empty string of at most {max_length} characters")
    if "{{" in value or "}}" in value or "{%" in value or "${" in value:
        raise ValueError(f"{where} must not contain template expressions")
    return value


def _iso_date(value: Any, where: str) -> str:
    if isinstance(value, (date, datetime)):
        result = value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    else:
        result = _text(value, where, max_length=10)
    if not _DATE_RE.fullmatch(result):
        raise ValueError(f"{where} must use YYYY-MM-DD")
    try:
        date.fromisoformat(result)
    except ValueError as exc:
        raise ValueError(f"{where} is not a valid calendar date") from exc
    return result


def _number(value: Any, where: str, *, minimum: float, maximum: float, integer: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{where} must be numeric")
    if integer and not isinstance(value, int):
        raise ValueError(f"{where} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{where} must be between {minimum} and {maximum}")
    return value


def _normalise_processors(value: Any, where: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 16:
        raise ValueError(f"{where} must be a list with at most 16 processors")
    result = []
    for index, item in enumerate(value):
        item = _mapping(item, f"{where}[{index}]")
        _keys(item, {"class", "kwargs"}, f"{where}[{index}]")
        name = item.get("class")
        if name not in PROCESSORS:
            raise ValueError(f"{where}[{index}].class is not an approved processor")
        kwargs = _mapping(item.get("kwargs", {}), f"{where}[{index}].kwargs")
        if kwargs:
            raise ValueError(f"{where}[{index}].kwargs is not configurable")
        # Keep accepting existing workflow YAML, but avoid Qlib ProcessInf's
        # parallel resampling path, which requires a DatetimeIndex level.
        normalized_name = "TACProcessInf" if name in {"ProcessInf", "TACProcessInf"} else name
        processor = {"class": normalized_name, "kwargs": {}}
        if normalized_name == "TACProcessInf":
            processor["module_path"] = TAC_PROCESSOR_MODULE
        result.append(processor)
    return result


def _normalise_record(record: Any, index: int, instruments: str = "all") -> dict[str, Any]:
    where = f"task.record[{index}]"
    record = _mapping(record, where)
    _keys(record, {"class", "module_path", "kwargs"}, where)
    name = record.get("class")
    if name not in RECORD_MODULES:
        raise ValueError(f"{where}.class is not approved")
    if record.get("module_path") != RECORD_MODULES[name]:
        raise ValueError(f"{where}.module_path must be {RECORD_MODULES[name]}")
    kwargs = _mapping(record.get("kwargs", {}), f"{where}.kwargs")
    if name == "SignalRecord":
        _keys(kwargs, set(), f"{where}.kwargs")
        clean_kwargs: dict[str, Any] = {}
    elif name == "SigAnaRecord":
        _keys(kwargs, {"ana_long_short", "ann_scaler"}, f"{where}.kwargs")
        clean_kwargs = {}
        if "ana_long_short" in kwargs:
            if not isinstance(kwargs["ana_long_short"], bool):
                raise ValueError(f"{where}.kwargs.ana_long_short must be boolean")
            clean_kwargs["ana_long_short"] = kwargs["ana_long_short"]
        if "ann_scaler" in kwargs:
            clean_kwargs["ann_scaler"] = _number(kwargs["ann_scaler"], f"{where}.kwargs.ann_scaler", minimum=1, maximum=1000, integer=True)
    else:
        _keys(kwargs, {"config", "risk_analysis_freq"}, f"{where}.kwargs")
        config = _mapping(kwargs.get("config", {}), f"{where}.kwargs.config")
        _keys(config, {"strategy", "backtest"}, f"{where}.kwargs.config")
        strategy = _mapping(config.get("strategy", {}), f"{where}.kwargs.config.strategy")
        _keys(strategy, {"class", "module_path", "kwargs"}, f"{where}.strategy")
        if strategy.get("class") != "TopkDropoutStrategy" or strategy.get("module_path") != "qlib.contrib.strategy":
            raise ValueError(f"{where}.strategy must use the approved TopkDropoutStrategy")
        skw = _mapping(strategy.get("kwargs", {}), f"{where}.strategy.kwargs")
        _keys(skw, {"signal", "topk", "n_drop", "only_tradable", "risk_degree"}, f"{where}.strategy.kwargs")
        if skw.get("signal", "<PRED>") != "<PRED>":
            raise ValueError(f"{where}.strategy.kwargs.signal must be <PRED>")
        only_tradable = skw.get("only_tradable", True)
        if not isinstance(only_tradable, bool):
            raise ValueError(f"{where}.strategy.kwargs.only_tradable must be boolean")
        strategy_kwargs = {
            "signal": "<PRED>",
            "topk": _number(skw.get("topk", 10), f"{where}.strategy.kwargs.topk", minimum=1, maximum=1000, integer=True),
            "n_drop": _number(skw.get("n_drop", 2), f"{where}.strategy.kwargs.n_drop", minimum=0, maximum=1000, integer=True),
            "only_tradable": only_tradable,
            "risk_degree": _number(skw.get("risk_degree", 0.95), f"{where}.strategy.kwargs.risk_degree", minimum=0.01, maximum=1),
        }
        backtest = _mapping(config.get("backtest", {}), f"{where}.kwargs.config.backtest")
        _keys(backtest, {"start_time", "end_time", "account", "benchmark", "exchange_kwargs"}, f"{where}.backtest")
        exchange = _mapping(backtest.get("exchange_kwargs", {}), f"{where}.backtest.exchange_kwargs")
        _keys(exchange, {"codes", "deal_price", "freq", "open_cost", "close_cost", "min_cost"}, f"{where}.backtest.exchange_kwargs")
        raw_codes = exchange.get("codes", "all")
        if raw_codes == "all":
            codes: str | list[str] = "all"
        elif isinstance(raw_codes, list) and 1 <= len(raw_codes) <= 500:
            codes = []
            for code in raw_codes:
                symbol = _text(code, f"{where}.backtest.exchange_kwargs.codes[]", max_length=16).upper()
                if not _SYMBOL_RE.fullmatch(symbol):
                    raise ValueError(f"{where}.backtest.exchange_kwargs.codes must contain valid symbols")
                codes.append(symbol)
            if len(set(codes)) != len(codes):
                raise ValueError(f"{where}.backtest.exchange_kwargs.codes must not contain duplicates")
            instruments_upper = [symbol.upper() for symbol in instruments.split(",")]
            if instruments != "all" and not set(codes).issubset(instruments_upper):
                raise ValueError(f"{where}.backtest.exchange_kwargs.codes must be within the dataset universe")
        else:
            raise ValueError(f"{where}.backtest.exchange_kwargs.codes must be 'all' or a list of symbols")
        if exchange.get("deal_price", "$close") != "$close":
            raise ValueError(f"{where}.backtest.exchange_kwargs.deal_price must be $close")
        freq = exchange.get("freq", "day")
        if freq != "day":
            raise ValueError(f"{where}.backtest.exchange_kwargs.freq must be day")
        backtest_clean = {
            "start_time": _iso_date(backtest.get("start_time"), f"{where}.backtest.start_time"),
            "end_time": _iso_date(backtest.get("end_time"), f"{where}.backtest.end_time"),
            "account": _number(backtest.get("account", 1000000), f"{where}.backtest.account", minimum=1, maximum=1e12),
            "benchmark": _text(backtest.get("benchmark", "SPY"), f"{where}.backtest.benchmark", max_length=16),
            "exchange_kwargs": {
                "codes": codes,
                "deal_price": "$close",
                "freq": "day",
                "open_cost": _number(exchange.get("open_cost", 0.0005), f"{where}.backtest.exchange_kwargs.open_cost", minimum=0, maximum=0.1),
                "close_cost": _number(exchange.get("close_cost", 0.0015), f"{where}.backtest.exchange_kwargs.close_cost", minimum=0, maximum=0.1),
                "min_cost": _number(exchange.get("min_cost", 5.0), f"{where}.backtest.exchange_kwargs.min_cost", minimum=0, maximum=1e6),
            },
        }
        clean_kwargs = {"config": {"strategy": {"class": "TopkDropoutStrategy", "module_path": "qlib.contrib.strategy", "kwargs": strategy_kwargs}, "backtest": backtest_clean}}
        if "risk_analysis_freq" in kwargs:
            if kwargs["risk_analysis_freq"] != "1d":
                raise ValueError(f"{where}.kwargs.risk_analysis_freq must be 1d")
            clean_kwargs["risk_analysis_freq"] = "1d"
    return {"class": name, "module_path": RECORD_MODULES[name], "kwargs": clean_kwargs}


def prepare_rd_workflow_yaml(config_yaml: str, *, lake_root: str, expected_experiment_name: str | None = None) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Validate user YAML, inject host-owned runtime config, and return its summary."""
    if not isinstance(config_yaml, str) or not config_yaml.strip():
        raise ValueError("config_yaml must be a non-empty string")
    if len(config_yaml.encode("utf-8")) > MAX_WORKFLOW_YAML_BYTES:
        raise ValueError(f"config_yaml exceeds the 128 KiB ({MAX_WORKFLOW_YAML_BYTES}-byte) limit")
    if any(marker in config_yaml for marker in ("{{", "}}", "{%", "${")):
        raise ValueError("template expressions are not accepted in submitted workflow YAML")
    parser = YAML(typ="safe", pure=True)
    parser.allow_duplicate_keys = False
    parsed = parser.load(config_yaml)
    doc = _mapping(parsed, "workflow")
    _keys(doc, {"experiment_name", "task"}, "workflow")
    experiment_name = _text(doc.get("experiment_name"), "experiment_name", max_length=64).strip()
    if not _NAME_RE.fullmatch(experiment_name):
        raise ValueError("experiment_name may contain only letters, digits, spaces, dot, underscore and hyphen")
    if expected_experiment_name is not None and expected_experiment_name != experiment_name:
        raise ValueError("experiment_name does not match the validated workflow YAML")

    task = _mapping(doc.get("task"), "task")
    _keys(task, {"model", "dataset", "record"}, "task")
    model = _mapping(task.get("model"), "task.model")
    _keys(model, {"class", "module_path", "kwargs"}, "task.model")
    model_name = model.get("class")
    if model_name not in MODEL_CLASSES or model.get("module_path") != MODEL_CLASSES[model_name]:
        raise ValueError("task.model must use LGBModel or RankICLGBModel from its approved module")
    model_kwargs = _mapping(model.get("kwargs", {}), "task.model.kwargs")
    _keys(model_kwargs, MODEL_KWARGS, "task.model.kwargs")
    model_clean = dict(model_kwargs)
    if "seed" in model_clean:
        model_clean["seed"] = _number(model_clean["seed"], "task.model.kwargs.seed", minimum=0, maximum=2_147_483_647, integer=True)
    else:
        model_clean["seed"] = 2026
    for key, expected in (("num_threads", 1), ("feature_fraction_seed", model_clean["seed"]), ("bagging_seed", model_clean["seed"]), ("data_random_seed", model_clean["seed"]), ("deterministic", True), ("force_col_wise", True)):
        if key in model_clean and model_clean[key] != expected:
            raise ValueError(f"task.model.kwargs.{key} is fixed to {expected} for deterministic runs")
        model_clean[key] = expected
    for key, low, high in (("learning_rate", 1e-6, 1.0), ("colsample_bytree", 0.01, 1.0), ("subsample", 0.01, 1.0), ("reg_alpha", 0.0, 1e6), ("reg_lambda", 0.0, 1e6)):
        if key in model_clean:
            model_clean[key] = _number(model_clean[key], f"task.model.kwargs.{key}", minimum=low, maximum=high)
    for key in ("num_leaves", "n_estimators", "num_boost_round", "early_stopping_rounds", "min_data_in_leaf", "max_depth", "max_bin", "min_child_samples", "subsample_freq"):
        if key in model_clean:
            model_clean[key] = _number(model_clean[key], f"task.model.kwargs.{key}", minimum=1, maximum=100000, integer=True)
    if "rank_eval" in model_clean and not isinstance(model_clean["rank_eval"], bool):
        raise ValueError("task.model.kwargs.rank_eval must be boolean")
    if "loss" in model_clean and model_clean["loss"] not in {"mse", "binary", "regression"}:
        raise ValueError("task.model.kwargs.loss is not supported")

    dataset = _mapping(task.get("dataset"), "task.dataset")
    _keys(dataset, {"class", "module_path", "kwargs"}, "task.dataset")
    if dataset.get("class") != "DatasetH" or dataset.get("module_path") != "qlib.data.dataset":
        raise ValueError("task.dataset must use the approved qlib DatasetH")
    dkw = _mapping(dataset.get("kwargs"), "task.dataset.kwargs")
    _keys(dkw, {"handler", "segments"}, "task.dataset.kwargs")
    handler = _mapping(dkw.get("handler"), "task.dataset.kwargs.handler")
    _keys(handler, {"class", "module_path", "kwargs"}, "task.dataset.kwargs.handler")
    if handler.get("class") != "TACHandler" or handler.get("module_path") != "tac_qlib.contrib.data.handler":
        raise ValueError("task.dataset.kwargs.handler must use the approved TACHandler")
    hkw = _mapping(handler.get("kwargs"), "task.dataset.kwargs.handler.kwargs")
    _keys(hkw, HANDLER_KWARGS, "task.dataset.kwargs.handler.kwargs")
    instruments = _text(hkw.get("instruments", "all"), "handler.instruments", max_length=8192).strip()
    symbols = [item.strip() for item in instruments.split(",")]
    if not symbols or any(not _SYMBOL_RE.fullmatch(symbol) for symbol in symbols):
        raise ValueError("handler.instruments must be 'all' or a comma-separated list of symbols")
    market = _text(hkw.get("market", "US"), "handler.market", max_length=8).upper()
    if market not in {"US"}:
        raise ValueError("only the US market is enabled for submitted workflow YAML")
    freq = _text(hkw.get("freq", "day"), "handler.freq", max_length=8)
    if freq != "day":
        raise ValueError("only day frequency is enabled for submitted workflow YAML")
    start = _iso_date(hkw.get("start_time"), "handler.start_time")
    end = _iso_date(hkw.get("end_time"), "handler.end_time")
    fit_start = _iso_date(hkw.get("fit_start_time", start), "handler.fit_start_time")
    fit_end = _iso_date(hkw.get("fit_end_time", end), "handler.fit_end_time")
    if not (start <= fit_start <= fit_end <= end):
        raise ValueError("handler fit dates must lie inside start_time and end_time")
    label = _text(hkw.get("label", "Ref($close,-2)/Ref($close,-1)-1"), "handler.label", max_length=2048)
    fields = _text(hkw.get("feature_fields", "$open,$high,$low,$close,$volume"), "handler.feature_fields", max_length=8192)
    for list_name in ("infer_processors", "learn_processors"):
        if list_name in hkw and hkw[list_name] is not None and not isinstance(hkw[list_name], list):
            raise ValueError(f"handler.{list_name} must be a list")
    clean_handler_kwargs = {
        "instruments": instruments, "start_time": start, "end_time": end,
        "fit_start_time": fit_start, "fit_end_time": fit_end, "freq": freq,
        "market": market, "label": label, "feature_fields": fields,
        "lake_root": lake_root,
        "infer_processors": _normalise_processors(hkw.get("infer_processors"), "handler.infer_processors"),
        "learn_processors": _normalise_processors(hkw.get("learn_processors"), "handler.learn_processors"),
    }
    segments = _mapping(dkw.get("segments"), "task.dataset.kwargs.segments")
    _keys(segments, {"train", "valid", "test"}, "task.dataset.kwargs.segments")
    if not {"train", "valid", "test"}.issubset(segments):
        raise ValueError("dataset segments must explicitly include train, valid and test")
    clean_segments: dict[str, list[str]] = {}
    previous_end = None
    for name in ("train", "valid", "test"):
        pair = segments[name]
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError(f"dataset.segments.{name} must be a [start, end] pair")
        first, last = _iso_date(pair[0], f"dataset.segments.{name}[0]"), _iso_date(pair[1], f"dataset.segments.{name}[1]")
        if first > last or first < start or last > end or (previous_end and first <= previous_end):
            raise ValueError("dataset segments must be ordered, non-overlapping and inside the handler date range")
        clean_segments[name] = [first, last]
        previous_end = last
    if fit_end > clean_segments["train"][1]:
        raise ValueError("handler.fit_end_time must not extend beyond the dataset train segment")
    records = task.get("record")
    if not isinstance(records, list) or not 2 <= len(records) <= 3:
        raise ValueError("task.record must contain SignalRecord and SigAnaRecord, with optional PortAnaRecord")
    record_clean = [_normalise_record(item, i, instruments) for i, item in enumerate(records)]
    record_names = [item["class"] for item in record_clean]
    if len(set(record_names)) != len(record_names) or not {"SignalRecord", "SigAnaRecord"}.issubset(record_names):
        raise ValueError("task.record must include each of SignalRecord and SigAnaRecord once")
    for item in record_clean:
        if item["class"] == "PortAnaRecord":
            backtest = item["kwargs"]["config"]["backtest"]
            if backtest["start_time"] > backtest["end_time"]:
                raise ValueError("PortAnaRecord backtest start_time must not be after end_time")
            if backtest["start_time"] < clean_segments["test"][0] or backtest["end_time"] > clean_segments["test"][1]:
                raise ValueError("PortAnaRecord backtest dates must lie inside dataset.segments.test")

    clean_task = {
        "model": {"class": model_name, "module_path": MODEL_CLASSES[model_name], "kwargs": model_clean},
        "dataset": {"class": "DatasetH", "module_path": "qlib.data.dataset", "kwargs": {
            "handler": {"class": "TACHandler", "module_path": "tac_qlib.contrib.data.handler", "kwargs": clean_handler_kwargs},
            "segments": clean_segments,
        }},
        "record": record_clean,
    }
    # Runtime providers and MLflow are always selected by the service.
    qlib_init = {
        "provider_uri": lake_root,
        "region": market.lower(),
        "expression_cache": None,
        "dataset_cache": None,
        "calendar_provider": {"class": "tac_qlib.data.providers.LakeCalendarProvider", "kwargs": {"lake_root": lake_root, "market": market}},
        "instrument_provider": {"class": "tac_qlib.data.providers.LakeInstrumentProvider", "kwargs": {"lake_root": lake_root, "market": market, "markets": {}}},
        "feature_provider": {"class": "tac_qlib.data.providers.LakeFeatureProvider", "kwargs": {"lake_root": lake_root, "market": market}},
        # This harmless relative marker is normalized to the host-owned tracking
        # store by rd_server before qlib.init; never serialize DATABASE_URL into
        # renderer-visible YAML or MLflow config artifacts.
        "exp_manager": {"class": "MLflowExpManager", "module_path": "qlib.workflow.expm", "kwargs": {"uri": "sqlite:///mlruns.db", "default_exp_name": experiment_name}},
    }
    runtime_cfg = {"qlib_init": qlib_init, "task": clean_task}
    fingerprint = workflow_fingerprint(runtime_cfg)
    summary = {
        "experiment_name": experiment_name,
        "model_class": model_name,
        "market": market,
        "universe": instruments,
        "train": clean_segments["train"],
        "valid_window": clean_segments["valid"],
        "test": clean_segments["test"],
        "seed": model_clean["seed"],
        "num_threads": 1,
        "feature_fields": [part.strip() for part in fields.split(",") if part.strip()],
        "record_classes": record_names,
        "config_sha256": fingerprint,
        "determinism_profile": "lightgbm-seeded-single-thread-v1",
    }
    output = YAML(typ="safe", pure=True)
    output.default_flow_style = False
    from io import StringIO
    buffer = StringIO()
    output.dump(runtime_cfg, buffer)
    return runtime_cfg, summary, buffer.getvalue()


def _canonical_value(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _canonical_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(v) for v in value]
    return value


def workflow_fingerprint(value: Any) -> str:
    """Return the stable SHA-256 of a normalized workflow mapping."""
    serializable = _canonical_value(value)
    return hashlib.sha256(json.dumps(serializable, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
