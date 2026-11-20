import type {
  IndicatorCategory,
  IndicatorDef,
  IndicatorProvider,
  IndicatorSeries,
  PaneId,
  SelectedIndicator,
} from "./marketTypes";

/**
 * Catalog of every TA indicator the TradeAC lake can compute via the kand
 * Rust crate (see `tac-engine/src/lake.rs`). Classification follows TA-Lib
 * categories (https://ta-lib.org/functions/). Column keys match the columns
 * `get_lake_ta` returns.
 */

export const PANE_ORDER: PaneId[] = ["price", "volume", "macd", "rsi", "momentum", "volatility", "stats", "obv"];

export const CATEGORIES: { id: IndicatorCategory; title: string; blurb: string }[] = [
  { id: "overlap", title: "Overlap", blurb: "Moving averages & price overlays plotted on the price panel." },
  { id: "momentum", title: "Momentum", blurb: "Oscillators, rate-of-change and directional strength studies." },
  { id: "statistics", title: "Statistics", blurb: "Rolling statistical measures of price." },
  { id: "volatility", title: "Volatility", blurb: "Volatility / range-based indicators." },
  { id: "volume", title: "Volume", blurb: "Volume and money-flow indicators." },
];

const overlayLine = (key: string, label: string, color?: string): IndicatorSeries => ({
  key,
  label,
  kind: "line",
  pane: "price",
  color,
});

/** Single-output moving-average style overlay: `name-period` line on the price pane. */
const maOverlay =
  (id: string, name: string) =>
  (p: number): IndicatorSeries[] => [overlayLine(`${id}_${p}`, `${name}-${p}`)];

/** Single-output sub-pane line (no period suffix handling for fixed ones handled inline). */
const subLine =
  (pane: PaneId) =>
  (key: string, label: string, color?: string): IndicatorSeries => ({
    key,
    label,
    kind: "line",
    pane,
    color,
  });

/** Single-output period line on a sub-pane. */
const subPeriod =
  (id: string, name: string, pane: PaneId) =>
  (p: number): IndicatorSeries[] => [{ key: `${id}_${p}`, label: `${name}-${p}`, kind: "line", pane }];

function def(
  id: string,
  name: string,
  category: IndicatorCategory,
  description: string,
  longDescription: string,
  needsPeriod: boolean,
  defaultPeriods: number[],
  seriesFor: (period: number) => IndicatorSeries[],
): IndicatorDef {
  return {
    id,
    name,
    category,
    description,
    longDescription,
    needsPeriod,
    defaultPeriods,
    periodLabel: needsPeriod ? "period(s), comma separated" : "",
    seriesFor,
    provider: "ta",
  };
}

// ---- Overlap ---------------------------------------------------------------

