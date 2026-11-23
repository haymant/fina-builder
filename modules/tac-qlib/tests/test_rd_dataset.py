"""Deterministic coverage for the service-owned rd_exp_dataset contract."""

from __future__ import annotations

import pickle
import importlib
from pathlib import Path

import pandas as pd
import pytest

from tac_qlib import rd_explain


class _Store:
    art_root = Path("/unused")

    def close(self):
        pass


@pytest.fixture
def dataset_fixture(tmp_path, monkeypatch):
    run_id = "run-fixture"
    experiment_id = "7"
    artifact_root = tmp_path / "mlruns"
    config_root = artifact_root / experiment_id / run_id / "artifacts"
    config_root.mkdir(parents=True)
    config = {
        "qlib_init": {"provider_uri": str(tmp_path / "lake"), "region": "US"},
        "task": {
            "dataset": {
                "kwargs": {
                    "handler": {
                        "kwargs": {
                            "instruments": ["AAPL", "MSFT"],
                            "feature_fields": ["$close", "$volume"],
                            "freq": "day",
                        }
                    },
                    "segments": {
                        "train": ["2026-01-01", "2026-01-04"],
                        "valid": ["2026-01-05", "2026-01-06"],
                        "test": ["2026-01-07", "2026-01-08"],
                    },
                }
            },
            "record": [
                {
                    "class": "PortAnaRecord",
                    "kwargs": {"config": {"backtest": {"start_time": "2026-02-01", "end_time": "2026-02-03"}}},
                }
            ],
        },
    }
    with (config_root / "config").open("wb") as handle:
        pickle.dump(config, handle)

    frame = pd.DataFrame(
        [
            {"date": "2026-01-03", "instrument": "AAPL", "$close": 13.0, "$volume": 130.0, "label": 0.3},
            {"date": "2026-01-01", "instrument": "AAPL", "$close": 11.0, "$volume": 110.0, "label": 0.1},
            {"date": "2026-01-02", "instrument": "AAPL", "$close": 12.0, "$volume": 120.0, "label": 0.2},
            {"date": "2026-01-01", "instrument": "MSFT", "$close": 21.0, "$volume": 210.0, "label": 0.4},
        ]
    )

    class FakeDatasetH:
        def __init__(self, *, handler, segments):
            self.segments = segments

        def prepare(self, group, col_set, data_key):
            return frame.copy()

    class FakeHandler:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    monkeypatch.setattr(rd_explain, "_open_store", lambda uri: _Store())
    monkeypatch.setattr(rd_explain, "_run_meta", lambda store, run: {"experiment_id": experiment_id})
    monkeypatch.setattr(rd_explain, "_artifact_root_for_run", lambda store, exp, run: artifact_root)
    # The operation imports these symbols at call time, so patch their owning modules.
    from qlib.data import dataset as qlib_dataset
    from tac_qlib.contrib.data import handler as tac_handler
    qlib_init_module = importlib.import_module("tac_qlib.qlib_init")

    monkeypatch.setattr(qlib_dataset, "DatasetH", FakeDatasetH)
    monkeypatch.setattr(tac_handler, "TACHandler", FakeHandler)
    monkeypatch.setattr(qlib_init_module, "qlib_init", lambda **kwargs: None)
    return run_id, experiment_id


def test_dataset_paginates_and_sorts_train_rows(dataset_fixture):
    run_id, experiment_id = dataset_fixture
    result = rd_explain.rd_exp_dataset(run_id, experiment_id=experiment_id, group="train", instrument="AAPL", page=2, page_size=2, sort="asc")

    assert result["columns"] == ["date", "instrument", "$close", "$volume", "label"]
    assert result["total"] == 3
    assert result["has_next"] is False
    assert [row["date"] for row in result["rows"]] == ["2026-01-03T00:00:00"]
    assert result["rows"][0]["label"] == 0.3


def test_dataset_descending_and_backtest_deal_price(dataset_fixture):
    run_id, experiment_id = dataset_fixture
    result = rd_explain.rd_exp_dataset(run_id, experiment_id=experiment_id, group="backtest", instrument="AAPL", sort="desc")

    assert result["sort"] == "desc"
    assert result["columns"] == ["date", "instrument", "$close", "$volume", "deal_price"]
    assert result["rows"][0]["deal_price"] == 13.0
    assert "label" not in result["rows"][0]


def test_dataset_rejects_unknown_instrument_and_missing_config(tmp_path, monkeypatch):
    monkeypatch.setattr(rd_explain, "_open_store", lambda uri: _Store())
    monkeypatch.setattr(rd_explain, "_run_meta", lambda store, run: {"experiment_id": 7})
    monkeypatch.setattr(rd_explain, "_artifact_root_for_run", lambda store, exp, run: tmp_path)

    with pytest.raises(ValueError, match="config artifact missing"):
        rd_explain.rd_exp_dataset("run", experiment_id="7", instrument="AAPL")

    config_root = tmp_path / "7" / "run" / "artifacts"
    config_root.mkdir(parents=True)
    with (config_root / "config").open("wb") as handle:
        pickle.dump({"qlib_init": {"provider_uri": str(tmp_path / "lake")}, "task": {"dataset": {"kwargs": {"handler": {"kwargs": {"instruments": ["MSFT"]}}}}}}, handle)
    with pytest.raises(ValueError, match="is not in the run dataset universe"):
        rd_explain.rd_exp_dataset("run", experiment_id="7", instrument="AAPL")
