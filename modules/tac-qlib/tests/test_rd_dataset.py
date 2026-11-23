"""Deterministic coverage for the service-owned rd_exp_dataset contract."""

from __future__ import annotations

import importlib
import pickle
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

    raw_frame = pd.DataFrame(
        [
            {"date": "2026-01-03", "instrument": "AAPL", "$close": 13.0, "$volume": 130.0, "label": 0.3},
            {"date": "2026-01-01", "instrument": "AAPL", "$close": 11.0, "$volume": 110.0, "label": 0.1},
            {"date": "2026-01-02", "instrument": "AAPL", "$close": 12.0, "$volume": 120.0, "label": 0.2},
            {"date": "2026-01-01", "instrument": "MSFT", "$close": 21.0, "$volume": 210.0, "label": 0.4},
            # In-universe rows outside the selected train segment must not leak in.
            {"date": "2026-01-05", "instrument": "AAPL", "$close": 15.0, "$volume": 150.0, "label": 0.5},
            {"date": "2026-02-01", "instrument": "AAPL", "$close": 41.0, "$volume": 410.0, "label": 0.6},
            {"date": "2026-02-02", "instrument": "AAPL", "$close": 42.0, "$volume": 420.0, "label": 0.7},
            {"date": "2026-02-03", "instrument": "AAPL", "$close": 43.0, "$volume": 430.0, "label": 0.8},
        ]
    )
    inference_frame = raw_frame.copy()
    inference_frame["$close"] = [0.333333, -1.0, 1.0, 0.25, 1.0, -0.5, 0.5, 1.0]
    inference_frame["$volume"] = [-1.0, 0.5, 1.0, -0.5, 1.0, -1.0, 0.5, 1.0]
    calls = []

    class FakeDatasetH:
        def __init__(self, *, handler, segments):
            self.segments = segments

        def prepare(self, group, col_set, data_key):
            calls.append({"group": group, "col_set": col_set, "data_key": data_key, "segment": self.segments[group]})
            frame = (raw_frame if data_key == "raw" else inference_frame).copy()
            start, end = (pd.Timestamp(value) for value in self.segments[group])
            dates = pd.to_datetime(frame["date"])
            return frame.loc[(dates >= start) & (dates <= end)].copy()

    class FakeHandler:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    monkeypatch.setattr(rd_explain, "_open_store", lambda uri: _Store())
    monkeypatch.setattr(rd_explain, "_run_meta", lambda store, run: {"experiment_id": experiment_id})
    monkeypatch.setattr(rd_explain, "_artifact_root_for_run", lambda store, exp, run: artifact_root)
    from qlib.data import dataset as qlib_dataset
    from tac_qlib.contrib.data import handler as tac_handler

    qlib_init_module = importlib.import_module("tac_qlib.qlib_init")
    monkeypatch.setattr(qlib_dataset, "DatasetH", FakeDatasetH)
    monkeypatch.setattr(tac_handler, "TACHandler", FakeHandler)
    monkeypatch.setattr(qlib_init_module, "qlib_init", lambda **kwargs: None)
    return run_id, experiment_id, calls


def test_dataset_uses_persisted_train_segment_filters_instrument_and_paginates(dataset_fixture):
    run_id, experiment_id, calls = dataset_fixture
    result = rd_explain.rd_exp_dataset(
        run_id, experiment_id=experiment_id, group="train", instrument="AAPL", page=2, page_size=2, sort="asc"
    )

    assert result["columns"] == ["date", "instrument", "$close", "$volume", "label"]
    assert result["total"] == 3
    assert result["has_next"] is False
    assert [row["date"] for row in result["rows"]] == ["2026-01-03T00:00:00"]
    assert result["rows"][0]["label"] == 0.3
    assert result["representation"] == "raw"
    assert result["data_key"] == "raw"
    assert result["provenance"]["requested_segment"] == ["2026-01-01", "2026-01-04"]
    assert result["provenance"]["observed_range"] == ["2026-01-01", "2026-01-03"]
    assert calls[-1] == {
        "group": "train", "col_set": ["feature", "label"], "data_key": "raw", "segment": ("2026-01-01", "2026-01-04")
    }


def test_dataset_can_explicitly_return_inference_processed_features_without_rounding(dataset_fixture):
    run_id, experiment_id, calls = dataset_fixture
    result = rd_explain.rd_exp_dataset(
        run_id, experiment_id=experiment_id, group="train", instrument="AAPL", representation="inference"
    )

    first_row = next(row for row in result["rows"] if row["date"].startswith("2026-01-03"))
    assert result["representation"] == "inference"
    assert result["data_key"] == "infer"
    assert first_row["$close"] == pytest.approx(0.333333)
    assert calls[-1]["data_key"] == "infer"


def test_dataset_descending_and_backtest_deal_price_use_saved_backtest_window(dataset_fixture):
    run_id, experiment_id, calls = dataset_fixture
    result = rd_explain.rd_exp_dataset(run_id, experiment_id=experiment_id, group="backtest", instrument="AAPL", sort="desc")

    assert result["sort"] == "desc"
    assert result["columns"] == ["date", "instrument", "$close", "$volume", "deal_price"]
    assert result["rows"][0]["date"].startswith("2026-02-03")
    assert result["rows"][0]["deal_price"] == 43.0
    assert result["provenance"]["requested_segment"] == ["2026-02-01", "2026-02-03"]
    assert calls[-1]["segment"] == ("2026-02-01", "2026-02-03")
    assert "label" not in result["rows"][0]


def test_dataset_rejects_unknown_representation(dataset_fixture):
    run_id, experiment_id, _calls = dataset_fixture
    with pytest.raises(ValueError, match="representation must be raw or inference"):
        rd_explain.rd_exp_dataset(run_id, experiment_id=experiment_id, instrument="AAPL", representation="learn")


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