const overlap: IndicatorDef[] = [
  def(
    "sma",
    "SMA",
    "overlap",
    "Simple Moving Average",
    "Average of the last N closing prices. Trend-following baseline; crossovers of short vs long SMAs signal trend shifts.",
    true,
    [20],
    maOverlay("sma", "SMA"),
  ),
  def(
    "ema",
    "EMA",
    "overlap",
    "Exponential Moving Average",
    "Weighted average that gives more weight to recent prices (smoothing factor 2/(N+1)). Reacts faster than SMA to price change.",
    true,
    [20],
    maOverlay("ema", "EMA"),
  ),
  def(
    "dema",
    "DEMA",
    "overlap",
    "Double Exponential MA",
    "Combines EMA with EMA-of-EMA to reduce lag: DEMA = 2*EMA − EMA(EMA).",
    true,
    [20],
    maOverlay("dema", "DEMA"),
  ),
  def(
    "tema",
    "TEMA",
    "overlap",
    "Triple Exponential MA",
    "Further de-lagged MA: 3*EMA − 3*EMA(EMA) + EMA(EMA(EMA)).",
    true,
    [20],
    maOverlay("tema", "TEMA"),
  ),
  def(
    "trima",
    "TRIMA",
    "overlap",
    "Triangular Moving Average",
    "Double-smoothed SMA (average of an average) that gives more weight to the middle of the window.",
    true,
    [20],
    maOverlay("trima", "TRIMA"),
  ),
  def(
    "wma",
    "WMA",
    "overlap",
    "Weighted Moving Average",
    "Linearly weighted average; recent prices carry more weight than older ones.",
    true,
    [20],
    maOverlay("wma", "WMA"),
  ),
  def(
    "t3",
    "T3",
    "overlap",
    "T3 Moving Average",
    "Smoothed, low-lag MA using a volume factor (0.7) applied to multiple EMAs.",
    true,
    [20],
    maOverlay("t3", "T3"),
  ),
  def(
    "rma",
    "RMA",
    "overlap",
    "Rolling Moving Average (Wilder)",
    "Wilder-smoothed average (the smoothing used inside RSI/ATR).",
    true,
    [20],
    maOverlay("rma", "RMA"),
  ),
  def(
    "bbands",
    "BBANDS",
    "overlap",
    "Bollinger Bands",
    "Middle = SMA(N); upper/lower = middle ± 2 standard deviations. Measures volatility and overbought/oversold extremes.",
    true,
    [20],
    () => [
      overlayLine("bb_upper", "BB Upper"),
      overlayLine("bb_middle", "BB Mid"),
      overlayLine("bb_lower", "BB Lower"),
    ],
  ),
  def(
    "midpoint",
    "MIDPOINT",
    "overlap",
    "MidPoint",
    "Average of the highest and lowest values over the period: (max+min)/2.",
    true,
    [14],
    maOverlay("midpoint", "MIDPOINT"),
  ),
  def("medprice", "MEDPRICE", "overlap", "Median Price", "(High + Low) / 2 of each bar.", false, [], () => [
    overlayLine("medprice", "MedPrice"),
  ]),
  def("typprice", "TYPPRICE", "overlap", "Typical Price", "(High + Low + Close) / 3 of each bar.", false, [], () => [
    overlayLine("typprice", "TypPrice"),
  ]),
  def(
    "wclprice",
    "WCLPRICE",
    "overlap",
    "Weighted Close",
    "(High + Low + 2*Close) / 4 — puts extra weight on the close.",
    false,
    [],
    () => [overlayLine("wclprice", "WclPrice")],
  ),
  def(
    "vwap",
    "VWAP",
    "overlap",
    "Volume Weighted Avg Price",
    "Cumulative typical price × volume ÷ cumulative volume. Anchored at the start of the range; institutional reference level.",
    false,
    [],
    () => [overlayLine("vwap", "VWAP")],
  ),
  def(
    "sar",
    "SAR",
    "overlap",
    "Parabolic SAR",
    "Parabolic stop-and-reverse dots that trail price and flip when price crosses them; acceleration 0.02, max 0.2.",
    false,
    [],
    () => [overlayLine("sar", "SAR")],
  ),
  def(
    "supertrend",
    "SUPERTREND",
    "overlap",
    "SuperTrend",
    "ATR-based trend line that flips above/below price; multiplier 3.0. Bull when price above, bear when below.",
    true,
    [10],
    (p) => [overlayLine(`supertrend_${p}`, `SuperTrend-${p}`)],
  ),
  def(
    "vegas",
    "VEGAS",
    "overlap",
    "VEGAS Channel",
    "VEGAS channel & trend boundary EMAs (144/169/576/676 family). Long lookback needed.",
    false,
    [],
    () => [overlayLine("vegas_upper", "VEGAS Upper"), overlayLine("vegas_lower", "VEGAS Lower")],
  ),
  def(
    "ecl",
    "ECL",
    "overlap",
    "Expanded Camarilla Levels",
    "Intraday support/resistance levels (H1–H5 / L1–L5) derived from prior-day high/low/close.",
    false,
    [],
    () => [
      ...["h1", "h2", "h3", "h4", "h5"].map((k) => overlayLine(`ecl_${k}`, `ECL ${k.toUpperCase()}`)),
      ...["l1", "l2", "l3", "l4", "l5"].map((k) => overlayLine(`ecl_${k}`, `ECL ${k.toUpperCase()}`)),
    ],
  ),
  def(
    "ha",
    "HA",
    "overlap",
    "Heikin Ashi",
    "Heikin-Ashi smoothed candles (open/high/low/close). Only the HA close is drawn as an overlay line.",
    false,
    [],
    () => [overlayLine("ha_close", "HA Close")],
  ),
];

// ---- Momentum ---------------------------------------------------------------

