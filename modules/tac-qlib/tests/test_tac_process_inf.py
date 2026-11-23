from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from qlib.data.dataset.processor import ProcessInf

from tac_qlib.contrib.data.handler import TACProcessInf


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
