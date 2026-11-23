from io import StringIO

from ruamel.yaml import YAML

from tac_qlib.rd_explain import _workflow_yaml_from_config


def test_saved_run_yaml_is_cloneable_and_excludes_host_owned_settings():
    config = {
        "experiment_name": "alpha",
        "qlib_init": {"provider_uri": "/private/lake"},
        "rd_reproducibility": {"seed": 2026},
        "task": {
            "model": {"class": "RankICLGBModel", "kwargs": {"seed": 2026}},
            "dataset": {
                "class": "DatasetH",
                "kwargs": {
                    "handler": {
                        "class": "TACHandler",
                        "kwargs": {
                            "instruments": "SPY,QQQ",
                            "lake_root": "/private/lake",
                        },
                    },
                    "segments": {"train": ["2020-01-01", "2020-12-31"]},
                },
            },
            "record": [{"class": "SignalRecord"}, {"class": "SigAnaRecord"}],
        },
    }

    serialized = _workflow_yaml_from_config(config)
    restored = YAML(typ="safe", pure=True).load(StringIO(serialized))

    assert restored["experiment_name"] == "alpha"
    assert restored["task"]["dataset"]["kwargs"]["handler"]["kwargs"] == {
        "instruments": "SPY,QQQ"
    }
    assert "qlib_init" not in restored
    assert "rd_reproducibility" not in restored
