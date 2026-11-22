from __future__ import annotations

import pytest

from tac_qlib.workflows.rd_workflow_yaml import prepare_rd_workflow_yaml


VALID = '''
experiment_name: research-alpha
task:
  model:
    class: LGBModel
    module_path: qlib.contrib.model.gbdt
    kwargs:
      learning_rate: 0.05
      num_leaves: 15
  dataset:
    class: DatasetH
    module_path: qlib.data.dataset
    kwargs:
      handler:
        class: TACHandler
        module_path: tac_qlib.contrib.data.handler
        kwargs:
          instruments: SPY,QQQ
          start_time: 2020-01-01
          end_time: 2022-12-31
          fit_start_time: 2020-01-01
          fit_end_time: 2020-12-31
          freq: day
          market: US
          label: "Ref($close,-2)/Ref($close,-1)-1"
          feature_fields: "$open,$close,$volume"
          infer_processors:
            - class: DropAllNaN
              kwargs: {}
      segments:
        train: [2020-01-01, 2020-12-31]
        valid: [2021-01-01, 2021-12-31]
        test: [2022-01-01, 2022-12-31]
  record:
    - class: SignalRecord
      module_path: qlib.workflow.record_temp
      kwargs: {}
    - class: SigAnaRecord
      module_path: qlib.workflow.record_temp
      kwargs:
        ana_long_short: true
        ann_scaler: 252
'''


def prepare(text: str = VALID, expected: str | None = None):
    return prepare_rd_workflow_yaml(
        text,
        lake_root="/controlled/lake",
        expected_experiment_name=expected,
    )


def test_normalizes_known_workflow_and_injects_deterministic_host_owned_config():
    config, summary, serialized = prepare()
    model = config["task"]["model"]
    assert model["kwargs"]["seed"] == 2026
    assert model["kwargs"]["num_threads"] == 1
    assert model["kwargs"]["deterministic"] is True
    assert model["kwargs"]["force_col_wise"] is True
    assert model["kwargs"]["bagging_seed"] == 2026
    handler = config["task"]["dataset"]["kwargs"]["handler"]["kwargs"]
    assert handler["lake_root"] == "/controlled/lake"
    assert "lake_root" not in VALID
    assert config["qlib_init"]["provider_uri"] == "/controlled/lake"
    assert config["qlib_init"]["exp_manager"]["kwargs"]["uri"] == "sqlite:///mlruns.db"
    assert "DATABASE_URL" not in serialized
    assert "postgresql" not in serialized
    assert summary["experiment_name"] == "research-alpha"
    assert summary["num_threads"] == 1
    assert len(summary["config_sha256"]) == 64


def test_hash_and_normalized_yaml_are_stable():
    first = prepare()
    second = prepare()
    assert first[1]["config_sha256"] == second[1]["config_sha256"]
    assert first[2] == second[2]


@pytest.mark.parametrize(
    "bad, message",
    [
        (VALID + "\nqlib_init:\n  provider_uri: /tmp/lake\n", "unsupported key"),
        (VALID.replace("qlib.contrib.model.gbdt", "os"), "approved module"),
        (VALID.replace("class: LGBModel", "class: EvilModel"), "approved module"),
        (VALID.replace("num_leaves: 15", "num_leaves: 15\n      custom_command: cat /etc/passwd"), "unsupported key"),
        (VALID.replace("num_leaves: 15", "num_leaves: 15\n      num_threads: 8"), "fixed to 1"),
        (VALID.replace("fit_end_time: 2020-12-31", "fit_end_time: 2021-06-30"), "must not extend beyond the dataset train segment"),
        (VALID.replace("test: [2022-01-01, 2022-12-31]", "test: [2021-06-01, 2022-12-31]"), "non-overlapping"),
        (VALID.replace("SPY,QQQ", "../private"), "comma-separated list"),
        (VALID.replace("research-alpha", "{{ dangerous }}"), "template expressions"),
    ],
)
def test_rejects_unsafe_or_inconsistent_workflows(bad: str, message: str):
    with pytest.raises(ValueError, match=message):
        prepare(bad)


