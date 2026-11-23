"""Smoke tests: qlib against the TradeAC lake (plain asserts, no pytest needed).

Run::

    .venv/bin/python tests/test_lake_providers.py
"""

import os
import sys

import numpy as np
import pandas as pd

try:
    import pytest
except ImportError:  # pragma: no cover - direct script mode
    pytest = None

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# TAC_LAKE_DIR is mandatory for real-lake coverage. The default checkout keeps
# this suite collection-safe and reports the missing optional fixture clearly.
LAKE_ROOT = os.environ.get("TAC_LAKE_DIR")
if not LAKE_ROOT:
    if pytest is not None:
        pytest.skip("TAC_LAKE_DIR is required for lake-provider coverage", allow_module_level=True)
    raise RuntimeError("TAC_LAKE_DIR is required for lake-provider coverage")


def main():
    from tac_qlib.qlib_init import qlib_init

    qlib_init(provider_uri=LAKE_ROOT, market="US", freq="day", log_level="WARN")

    from qlib.data import D
    from qlib.data.data import Cal, ExpressionD, Inst, DatasetD

    # ---- calendar ---------------------------------------------------------
    cal = Cal.calendar(freq="day")
    assert isinstance(cal, (list, np.ndarray)) and len(cal) >= 100, f"calendar too small: {len(cal)}"
    print(f"[ok] calendar: {len(cal)} trading days, {pd.Timestamp(cal[0]).date()} -> {pd.Timestamp(cal[-1]).date()}")

    # ---- instruments ------------------------------------------------------
    inst = Inst.list_instruments({"market": "all"}, start_time=cal[0], end_time=cal[-1], freq="day")
    assert len(inst) >= 5, f"expected >=5 instruments, got {inst}"
    print(f"[ok] instruments: {sorted(inst)}")

    # ---- raw features -----------------------------------------------------
    start, end = "2026-03-01", "2026-06-30"
    df = D.features(sorted(inst)[:4], ["$close", "$volume", "$vwap"], start, end, freq="day")
    assert not df.empty
    assert df.columns.tolist() == ["$close", "$volume", "$vwap"]
    assert not df["$close"].isna().all()
    from tac_qlib.data.providers import LakeFeatureProvider
    deduped = LakeFeatureProvider._series(
        pd.Series([1.0, 2.0, 3.0]),
        pd.Index([pd.Timestamp("2026-01-02").date(), pd.Timestamp("2026-01-02").date(), pd.Timestamp("2026-01-05").date()]),
    )
    assert deduped.index.is_unique and deduped.loc[pd.Timestamp("2026-01-02").date()] == 2.0
    # index must be the (datetime, instrument) MultiIndex, sorted
    assert isinstance(df.index, pd.MultiIndex)
    assert df.index.names == [df.index.names[0], df.index.names[1]]
    n_rows = len(df)
    print(f"[ok] D.features: {len(df)} rows x {len(df.columns)} cols; close sample:\n{df['$close'].head(3)}")

    # NaN for fields the lake does not store
    df_unk = D.features(sorted(inst)[:2], ["$factor", "$change"], start, end, freq="day")
    assert df_unk["$factor"].isna().all() and df_unk["$change"].isna().all()
    print("[ok] unknown fields ($factor/$change) are all-NaN")

    # ---- expression engine (Option A / qlib defaults) ---------------------
    exp = "Ref($close,-2)/$close-1"  # same default label as Alpha158
    sym = sorted(inst)[0]  # use a symbol that is actually in the lake
    s = ExpressionD.expression(sym, exp, start_time=start, end_time=end, freq="day")
    assert isinstance(s, pd.Series) and len(s) > 0
    assert s.notna().any()
    print(f"[ok] ExpressionD.expression: {len(s)} values, sample:\n{s.head(3)}")

    # a full dataset can be materialised through the expression engine
    df_ds = DatasetD.dataset(sorted(inst), [exp], start, end, freq="day")
    assert isinstance(df_ds, pd.DataFrame) and len(df_ds) > 0
    print(f"[ok] DatasetD.dataset: {df_ds.shape}")

    # ---- TACHandler: feature discovery + DropAllNaN ------------------------
    from tac_qlib.contrib.data.handler import TACHandler

    h = TACHandler(
        instruments=sorted(inst)[:6],
        start_time="2026-03-01",
        end_time="2026-08-06",
        fit_start_time="2026-03-01",
        fit_end_time="2026-05-31",
        freq="day",
        lake_root=LAKE_ROOT,
        market="US",
    )
    # the lake's stoch_* columns are fully NaN -> they must be dropped by DropAllNaN
    assert not any("stoch" in str(c) for c in h._infer.columns), h._infer.columns.tolist()
    # train/valid/test must expose identical feature columns
    from qlib.data.dataset import DatasetH
    from qlib.data.dataset.handler import DataHandlerLP

    ds = DatasetH(
        handler=h,
        segments={
            "train": ("2026-03-01", "2026-05-31"),
            "valid": ("2026-06-01", "2026-06-30"),
            "test": ("2026-07-01", "2026-08-06"),
        },
    )
    cols = {
        seg: ds.prepare(segments=seg, col_set="feature", data_key=DataHandlerLP.DK_I).columns.tolist()
        for seg in ("train", "valid", "test")
    }
    assert cols["train"] == cols["valid"] == cols["test"], cols
    print(f"[ok] TACHandler: {len(cols['train'])} features, stoch dropped, segments aligned")

    print("\nALL LAKE PROVIDER CHECKS PASSED")


if __name__ == "__main__":
    main()