const momentum: IndicatorDef[] = [
  def(
    "macd",
    "MACD",
    "momentum",
    "Moving Average Conv./Div.",
    "MACD = EMA(12) − EMA(26); Signal = EMA(9) of MACD; Hist = MACD − Signal. The Signal line is what older versions called “Signal”; Hist is the histogram.",
    false,
    [],
    () => [
      { key: "macd", label: "MACD", kind: "line", pane: "macd" },
      { key: "macd_signal", label: "Signal", kind: "line", pane: "macd" },
      { key: "macd_hist", label: "Hist", kind: "bar", pane: "macd" },
    ],
  ),
  def(
    "rsi",
    "RSI",
    "momentum",
    "Relative Strength Index",
    "0–100 momentum oscillator: 100 − 100/(1 + avgGain/avgLoss) over N periods (Wilder smoothing). Above 70 = overbought, below 30 = oversold.",
    true,
    [14],
    subPeriod("rsi", "RSI", "rsi"),
  ),
  def(
    "stoch",
    "STOCH",
    "momentum",
    "Stochastic %K/%D",
    "%K locates close within the N-bar high/low range (3-smoothing); %D is a 3-period MA of %K. High/low readings flag turning points.",
    false,
    [],
    () => [
      { key: "stoch_k", label: "%K", kind: "line", pane: "rsi" },
      { key: "stoch_d", label: "%D", kind: "line", pane: "rsi" },
    ],
  ),
  def(
    "willr",
    "WILLR",
    "momentum",
    "Williams %R",
    "Inverted stochastic (−100..0). Values above −20 = overbought, below −80 = oversold.",
    true,
    [14],
    subPeriod("willr", "WILLR", "rsi"),
  ),
  def(
    "adx",
    "ADX",
    "momentum",
    "Avg Directional Index",
    "Measures trend strength (not direction) from smoothed +DI/−DI. Above 25 typically = strong trend.",
    true,
    [14],
    subPeriod("adx", "ADX", "momentum"),
  ),
  def(
    "adxr",
    "ADXR",
    "momentum",
    "ADX Rating",
    "(ADX + ADX N bars ago) / 2 — smoother ADX variant.",
    true,
    [14],
    subPeriod("adxr", "ADXR", "momentum"),
  ),
  def(
    "aroon",
    "AROON",
    "momentum",
    "Aroon Up/Down",
    "Aroon-up = time since highest high; Aroon-down = time since lowest low (0–100).",
    true,
    [14],
    (p) => [
      { key: `aroon_up_${p}`, label: `AroonUp-${p}`, kind: "line", pane: "momentum" },
      { key: `aroon_down_${p}`, label: `AroonDown-${p}`, kind: "line", pane: "momentum" },
    ],
  ),
  def(
    "aroonosc",
    "AROONOSC",
    "momentum",
    "Aroon Oscillator",
    "Aroon-up − Aroon-down (−100..100); positive = uptrend, negative = downtrend.",
    true,
    [14],
    subPeriod("aroonosc", "AROONOSC", "momentum"),
  ),
  def(
    "bop",
    "BOP",
    "momentum",
    "Balance of Power",
    "(Close − Open) / (High − Low) — who is controlling the bar, buyers or sellers.",
    false,
    [],
    () => [subLine("momentum")("bop", "BOP")],
  ),
  def(
    "cci",
    "CCI",
    "momentum",
    "Commodity Channel Index",
    "Distance of typical price from its SMA, normalized by mean deviation. Extreme ±100/±200 levels flag cycles.",
    true,
    [20],
    subPeriod("cci", "CCI", "momentum"),
  ),
  def(
    "dx",
    "DX",
    "momentum",
    "Directional Movement Index",
    "Raw |+DI − −DI| / (+DI + −DI) × 100; ADX is its smoothed form.",
    true,
    [14],
    subPeriod("dx", "DX", "momentum"),
  ),
  def(
    "mfi",
    "MFI",
    "momentum",
    "Money Flow Index",
    "RSI but volume-weighted (0–100). >80 = overbought, <20 = oversold.",
    true,
    [14],
    subPeriod("mfi", "MFI", "momentum"),
  ),
  def(
    "mom",
    "MOM",
    "momentum",
    "Momentum",
    "Price − Price N bars ago. Positive = gaining, negative = losing.",
    true,
    [10],
    subPeriod("mom", "MOM", "momentum"),
  ),
  def(
    "plus_di",
    "PLUS_DI",
    "momentum",
    "+ Directional Indicator",
    "Smoothed +DM / True Range × 100; strength of upward movement.",
    true,
    [14],
    subPeriod("plus_di", "+DI", "momentum"),
  ),
  def(
    "plus_dm",
    "PLUS_DM",
    "momentum",
    "+ Directional Movement",
    "Raw up-move magnitude (high − prevHigh) when it exceeds the down-move.",
    true,
    [14],
    subPeriod("plus_dm", "+DM", "momentum"),
  ),
  def(
    "minus_di",
    "MINUS_DI",
    "momentum",
    "− Directional Indicator",
    "Smoothed −DM / True Range × 100; strength of downward movement.",
    true,
    [14],
    subPeriod("minus_di", "−DI", "momentum"),
  ),
  def(
    "minus_dm",
    "MINUS_DM",
    "momentum",
    "− Directional Movement",
    "Raw down-move magnitude (prevLow − low) when it exceeds the up-move.",
    true,
    [14],
    subPeriod("minus_dm", "−DM", "momentum"),
  ),
  def(
    "roc",
    "ROC",
    "momentum",
    "Rate of Change",
    "(Price / Price N ago − 1) × 100 — percent change momentum.",
    true,
    [10],
    subPeriod("roc", "ROC", "momentum"),
  ),
  def(
    "rocp",
    "ROCP",
    "momentum",
    "ROC Percentage",
    "(Price − Price N ago) / Price N ago — same as ROC, alternate scaling.",
    true,
    [10],
    subPeriod("rocp", "ROCP", "momentum"),
  ),
  def(
    "rocr",
    "ROCR",
    "momentum",
    "ROC Ratio",
    "Price / Price N ago — ratio form (1.0 = flat).",
    true,
    [10],
    subPeriod("rocr", "ROCR", "momentum"),
  ),
  def(
    "rocr100",
    "ROCR100",
    "momentum",
    "ROC Ratio (100)",
    "Price / Price N ago × 100 — ratio on a 100 scale.",
    true,
    [10],
    subPeriod("rocr100", "ROCR100", "momentum"),
  ),
  def(
    "trix",
    "TRIX",
    "momentum",
    "TRIX",
    "1-day ROC of a triple-smoothed EMA — filters out noise; crosses the zero line on trend changes.",
    true,
    [15],
    subPeriod("trix", "TRIX", "momentum"),
  ),
  def(
    "cdl_doji",
    "CDL Doji",
    "momentum",
    "Doji pattern",
    "Open ≈ Close (body ≤ 10% of range) — indecision; potential reversal. Signal: 1 = bullish, −1 = bearish context.",
    false,
    [],
    () => [{ key: "cdl_doji", label: "Doji", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_dragonfly_doji",
    "CDL Dragonfly Doji",
    "momentum",
    "Dragonfly Doji",
    "Doji with a long lower shadow and no upper shadow — possible bullish reversal at lows.",
    false,
    [],
    () => [{ key: "cdl_dragonfly_doji", label: "Dragonfly", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_gravestone_doji",
    "CDL Gravestone Doji",
    "momentum",
    "Gravestone Doji",
    "Doji with a long upper shadow and no lower shadow — possible bearish reversal at highs.",
    false,
    [],
    () => [{ key: "cdl_gravestone_doji", label: "Gravestone", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_hammer",
    "CDL Hammer",
    "momentum",
    "Hammer",
    "Small body at the top, long lower shadow (≥ 3× body) — bullish reversal after a decline.",
    false,
    [],
    () => [{ key: "cdl_hammer", label: "Hammer", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_inverted_hammer",
    "CDL Inverted Hammer",
    "momentum",
    "Inverted Hammer",
    "Small body at the bottom, long upper shadow — bullish reversal signal at bottoms.",
    false,
    [],
    () => [{ key: "cdl_inverted_hammer", label: "InvHammer", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_long_shadow",
    "CDL Long Shadow",
    "momentum",
    "Long Lower Shadow",
    "Long lower shadow relative to the body — rejection of lows.",
    false,
    [],
    () => [{ key: "cdl_long_shadow", label: "LongShadow", kind: "bar", pane: "momentum" }],
  ),
  def(
    "cdl_marubozu",
    "CDL Marubozu",
    "momentum",
    "Marubozu",
    "Full-body candle with tiny shadows — strong conviction in the direction of the body.",
    false,
    [],
    () => [{ key: "cdl_marubozu", label: "Marubozu", kind: "bar", pane: "momentum" }],
  ),
];

// ---- Statistics -------------------------------------------------------------

const statistics: IndicatorDef[] = [
  def(
    "max",
    "MAX",
    "statistics",
    "Highest value",
    "Highest close over the period.",
    true,
    [14],
    subPeriod("max", "MAX", "stats"),
  ),
  def(
    "min",
    "MIN",
    "statistics",
    "Lowest value",
    "Lowest close over the period.",
    true,
    [14],
    subPeriod("min", "MIN", "stats"),
  ),
  def(
    "stddev",
    "STDDEV",
    "statistics",
    "Standard Deviation",
    "Population standard deviation of close over the period — volatility of price.",
    true,
    [20],
    subPeriod("stddev", "STDDEV", "stats"),
  ),
  def(
    "sum",
    "SUM",
    "statistics",
    "Summation",
    "Sum of closes over the period.",
    true,
    [14],
    subPeriod("sum", "SUM", "stats"),
  ),
  def(
    "var",
    "VAR",
    "statistics",
    "Variance",
    "Population variance of close over the period.",
    true,
    [20],
    subPeriod("var", "VAR", "stats"),
  ),
];

// ---- Volatility -------------------------------------------------------------

const volatility: IndicatorDef[] = [
  def(
    "atr",
    "ATR",
    "volatility",
    "Average True Range",
    "Wilder-smoothed average of True Range — the classic volatility gauge. Used to size stops.",
    true,
    [14],
    subPeriod("atr", "ATR", "volatility"),
  ),
  def(
    "natr",
    "NATR",
    "volatility",
    "Normalized ATR",
    "ATR ÷ Close × 100 — volatility as a percentage, comparable across price levels.",
    true,
    [14],
    subPeriod("natr", "NATR", "volatility"),
  ),
  def(
    "trange",
    "TRANGE",
    "volatility",
    "True Range",
    "max(High−Low, |High−prevClose|, |Low−prevClose|) per bar.",
    false,
    [],
    () => [subLine("volatility")("trange", "TRANGE")],
  ),
  def(
    "adr",
    "ADR",
    "volatility",
    "Average Daily Range",
    "Average of (High − Low) over the period — typical intraday range.",
    true,
    [14],
    subPeriod("adr", "ADR", "volatility"),
  ),
];

// ---- Volume -----------------------------------------------------------------

const volume: IndicatorDef[] = [
  def(
    "ad",
    "AD",
    "volume",
    "Chaikin A/D Line",
    "Cumulative money flow: (close−low − (high−close)) / (high−low) × volume, accumulated.",
    false,
    [],
    () => [subLine("obv")("ad", "AD")],
  ),
  def(
    "adosc",
    "ADOSC",
    "volume",
    "Chaikin A/D Oscillator",
    "EMA(3) − EMA(10) of the A/D line — measures accumulation/distribution momentum.",
    false,
    [],
    () => [subLine("obv")("adosc", "ADOSC")],
  ),
  def(
    "obv",
    "OBV",
    "volume",
    "On Balance Volume",
    "Cumulative volume added on up closes, subtracted on down closes. Trend in OBV should confirm price trend.",
    false,
    [],
    () => [subLine("obv")("obv", "OBV")],
  ),
];

/** Raw bar volume is not a kand indicator — it is drawn straight from the OHLCV bars. */
export const VOLUME_RAW: IndicatorDef = def(
  "volume",
  "Volume",
  "volume",
  "Raw bar volume",
  "Trading volume of each bar, colored green/red by whether the bar closed up or down. Drawn from the OHLCV bars, not kand.",
  false,
  [],
  () => [{ key: "volume", label: "Volume", kind: "bar", pane: "volume" }],
);

// ---- Stochastic-process features (get_lake_sp) -------------------------------
//
// Computed by the Rust stochastic-rs pipeline (`get_lake_sp`), grouped into the
// same TA-Lib style categories so they can be picked alongside kand indicators.
// Every column is fixed (no period input); `spFamily` maps the column back to
// the `get_lake_sp` family that computes it.

const spDef = (
  id: string,
  family: string | undefined,
  category: IndicatorCategory,
  pane: PaneId,
  name: string,
  description: string,
  longDescription: string,
): IndicatorDef => ({
  id,
  name,
  category,
  description,
  longDescription,
  needsPeriod: false,
  defaultPeriods: [],
  periodLabel: "",
  provider: "sp",
  spFamily: family,
  seriesFor: () => [{ key: id, label: name, kind: "line", pane }],
});

// ---- Momentum ---------------------------------------------------------------

const spMomentum: IndicatorDef[] = [
  spDef(
    "sp_ret",
    undefined,
    "momentum",
    "momentum",
    "SP return",
    "Daily return of the symbol.",
    "Daily close/close return — the base series every other sp_* column is built from. Always present in get_lake_sp output.",
  ),
  spDef(
    "sp_trend_slope_5",
    "trend",
    "momentum",
    "momentum",
    "SP trend 5d",
    "5-day log-price momentum slope.",
    "OLS-free rolling log-price momentum slope over 5 bars (stochastic-rs trend family) — short-horizon directional drift.",
  ),
  spDef(
    "sp_trend_slope_20",
    "trend",
    "momentum",
    "momentum",
    "SP trend 20d",
    "20-day log-price momentum slope.",
    "Log-price momentum slope over 20 bars (trend family) — intermediate trend strength.",
  ),
  spDef(
    "sp_trend_slope_60",
    "trend",
    "momentum",
    "momentum",
    "SP trend 60d",
    "60-day log-price momentum slope.",
    "Log-price momentum slope over 60 bars (trend family) — long-horizon trend.",
  ),
  spDef(
    "sp_ou_half_life",
    "ou",
    "momentum",
    "momentum",
    "SP OU half-life",
    "Rolling AR(1) mean-reversion half-life.",
    "Half-life of the OU/AR(1) fit on log price (ou family). Large values = persistent trending; small = fast mean reversion.",
  ),
  spDef(
    "sp_ou_zscore",
    "ou",
    "momentum",
    "momentum",
    "SP OU z-score",
    "Distance of price from its rolling mean.",
    "Z-score of close vs rolling mean/std over the ou window — how stretched price is from its mean-reverting level.",
  ),
  spDef(
    "sp_ou_revert",
    "ou",
    "momentum",
    "momentum",
    "SP OU revert",
    "Mean-reversion sign flag.",
    "−1 when the rolling AR(1) beta is non-negative (trending regime), +1 when beta < 0 (mean-reverting regime).",
  ),
  spDef(
    "sp_hurst_exponent",
    "hurst",
    "momentum",
    "momentum",
    "SP Hurst exponent",
    "Rescaled-range R/S exponent.",
    "Weron rescaled-range Hurst exponent over rolling returns (hurst family). >0.5 persistent/trending, <0.5 anti-persistent/mean-reverting.",
  ),
  spDef(
    "sp_sig_level1_lead",
    "signature",
    "momentum",
    "momentum",
    "SP sig L1 lead",
    "Path-signature level-1 lead term.",
    "Total log-return of the lead path over the signature window (level-1 integral).",
  ),
  spDef(
    "sp_sig_level1_lag",
    "signature",
    "momentum",
    "momentum",
    "SP sig L1 lag",
    "Path-signature level-1 lag term.",
    "Total log-return of the lag path over the signature window (level-1 integral).",
  ),
  spDef(
    "sp_sig_level2_lead_lag",
    "signature",
    "momentum",
    "momentum",
    "SP sig L2 lead-lag",
    "Level-2 cross-integral (lead→lag, lag 1).",
    "∫X dY over the lead/lag offset-1 log-price paths — lead/lag asymmetry of the level-2 signature.",
  ),
  spDef(
    "sp_sig_level2_lag_lead",
    "signature",
    "momentum",
    "momentum",
    "SP sig L2 lag-lead",
    "Level-2 cross-integral (lag→lead, lag 1).",
    "∫Y dX over the lead/lag offset-1 log-price paths — the reverse cross term.",
  ),
  spDef(
    "sp_sig_level2_lead_lag_5",
    "signature",
    "momentum",
    "momentum",
    "SP sig L2 lead-lag 5",
    "Level-2 cross-integral (lead→lag, lag 5).",
    "Lead/lag cross term at a 5-bar offset — slower lead/lag asymmetry.",
  ),
  spDef(
    "sp_sig_level2_lag_lead_5",
    "signature",
    "momentum",
    "momentum",
    "SP sig L2 lag-lead 5",
    "Level-2 cross-integral (lag→lead, lag 5).",
    "Reverse cross term at a 5-bar offset.",
  ),
];

// ---- Volatility -------------------------------------------------------------

const spVolatility: IndicatorDef[] = [
  spDef(
    "sp_rv1",
    "har",
    "volatility",
    "volatility",
    "SP RV-1",
    "1-day realized variance.",
    "Squared return (realized variance over a 1-day window, har family) — daily vol squared.",
  ),
  spDef(
    "sp_rv5",
    "har",
    "volatility",
    "volatility",
    "SP RV-5",
    "5-day realized variance.",
    "Realized variance over a rolling 5-day window (HAR-RV).",
  ),
  spDef(
    "sp_rv22",
    "har",
    "volatility",
    "volatility",
    "SP RV-22",
    "22-day realized variance.",
    "Realized variance over a rolling 22-day window (HAR-RV monthly component).",
  ),
  spDef(
    "sp_vol_ratio_5_22",
    "har",
    "volatility",
    "volatility",
    "SP vol ratio 5/22",
    "5d vs 22d realized-variance ratio.",
    "Short/long realized-vol ratio — spikes signal vol regime shifts.",
  ),
  spDef(
    "sp_vol_ratio_1_22",
    "har",
    "volatility",
    "volatility",
    "SP vol ratio 1/22",
    "1d vs 22d realized-variance ratio.",
    "Daily vs monthly realized-vol ratio — the most sensitive short/long vol gauge.",
  ),
  spDef(
    "sp_rv_ac1",
    "har",
    "volatility",
    "volatility",
    "SP RV autocorr",
    "Lag-1 autocorrelation of 1d RV.",
    "Autocorrelation of the daily squared-return series over 22 bars — volatility clustering/persistence.",
  ),
  spDef(
    "sp_rv_cv_22",
    "har",
    "volatility",
    "volatility",
    "SP RV CV-22",
    "Coefficient of variation of 1d RV.",
    "Std/mean of daily realized variance over 22 bars — vol-of-vol, scale-free.",
  ),
  spDef(
    "sp_dsv_1",
    "moments",
    "volatility",
    "volatility",
    "SP DSV-1",
    "1-day downside semi-variance.",
    "Realized downside semi-variance over 1 day (moments family, stochastic-rs realized) — squared moves below zero.",
  ),
  spDef(
    "sp_dsv_5",
    "moments",
    "volatility",
    "volatility",
    "SP DSV-5",
    "5-day downside semi-variance.",
    "Realized downside semi-variance over a rolling 5-day window.",
  ),
  spDef(
    "sp_dsv_22",
    "moments",
    "volatility",
    "volatility",
    "SP DSV-22",
    "22-day downside semi-variance.",
    "Realized downside semi-variance over a rolling 22-day window.",
  ),
  spDef(
    "sp_dsv_ratio_1",
    "moments",
    "volatility",
    "volatility",
    "SP DSV ratio 1",
    "1-day downside-variance share.",
    "Downside semi-variance / total realized variance over 1 day — downside skew of daily moves.",
  ),
  spDef(
    "sp_dsv_ratio_5",
    "moments",
    "volatility",
    "volatility",
    "SP DSV ratio 5",
    "5-day downside-variance share.",
    "Share of 5-day realized variance coming from down moves.",
  ),
  spDef(
    "sp_dsv_ratio_22",
    "moments",
    "volatility",
    "volatility",
    "SP DSV ratio 22",
    "22-day downside-variance share.",
    "Share of 22-day realized variance coming from down moves.",
  ),
  spDef(
    "sp_jump_ratio",
    "jump",
    "volatility",
    "volatility",
    "SP jump ratio",
    "Bipower-variation jump share.",
    "Fraction of realized variance attributable to jumps (jump family) — 1 − BV/RV.",
  ),
  spDef(
    "sp_jump_flag",
    "jump",
    "volatility",
    "volatility",
    "SP jump flag",
    "Jump-detection flag.",
    "Binary flag when the jump share/tail exceeds its threshold over the window.",
  ),
  spDef(
    "sp_jump_tail",
    "jump",
    "volatility",
    "volatility",
    "SP jump tail",
    "Jump tail z-score.",
    "Z-score of the jump component vs its rolling distribution — tail-event intensity.",
  ),
  spDef(
    "sp_max_move",
    "jump",
    "volatility",
    "volatility",
    "SP max move",
    "Max |% move| over window.",
    "Largest absolute daily percent move in the jump window.",
  ),
  spDef(
    "sp_max_up",
    "jump",
    "volatility",
    "volatility",
    "SP max up",
    "Max up move over window.",
    "Largest positive daily percent move in the window.",
  ),
  spDef(
    "sp_max_down",
    "jump",
    "volatility",
    "volatility",
    "SP max down",
    "Max down move over window.",
    "Largest negative daily percent move in the window.",
  ),
  spDef(
    "sp_hmm_p_regime1",
    "hmm",
    "volatility",
    "volatility",
    "SP HMM P(regime1)",
    "P(high-vol regime) from 2-state HMM.",
    "Posterior probability of the second (high-vol) state of the fitted 2-state Gaussian HMM (hmm family). Fit window ends at fit_end to avoid lookahead.",
  ),
  spDef(
    "sp_hmm_state",
    "hmm",
    "volatility",
    "volatility",
    "SP HMM state",
    "HMM regime state.",
    "0/1 discrete state of the 2-state Gaussian HMM — low/high vol regime.",
  ),
];

// ---- Statistics -------------------------------------------------------------

const spStatistics: IndicatorDef[] = [
  spDef(
    "sp_rskew_5",
    "moments",
    "statistics",
    "stats",
    "SP realized skew 5",
    "Realized skewness (5d).",
    "RV^1.5-normalized third moment of 5-day returns (moments family) — return asymmetry, scale-free.",
  ),
  spDef(
    "sp_rskew_22",
    "moments",
    "statistics",
    "stats",
    "SP realized skew 22",
    "Realized skewness (22d).",
    "Realized skewness over 22 days.",
  ),
  spDef(
    "sp_rkurt_5",
    "moments",
    "statistics",
    "stats",
    "SP realized kurt 5",
    "Realized kurtosis (5d).",
    "RV^2-normalized fourth moment of 5-day returns (moments family) — tail heaviness.",
  ),
  spDef(
    "sp_rkurt_22",
    "moments",
    "statistics",
    "stats",
    "SP realized kurt 22",
    "Realized kurtosis (22d).",
    "Realized kurtosis over 22 days.",
  ),
];

export const INDICATORS: IndicatorDef[] = [
  ...overlap,
  ...momentum,
  ...statistics,
  ...volatility,
  ...volume,
  ...spMomentum,
  ...spVolatility,
  ...spStatistics,
];

export const INDICATORS_BY_ID: Record<string, IndicatorDef> = Object.fromEntries(INDICATORS.map((d) => [d.id, d]));

export function indicatorsByCategory(): Record<IndicatorCategory, IndicatorDef[]> {
  const map: Record<IndicatorCategory, IndicatorDef[]> = {
    overlap: [],
    momentum: [],
    statistics: [],
    volatility: [],
    volume: [],
  };
  for (const d of INDICATORS) map[d.category].push(d);
  return map;
}

// ---- Selection helpers ------------------------------------------------------

/** Default selection per the requirements: SMA-5, SMA-20, volume, RSI. */
export const DEFAULT_SELECTION: SelectedIndicator[] = [
  { id: "sma", periods: [5, 20] },
  { id: "rsi", periods: [14] },
];

export const DEFAULT_INCLUDE_VOLUME = true;

function selectionToSpecs(
  selection: SelectedIndicator[],
  includeVolume: boolean,
  provider?: IndicatorProvider,
): string[] {
  const parts: string[] = [];
  if (includeVolume) parts.push("volume");
  for (const sel of selection) {
    const defn = INDICATORS_BY_ID[sel.id];
    if (!defn) continue;
    if (provider && defn.provider !== provider) continue;
    if (!defn.needsPeriod) {
      parts.push(sel.id);
      continue;
    }
    const periods = sel.periods.length > 0 ? sel.periods : defn.defaultPeriods;
    // Omit the period suffix when it is the only period and equals the default,
    // e.g. RSI-14 renders as `rsi` (matches `sma-5,sma-20,obv,rsi`).
    if (periods.length === 1 && periods[0] === defn.defaultPeriods[0]) {
      parts.push(sel.id);
    } else {
      for (const p of periods) parts.push(`${sel.id}-${p}`);
    }
  }
  return parts;
}

/** Comma-separated label shown in the toolbar, e.g. `sma-5,sma-20,volume,rsi,sp_rv22`. */
export function selectionLabel(selection: SelectedIndicator[], includeVolume: boolean): string {
  const specs = selectionToSpecs(selection, includeVolume);
  return specs.length > 0 ? specs.join(",") : "no indicators";
}

/** Kand indicator specs to send to `get_lake_ta` (raw `volume` is excluded). */
export function selectionToTaSpecs(selection: SelectedIndicator[]): string[] {
  return selectionToSpecs(selection, false, "ta");
}

/** The `get_lake_sp` families needed for the selected sp_* columns (unique, in catalog order). */
export function selectionToSpFamilies(selection: SelectedIndicator[]): string[] {
  const families: string[] = [];
  for (const sel of selection) {
    const defn = INDICATORS_BY_ID[sel.id];
    if (defn?.provider !== "sp" || !defn?.spFamily) continue;
    if (!families.includes(defn.spFamily)) families.push(defn.spFamily);
  }
  return families;
}

/** True when any selected indicator comes from the stochastic-process provider. */
export function hasSpSelection(selection: SelectedIndicator[]): boolean {
  return selection.some((s) => INDICATORS_BY_ID[s.id]?.provider === "sp");
}

/** Flatten the selection into the plot series to render (including raw volume if enabled). */
export function selectionToSeries(selection: SelectedIndicator[], includeVolume: boolean): IndicatorSeries[] {
  const out: IndicatorSeries[] = [];
  if (includeVolume) out.push({ key: "volume", label: "Volume", kind: "bar", pane: "volume" });
  for (const sel of selection) {
    const defn = INDICATORS_BY_ID[sel.id];
    if (!defn) continue;
    let periods: number[];
    if (!defn.needsPeriod) {
      periods = [0];
    } else if (sel.periods.length > 0) {
      periods = sel.periods;
    } else {
      periods = defn.defaultPeriods;
    }
    for (const p of periods) {
      for (const s of defn.seriesFor(p)) {
        if (!out.some((x) => x.key === s.key && x.pane === s.pane)) out.push(s);
      }
    }
  }
  return out;
}
