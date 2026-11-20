export interface AlpacaWatchlistAsset {
  id?: string;
  class?: string;
  exchange?: string;
  symbol: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easy_to_borrow?: boolean;
  fractionable?: boolean;
}

export interface AlpacaWatchlist {
  id: string;
  account_id?: string;
  created_at?: string;
  updated_at?: string;
  name: string;
  assets?: AlpacaWatchlistAsset[];
}

export interface StockBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

export interface StockBarsResponse {
  bars?: Record<string, StockBar[]> | StockBar[] | null;
  symbol?: string;
  next_page_token?: string | null;
}

export interface StockQuote {
  ap?: number;
  as?: number;
  ax?: string;
  bp?: number;
  bs?: number;
  bx?: string;
  t?: string;
  c?: string[] | string;
}

export interface StockSnapshot {
  dailyBar?: StockBar;
  minuteBar?: StockBar;
  prevDailyBar?: StockBar;
  latestTrade?: { p?: number; s?: number; t?: string };
  latestQuote?: StockQuote;
}

export interface OptionQuote {
  ap?: number;
  as?: number;
  bp?: number;
  bs?: number;
  t?: string;
}

export interface OptionGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

export interface OptionContractSnapshot {
  latestQuote?: OptionQuote;
  latestTrade?: { p?: number; s?: number; t?: string };
  dailyBar?: StockBar;
  minuteBar?: StockBar;
  greeks?: OptionGreeks;
  impliedVolatility?: number;
}

export interface OptionChainResponse {
  snapshots?: Record<string, OptionContractSnapshot>;
  next_page_token?: string | null;
}

export interface ParsedOptionContract {
  symbol: string;
  underlying: string;
  expiration: string; // YYYY-MM-DD
  type: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
}

// ---- TA / lake indicator model -------------------------------------------------

export type IndicatorCategory = "overlap" | "momentum" | "statistics" | "volatility" | "volume";

export type PaneId = "price" | "volume" | "macd" | "rsi" | "momentum" | "volatility" | "stats" | "obv";

export type SeriesKind = "line" | "bar" | "area";

/** A single plotted series resolved from the selection (column key inside a lake feature row). */
export interface IndicatorSeries {
  key: string;
  label: string;
  kind: SeriesKind;
  pane: PaneId;
  color?: string;
}

/** User selection: a kand indicator id plus the periods to compute ([] for fixed indicators). */
export interface SelectedIndicator {
  id: string;
  periods: number[];
}

/** Where an indicator's columns are computed: kand (`get_lake_ta`) or stochastic-process (`get_lake_sp`). */
export type IndicatorProvider = "ta" | "sp";

/** Static catalog entry describing one kand indicator (used by the indicator picker UI). */
export interface IndicatorDef {
  id: string;
  name: string;
  category: IndicatorCategory;
  description: string;
  longDescription: string;
  needsPeriod: boolean;
  defaultPeriods: number[];
  periodLabel: string;
  seriesFor: (period: number) => IndicatorSeries[];
  provider: IndicatorProvider;
  /** For sp_* indicators: the `get_lake_sp` family that produces this column (undefined for always-present columns like sp_ret). */
  spFamily?: string;
}

/** One row returned by `get_lake_ta` — a timestamp plus one column per indicator output. */
export interface LakeFeatureRow {
  market?: string;
  symbol?: string;
  timeframe?: string;
  t: string;
  [key: string]: unknown;
}
