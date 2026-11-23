import numpy as np
import pandas as pd
import pytest

from qlib.data.dataset import processor as processor_module

from tac_qlib.contrib.data.handler import TACCSRankNorm, TACCSZScoreNorm


def _frame(index, group="label"):
    columns = pd.MultiIndex.from_tuples(
        [(group, "LABEL0")], names=["group", "field"]
    )
    values = [1.0, 3.0, 2.0, 10.0, 14.0, 12.0]
    return pd.DataFrame(values, index=index, columns=columns)


@pytest.mark.parametrize(
    "index",
    [
        pd.Index(
            ["2020-01-01"] * 3 + ["2020-01-02"] * 3,
            name=None,
        ),
        pd.MultiIndex.from_tuples(
            [
                ("2020-01-01", "A"),
                ("2020-01-01", "B"),
                ("2020-01-01", "C"),
                ("2020-01-02", "A"),
                ("2020-01-02", "B"),
                ("2020-01-02", "C"),
            ],
            names=[None, None],
        ),
        pd.MultiIndex.from_tuples(
            [
                ("2020-01-01", "A"),
                ("2020-01-01", "B"),
                ("2020-01-01", "C"),
                ("2020-01-02", "A"),
                ("2020-01-02", "B"),
                ("2020-01-02", "C"),
            ],
            names=["datetime", "instrument"],
        ),
    ],
)
def test_cross_sectional_rank_groups_by_date_index_level(index):
    frame = _frame(index)

    if isinstance(index, pd.MultiIndex) and "datetime" in index.names:
        qlib_result = processor_module.CSRankNorm(fields_group="label")(frame)
    else:
        with pytest.raises(KeyError, match="datetime"):
            processor_module.CSRankNorm(fields_group="label")(frame)
        qlib_result = None

    result = TACCSRankNorm(fields_group="label")(frame)
    expected = np.array([1 / 3, 1.0, 2 / 3, 1 / 3, 1.0, 2 / 3])
    expected = (expected - 0.5) * 3.46
    np.testing.assert_allclose(result[("label", "LABEL0")].to_numpy(), expected)
    if qlib_result is not None:
        pd.testing.assert_frame_equal(result, qlib_result)


@pytest.mark.parametrize(
    "index",
    [
        pd.Index(
            ["2020-01-01"] * 3 + ["2020-01-02"] * 3,
            name=None,
        ),
        pd.MultiIndex.from_tuples(
            [
                ("2020-01-01", "A"),
                ("2020-01-01", "B"),
                ("2020-01-01", "C"),
                ("2020-01-02", "A"),
                ("2020-01-02", "B"),
                ("2020-01-02", "C"),
            ],
            names=[None, None],
        ),
        pd.MultiIndex.from_tuples(
            [
                ("2020-01-01", "A"),
                ("2020-01-01", "B"),
                ("2020-01-01", "C"),
                ("2020-01-02", "A"),
                ("2020-01-02", "B"),
                ("2020-01-02", "C"),
            ],
            names=["datetime", "instrument"],
        ),
    ],
)
def test_cross_sectional_zscore_groups_by_date_index_level(index):
    frame = _frame(index)

    if isinstance(index, pd.MultiIndex) and "datetime" in index.names:
        qlib_result = processor_module.CSZScoreNorm(fields_group="label")(frame)
    else:
        with pytest.raises(KeyError, match="datetime"):
            processor_module.CSZScoreNorm(fields_group="label")(frame)
        qlib_result = None

    result = TACCSZScoreNorm(fields_group="label")(frame)
    expected = np.array([-1.0, 1.0, 0.0, -1.0, 1.0, 0.0])
    np.testing.assert_allclose(result[("label", "LABEL0")].to_numpy(), expected)
    if qlib_result is not None:
        pd.testing.assert_frame_equal(result, qlib_result)


def test_tac_handler_default_learn_normalizer_uses_date_index_safe_processor():
    from tac_qlib.contrib.data.handler import DEFAULT_LEARN_PROCESSORS

    assert DEFAULT_LEARN_PROCESSORS[1] == {
        "class": "TACCSZScoreNorm",
        "module_path": "tac_qlib.contrib.data.handler",
        "kwargs": {"fields_group": "label"},
    }
