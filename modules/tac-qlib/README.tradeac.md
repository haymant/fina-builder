# tac-qlib

Run stock [qlib](https://github.com/microsoft/qlib) ML workflows (LightGBM → signal → backtest) directly on the
TradeAC parquet lake. No CSV/bin dump, no data conversion: the lake's calendar, instrument master, OHLCV bars and
pre-computed ta-lib features plug into qlib as first-class data providers, and a custom `DataHandlerLP`
(`TACHandler`) exposes them through the normal qlib dataset/processor pipeline.

```
$ qrun workflows/workflow_lgb_taclake.yaml --experiment_name tac-lake-lgb
```

trains a LightGBM, records predictions/labels, evaluates the signal (IC/RankIC), runs a daily
`TopkDropoutStrategy` backtest with cost model and risk analysis, and logs everything to mlflow (sqlite).

## Layout

```
tac-qlib/
├── tac_qlib/
│   ├── qlib_init.py                  # qlib_init() drop-in wired to the lake providers
│   ├── data/
│   │   ├── config.py                 # LakeConfig: paths + metadata readers, freq↔timeframe map
│   │   └── providers.py              # LakeCalendarProvider / LakeInstrumentProvider / LakeFeatureProvider
│   └── contrib/data/
│       └── handler.py                # TACHandler (DataHandlerLP) + DropAllNaN processor
├── workflows/
│   └── workflow_lgb_taclake.yaml     # qrun workflow: train -> signal -> backtest
├── examples/
│   └── run_backtest.py               # same loop as the workflow, plain Python (no yaml)
└── tests/
    └── test_lake_providers.py        # plain-assert smoke tests
```

## Requirements / install

- Python 3.12, `qlib` nightly (`0.1.dev2066` in the repo venv), pandas/pyarrow, lightgbm.
- The TradeAC lake (see below). `TAC_LAKE_DIR` is **mandatory** (no default) — set it to the
  lake root, or pass the `lake_root` kwargs.

## The lake (data layout)

```
$TAC_LAKE_DIR/
├── market=US/
│   └── timeframe=1d/
│       └── symbol=AAPL.parquet        # OHLCV bars: t, date, o, h, l, c, v, n, vw
├── features/
│   └── market=US/timeframe=1d/
│       └── symbol=AAPL.parquet        # ta-lib indicators, wide format: t, sma_5, rsi_14, ...
├── calendar.parquet                   # trading days per market
├── coverage.parquet                   # per (market,timeframe,symbol) loaded windows
└── symbols.parquet                    # asset master
```

Field routing (`tac_qlib/data/config.py`):

- `$open $high $low $close $volume $vwap` → bar parquet columns; `$amount` = `v * vw`, `$avg_amount` = `vw`.
- `$factor $change $trade_unit $suspend_flag` → all-NaN (not stored; the backtest Exchange only needs `$close`).
- anything else (e.g. `$rsi_14`, `$sma_20`) → a ta-lib column in the features parquet.

## Step 1 — Prepare data

The lake is populated and backfilled with the tac-engine MCP lake tools (see
`tac-engine/skills/tradeac-lake`). Typical sequence:

1. Seed the trading calendar from historical auctions (so the 1d completeness check has an expected day set):
   `backfill_lake_calendar(symbols="AAPL,MSFT,...")`.
2. Backfill bars: `get_lake_bars(symbols="AAPL,MSFT,...", timeframe="1d", start="2026-02-09")` (lazy: missing
   windows are fetched from Alpaca and persisted; `sip`/`iex` auto-fallback on 403).
3. Persist features: `get_lake_ta(symbol="AAPL", timeframe="1d", indicators="sma_5,sma_20,rsi_14,macd,bb,atr_14", persist=true)`.
   Only indicators that exist in *every* features file are auto-loaded by the handler; add columns per symbol by
   re-running `get_lake_ta`.
4. `get_lake_symbols` / `get_lake_coverage` to verify the universe and loaded windows.

`TACHandler` discovers the feature columns itself (`get_common_feature_fields` = the intersection of columns
across all features files), so no config change is needed as the lake grows.

## Step 2 — Preprocess

Preprocessing happens in `TACHandler` (a `DataHandlerLP`), composed from standard qlib processors:

- **infer** (`DEFAULT_INFER_PROCESSORS`), applied to the input features:
  1. `DropAllNaN` — drops columns that are all-NaN over the fit window (fixes the lake's fully-empty ta-lib
     columns, e.g. a `stoch_*` output that is NaN from the start). The drop set is fixed in `fit()` and applied
     identically to train/valid/test so feature columns never diverge.
  2. `ProcessInf`, `ZScoreNorm` (fit on the fit window), `Fillna`.
- **learn** (`DEFAULT_LEARN_PROCESSORS`), applied to the label: `DropnaLabel`, `CSZScoreNorm`.

Handler kwargs (used by both the workflow yaml and the Python API):

| kwarg | default | meaning |
|---|---|---|
| `instruments` | `all` | universe; list, `all`, or a named pool from `markets:` |
| `start_time` / `end_time` | – | queried window (must be within the lake calendar) |
| `fit_start_time` / `fit_end_time` | start/end | window the fit-able processors (ZScoreNorm, DropAllNaN) fit on |
| `freq` | `day` | maps to the lake timeframe (`day`→`1d`, `1min`→`1m`, …) |
| `feature_fields` | auto | raw OHLCV + common ta-lib columns; or an explicit list |
| `label` | `Ref($close,-2)/Ref($close,-1)-1` | qlib expression for the target |
| `lake_root` / `market` | `$TAC_LAKE_DIR` / `US` | lake location (required) / market partition |

Only daily (`1d`) is currently supported by the calendar provider; intraday freq raises `NotImplementedError`.

## Step 3 — Train

Either write the model task in yaml and run qrun (see *Glue with qrun*), or train in Python:

```python
from qlib.data.dataset import DatasetH
from tac_qlib.qlib_init import qlib_init
from tac_qlib.contrib.data.handler import TACHandler
from qlib.contrib.model.gbdt import LGBModel
from qlib.workflow import R

qlib_init(provider_uri=os.environ["TAC_LAKE_DIR"], market="US", freq="day")

handler = TACHandler(
    instruments="all",
    start_time="2026-03-01", end_time="2026-08-06",
    fit_start_time="2026-03-01", fit_end_time="2026-05-31",
    freq="day", lake_root=os.environ["TAC_LAKE_DIR"], market="US",
)
dataset = DatasetH(handler=handler, segments={
    "train": ("2026-03-01", "2026-05-31"),
    "valid": ("2026-06-01", "2026-06-30"),
    "test":  ("2026-07-01", "2026-08-06"),
})

model = LGBModel(n_estimators=200, learning_rate=0.05, num_leaves=15, ...)
with R.start(experiment_name="tac-lake-demo"):
    model.fit(dataset)                 # trains on the train segment
```

## Step 4 — Test / evaluate the signal

`model.predict(dataset)` returns the prediction on the **test** segment (a `(datetime, instrument)` Series).
Evaluate it with qlib's `SigAnaRecord` / `sig_analysis`:

```python
from qlib.workflow.record_temp import SigAnaRecord
from qlib.contrib.evaluate import signal_analysis

pred = model.predict(dataset)                     # "score" column
label = dataset.prepare("test", col_set="label", data_key=DataHandlerLP.DK_I)["LABEL0"]
# per-day + overall IC / ICIR / RankIC / RankICIR
report = signal_analysis(pred, label)
```

In the workflow this is automatic (`SigAnaRecord`): the run logs IC 0.0072 / ICIR 0.016 /
RankIC 0.0138 / RankICIR 0.034 for the default split — weak but the plumbing is verified.

## Step 5 — Backtesting

```python
from qlib.contrib.evaluate import backtest_daily, risk_analysis
from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

strategy = TopkDropoutStrategy(signal=pred, topk=2, n_drop=1, only_tradable=True, risk_degree=0.95)
report_normal, positions_normal = backtest_daily(
    start_time="2026-07-01", end_time="2026-08-06",
    strategy=strategy, account=1_000_000, benchmark=None,   # lake has no index quotes
    exchange_kwargs={"codes": universe, "deal_price": "$close", "freq": "day",
                     "open_cost": 0.0005, "close_cost": 0.0015, "min_cost": 5.0},
)
risk = risk_analysis(report_normal["return"], freq="day")
```

- `TopkDropoutStrategy` is the default mapping *prediction → positions* (hold top-k, drop `n_drop` per day).
  For other sizing frameworks — equal/score-weighting, softmax, z-score, fractional Kelly, mean-variance —
  subclass `qlib.contrib.strategy.SignalStrategy` and implement `generate_trade_decision` (see
  `../.tmp/signalTrade.md` for the recipe catalogue).
- The Exchange needs `$close`; other fields the backtest probes (`$factor`, `$trade_unit`) are all-NaN and fine.
- Benchmark: pick any symbol the lake holds (e.g. `benchmark: AAPL`); null benchmark triggers benign
  "Mean of empty slice" warnings from the risk analysis.

## Step 6 — Predict

`SignalRecord` already saved `pred.pkl` (test segment) during the qrun run. For predictions on arbitrary data:

```python
pred = model.predict(dataset)                       # predict on the "test" segment
pred.to_frame("score").to_pickle("pred.pkl")        # (datetime, instrument) x ["score"]
```

To predict a live/rolling window instead of the configured test segment, point a handler's `segments["test"]`
at the window of interest, or call `model.predict(dataset, segment="test")` after overriding the segment.

## Glue everything with qrun

`workflows/workflow_lgb_taclake.yaml` wires the whole chain (init → train → signal record → signal analysis →
backtest + risk analysis) into one qrun invocation:

```bash
cd tac-qlib
qrun workflows/workflow_lgb_taclake.yaml --experiment_name tac-lake-lgb
# custom lake root:
TAC_LAKE_DIR=/path/to/lake qrun workflows/workflow_lgb_taclake.yaml --experiment_name tac-lake-lgb
```

YAML anatomy:

- `qlib_init` — points `provider_uri` at the lake and installs the lake providers by their full class paths
  (`tac_qlib.data.providers.Lake*Provider`), plus an `exp_manager` backed by `sqlite:///<lake>/mlruns.db`
  (avoids mlflow's filesystem-backend maintenance-mode opt-in). The unified R&D store lives under the lake
  root: `mlruns.db` + `mlruns/<exp>/<run>/`. Override the tracking URI with `MLRUNS_URI`.
- `task.model` — `LGBModel` hyperparameters.
- `task.dataset` — `DatasetH` over `TACHandler`; `segments.train/valid/test` split the window;
  `fit_start_time`/`fit_end_time` pin the processor fit window to train.
- `task.record` — ordered records:
  1. `SignalRecord` → writes `pred.pkl` (and `label.pkl`).
  2. `SigAnaRecord` → `sig_analysis/{ic,ric}.pkl` (IC/ICIR/RankIC/RankICIR).
  3. `PortAnaRecord` → daily `TopkDropoutStrategy` backtest + `risk_analysis_freq: 1d` →
     `portfolio_analysis/*.pkl` (report, positions, indicators, risk metrics, benchmark & cost-adjusted excess returns).

Run artifacts land under the mlflow run: `<lake>/mlruns/<exp>/<run>/artifacts/*.pkl` (metadata in `<lake>/mlruns.db`).

Template notes:

- The header uses jinja2 (`{%- set LAKE = TAC_LAKE_DIR %}`) — `TAC_LAKE_DIR` is **required** and names the
  lake root. Do **not** use `-%}` on the closing tag — it strips the newline and glues
  `qlib_init:` onto the comment line (YAML parse error).
- `qrun` is `qlib.cli.run:run` (fire): positional CONFIG_PATH + `--experiment_name` / `--uri_folder`. No
  `--config` flag.

## Manual (no-yaml) path

`examples/run_backtest.py` runs the identical loop in plain Python (good for parametrizing universe, features,
label, topk, costs):

```bash
.venv/bin/python tac-qlib/examples/run_backtest.py
.venv/bin/python tac-qlib/examples/run_backtest.py --features '$close,$rsi_14,$sma_5,$macd' \
    --universe AAPL,MSFT,TSLA,USO,SLV,TLT --topk 2 --n-drop 1 --output ./backtest_out
```

Writes `pred.pkl`, `report_normal.csv`, `positions_normal.csv`, `risk.csv` to the output dir.

## Reference

- `tac_qlib/data/providers.py` — the three lake providers; they match qlib's provider interface
  (`feature()` keyed by calendar position, `list_instruments()` with listing spans, `load_calendar()`), so the
  expression engine, `DatasetH` and the backtest `Exchange` work unchanged.
- `tac_qlib/contrib/data/handler.py` — `TACHandler` (DataHandlerLP over `QlibDataLoader`),
  `DropAllNaN`, `get_common_feature_fields`, `discover_feature_fields`.
- `tac_qlib/data/config.py` — `LakeConfig` path/reader helpers, `FREQ_TO_TIMEFRAME`, `BAR_FIELD_MAP`,
  `resolve_lake_root` (`$TAC_LAKE_DIR`, required — fails fast if unset).
- Tests (no pytest; plain asserts):

```bash
.venv/bin/python tac-qlib/tests/test_lake_providers.py
```
