#!/usr/bin/env python
"""Pre-flight validator for qlib workflow YAMLs (no training, no data access).

Replicates what _rd_run_workflow_impl does up to instantiation:
  render jinja -> YAML parse -> structure checks -> import checks.

Catches the two failure modes that historically slipped through to run time:
  1. `record:` at top level instead of nested under `task:` (silently dropped).
  2. Nonexistent model/dataset/record/strategy module paths (ModuleNotFoundError
     mid-run, after minutes of training).

Usage:
  .venv/bin/python tac_qlib/workflows/validate_workflow.py <config.yaml> [more.yaml ...]

Exit code 0 = all configs valid; 1 = any error.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

RECORD_CLASSES = {"SignalRecord", "SigAnaRecord", "PortAnaRecord", "RecordTemp"}


def _import_class(module_path: str, class_name: str) -> str | None:
    try:
        mod = importlib.import_module(module_path)
        getattr(mod, class_name)
        return None
    except Exception as exc:  # noqa: BLE001 - report any import failure verbatim
        return f"{module_path}.{class_name}: {type(exc).__name__}: {exc}"


def validate(path: Path) -> list[str]:
    errors: list[str] = []
    from qlib.cli.run import render_template
    from ruamel.yaml import YAML

    rendered = render_template(str(path))
    cfg = YAML(typ="safe", pure=True).load(rendered)
    if not isinstance(cfg, dict):
        return [f"{path}: parsed config is {type(cfg).__name__}, expected mapping"]

    # --- structure -----------------------------------------------------------
    task = cfg.get("task")
    if not isinstance(task, dict):
        return [f"{path}: missing top-level 'task' mapping (got {type(task).__name__})"]
    if "record" in cfg and "record" not in task:
        errors.append(
            f"{path}: top-level 'record:' found but NOT nested under 'task:' — "
            "qlib drops unknown top-level keys; move it under task:"
        )
    for key in ("model", "dataset"):
        if not isinstance(task.get(key), dict):
            errors.append(f"{path}: task.{key} missing or not a mapping")
    records = task.get("record")
    if not isinstance(records, list) or not records:
        errors.append(f"{path}: task.record missing/empty — run would finish with NO metrics")

    # --- qlib_init sanity (tradeac-owned mirror of upstream Config.validate) --
    qi = cfg.get("qlib_init")
    if qi is None:
        errors.append(f"{path}: top-level 'qlib_init:' missing — run would qlib.init({{}}) and crash")
    elif not isinstance(qi, dict):
        errors.append(f"{path}: qlib_init is {type(qi).__name__}, expected mapping")
    else:
        if not str(qi.get("provider_uri") or "").strip():
            errors.append(f"{path}: qlib_init.provider_uri must be set (e.g. '{{{{ LAKE }}}}')")
        if not str(qi.get("region") or "").strip():
            errors.append(f"{path}: qlib_init.region must be specified (e.g. 'us')")

    # --- import checks (would-have-failed-at-runtime classes) ----------------
    def check_instance(spec: dict, where: str) -> None:
        if not isinstance(spec, dict):
            errors.append(f"{path}: {where} is not a mapping")
            return
        mp, cn = spec.get("module_path"), spec.get("class")
        if not mp or not cn:
            errors.append(f"{path}: {where} needs 'class' and 'module_path'")
            return
        err = _import_class(mp, cn)
        if err:
            errors.append(f"{path}: {where} -> {err}")

    if isinstance(task.get("model"), dict):
        check_instance(task["model"], "task.model")
    ds = task.get("dataset") or {}
    check_instance(ds, "task.dataset")
    handler = (ds.get("kwargs") or {}).get("handler")
    if isinstance(handler, dict):
        check_instance(handler, "task.dataset.kwargs.handler")
    if isinstance(records, list):
        for i, rec in enumerate(records):
            check_instance(rec, f"task.record[{i}]")
            if isinstance(rec, dict) and rec.get("class") not in RECORD_CLASSES:
                errors.append(f"{path}: task.record[{i}].class {rec.get('class')!r} not in {sorted(RECORD_CLASSES)}")
            strat = ((rec or {}).get("kwargs") or {}).get("config", {}).get("strategy")
            if isinstance(rec, dict) and rec.get("class") == "PortAnaRecord":
                if not isinstance(strat, dict):
                    errors.append(f"{path}: PortAnaRecord kwargs.config.strategy missing")
                else:
                    check_instance(strat, f"task.record[{i}].strategy")

    # --- segments / backtest sanity ------------------------------------------
    segs = ((ds.get("kwargs") or {}).get("segments")) or {}
    for s in ("train", "valid", "test"):
        if s not in segs:
            errors.append(f"{path}: dataset segments.{s} missing")
    if isinstance(records, list):
        for rec in records:
            if isinstance(rec, dict) and rec.get("class") == "PortAnaRecord":
                bt = ((rec.get("kwargs") or {}).get("config") or {}).get("backtest") or {}
                if not bt.get("benchmark"):
                    errors.append(f"{path}: backtest.benchmark missing")
                if not str(bt.get("codes", "")).strip() and not (
                    isinstance(bt.get("exchange_kwargs"), dict) and bt["exchange_kwargs"].get("codes")
                ):
                    errors.append(f"{path}: backtest codes/exchange_kwargs.codes missing")
    return errors


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    failed = False
    for arg in argv:
        p = Path(arg).expanduser()
        errs = validate(p)
        if errs:
            failed = True
            print(f"FAIL {p}")
            for e in errs:
                print(f"  - {e}")
        else:
            print(f"OK   {p}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
