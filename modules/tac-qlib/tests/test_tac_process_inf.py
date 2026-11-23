from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from qlib.data.dataset.processor import ProcessInf, ZScoreNorm

from tac_qlib.contrib.data.handler import (
    DEFAULT_INFER_PROCESSORS,
    TACProcessInf,
    TACZScoreNorm,
    check_transform_proc,
)


def test_process_inf_handles_plain_string_datetime_index_level():
    index = pd.MultiIndex.from_arrays(
        [
            ["2026-01-02", "2026-01-02", "2026-01-02", "2026-01-05"],
            ["AAA", "BBB", "CCC", "AAA"],
        ],
        names=["datetime", "instrument"],
    )
    frame = pd.DataFrame(
        {"feature": [1.0, np.inf, 3.0, -np.inf]},
        index=index,
    )

    with pytest.raises(TypeError, match="Only valid with DatetimeIndex"):
        ProcessInf()(frame)

    result = TACProcessInf()(frame)

    assert result.index.equals(frame.sort_index().index)
    assert result.loc[("2026-01-02", "BBB"), "feature"] == 2.0
    assert np.isnan(result.loc[("2026-01-05", "AAA"), "feature"])


def test_zscore_fit_supports_single_level_datetime_index():
    frame = pd.DataFrame(
        {"feature": [1.0, 3.0, 100.0]},
        index=pd.Index(["2020-01-01", "2020-01-02", "2021-01-01"], name="datetime"),
    )

    with pytest.raises(KeyError, match=r"slice\('2020-01-01'"):
        ZScoreNorm("2020-01-01", "2020-01-02").fit(frame)

    processor = TACZScoreNorm("2020-01-01", "2020-01-02")
    processor.fit(frame)

    assert processor.mean_train.tolist() == [2.0]
    assert processor.std_train.tolist() == [1.0]
    assert processor(frame).loc["2021-01-01", "feature"] == 98.0


def test_process_inf_groups_single_level_datetime_index_by_date():
    frame = pd.DataFrame(
        {"feature": [1.0, np.inf, 3.0, -np.inf]},
        index=pd.Index(
            ["2026-01-02", "2026-01-02", "2026-01-05", "2026-01-05"],
            name="datetime",
        ),
    )

    result = TACProcessInf()(frame)

    assert result.loc["2026-01-02", "feature"].tolist() == [1.0, 1.0]
    assert result.loc["2026-01-05", "feature"].tolist() == [3.0, 3.0]


def test_default_inference_processors_use_fit_window_compatible_tac_zscore():
    processors = check_transform_proc(
        DEFAULT_INFER_PROCESSORS,
        fit_start_time="2020-01-01",
        fit_end_time="2020-12-31",
    )

    assert processors[2] == {
        "class": "TACZScoreNorm",
        "module_path": "tac_qlib.contrib.data.handler",
        "kwargs": {
            "fit_start_time": "2020-01-01",
            "fit_end_time": "2020-12-31",
        },
    }