def test_rejects_mismatched_experiment_identity():
    with pytest.raises(ValueError, match="does not match"):
        prepare(expected="different-name")


def test_portfolio_record_uses_q_lib_symbol_list_for_exchange_codes():
    workflow = VALID.rstrip() + '''
    - class: PortAnaRecord
      module_path: qlib.workflow.record_temp
      kwargs:
        config:
          strategy:
            class: TopkDropoutStrategy
            module_path: qlib.contrib.strategy
            kwargs:
              signal: "<PRED>"
              topk: 2
              n_drop: 1
          backtest:
            start_time: 2022-01-01
            end_time: 2022-12-31
            exchange_kwargs:
              codes: [SPY, QQQ]
'''
    config, _summary, _serialized = prepare(workflow)
    codes = config["task"]["record"][2]["kwargs"]["config"]["backtest"]["exchange_kwargs"]["codes"]
    assert codes == ["SPY", "QQQ"]

    with pytest.raises(ValueError, match="'all' or a list of symbols"):
        prepare(workflow.replace("codes: [SPY, QQQ]", "codes: SPY,QQQ"))
    with pytest.raises(ValueError, match="inside dataset.segments.test"):
        prepare(workflow.replace("            end_time: 2022-12-31", "            end_time: 2023-01-01"))


def test_rejects_oversized_yaml():
    with pytest.raises(ValueError, match="128 KiB"):
        prepare(VALID + ("#" + "x" * (128 * 1024)))


def test_submitted_workflow_is_staged_privately_and_cleaned(tmp_path, monkeypatch):
    from pathlib import Path

    from tac_qlib import rd_server

    monkeypatch.setenv("TAC_LAKE_DIR", str(tmp_path))
    staged_path, summary = rd_server._prepare_submitted_workflow(VALID, "research-alpha")
    staged = Path(staged_path)
    assert staged.parent == tmp_path.resolve() / ".rd-workflow-tmp"
    assert staged.stat().st_mode & 0o777 == 0o600
    assert summary["experiment_name"] == "research-alpha"
    assert "DATABASE_URL" not in staged.read_text()

    rd_server._cleanup_submitted_workflow(staged_path)
    assert not staged.exists()


def test_yaml_run_dispatch_is_pathless_and_execution_mode_is_service_owned(tmp_path, monkeypatch):
    from tac_qlib import rd_server

    staged_path = tmp_path / "private.yaml"
    staged_path.write_text("normalized config")
    summary = {"experiment_name": "research-alpha", "config_sha256": "a" * 64,
               "determinism_profile": "lightgbm-seeded-single-thread-v1", "seed": 2026}
    calls = []
    monkeypatch.setattr(rd_server, "_prepare_submitted_workflow", lambda _yaml, _name: (str(staged_path), summary))
    monkeypatch.setattr(rd_server, "_spawn_subprocess_workflow", lambda path, name: calls.append((path, name)) or {"status": "started", "config_path": "/private/path", "pid": 123})

    result = rd_server.rd_run_workflow(config_yaml=VALID, experiment_name="research-alpha")
    assert calls == [(str(staged_path), "research-alpha")]
    assert result == {
        "status": "started", "background": True, "process_mode": "subprocess",
        "experiment_name": "research-alpha", "config_sha256": "a" * 64,
        "determinism_profile": "lightgbm-seeded-single-thread-v1", "seed": 2026,
        "note": "workflow submitted to an isolated Qlib worker; poll rd_exp_get_run or rd_exp_list for its persisted run",
    }
    with pytest.raises(ValueError, match="only config_yaml and experiment_name"):
        rd_server.rd_run_workflow(config_yaml=VALID, config_path="/tmp/attacker.yml", experiment_name="research-alpha")
    with pytest.raises(ValueError, match="only config_yaml and experiment_name"):
        rd_server.rd_run_workflow(config_yaml=VALID, experiment_name="research-alpha", run_in_new_process=True)
