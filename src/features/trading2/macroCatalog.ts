/**
 * Synthetic macro symbols (`market=MACRO` in the TradeAC lake).
 *
 * Backed by the tac-engine MCP tools `get_macro_symbols`, `get_macro_bars`,
 * `get_macro_features` — see tac-engine/skills/tac-lake-macro. Bars are stored
 * like any ticker (o=h=l=c=value, v=0) at their native observation cadence
 * (D/W/M/Q/A); features live in the `family=macro` columns.
 */

// ---- Types ---------------------------------------------------------------------

/** One row of `macro_catalog.parquet` via `get_macro_symbols`. */
export interface MacroCatalogRow {
  symbol: string;
  source: string;
  source_id: string;
  title?: string;
  frequency?: string;
  units?: string;
  seasonal_adj?: boolean;
  release_lag_days?: number;
  enabled?: boolean;
  updated_at?: string;
}

/** One synthetic bar from `get_macro_bars` (o=h=l=c=value, v=0 for non-index series). */
export interface MacroBar {
  t: string;
  date?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number | null;
}

/** One row from `get_macro_features` — a timestamp plus `macro_*` columns. */
export interface MacroFeatureRow {
  market?: string;
  symbol?: string;
  timeframe?: string;
  family?: string;
  t: string;
  [key: string]: unknown;
}

/** One row from lake coverage for market=MACRO/timeframe=1d. */
export interface MacroCoverageRow {
  symbol?: string;
  first_t?: string | null;
  last_t?: string | null;
  num_bars?: number;
}

// ---- Display labels ------------------------------------------------------------

export const MACRO_SOURCE_LABELS: Record<string, string> = {
  fred: "FRED",
  cboe: "CBOE",
  oecd: "OECD",
  worldbank: "World Bank",
};

export const MACRO_FREQ_LABELS: Record<string, string> = {
  D: "Daily",
  W: "Weekly",
  M: "Monthly",
  Q: "Quarterly",
  A: "Annual",
};

export function macroSourceLabel(source: string): string {
  return MACRO_SOURCE_LABELS[source.toLowerCase()] ?? source;
}

export function macroFreqLabel(frequency?: string): string {
  if (!frequency) return "—";
  return MACRO_FREQ_LABELS[frequency.toUpperCase()] ?? frequency;
}

// ---- Symbol categories ---------------------------------------------------------

interface MacroCategoryDef {
  id: string;
  title: string;
  description: string;
  /** Known member symbols; anything else falls back to a per-source bucket. */
  symbols: string[];
}

const MACRO_CATEGORY_DEFS: MacroCategoryDef[] = [
  {
    id: "volatility",
    title: "Volatility",
    description: "Implied-volatility indices with real OHLC range.",
    symbols: ["CBOE_VIX"],
  },
  {
    id: "prices",
    title: "Prices & Inflation",
    description: "Consumer-price levels and inflation gauges.",
    symbols: ["FRED_CPIAUCSL", "OECD_CPI_US"],
  },
  {
    id: "rates",
    title: "Rates & Money",
    description: "Treasury yields, policy rates, Fed balance sheet, money supply.",
    symbols: ["FRED_DGS2", "FRED_DGS10", "FRED_T10Y2Y", "FRED_FEDFUNDS", "FRED_WALCL", "FRED_M2SL"],
  },
  {
    id: "labor",
    title: "Labor Market",
    description: "Employment and unemployment measures.",
    symbols: ["FRED_UNRATE", "FRED_PAYEMS"],
  },
  {
    id: "activity",
    title: "Growth & Activity",
    description: "Output, production, sentiment and leading indicators.",
    symbols: ["FRED_INDPRO", "FRED_UMCSENT", "FRED_GDPC1", "OECD_CLI_US", "OECD_IPI_US", "WB_GDP_US"],
  },
];

/** A folder in the catalog tree: themed category (or per-source fallback bucket). */
export interface MacroCategoryNode {
  id: string;
  title: string;
  description: string;
  rows: MacroCatalogRow[];
}

/**
 * Group catalog rows into category folders; rows not covered by a theme fall
 * back to a `<Source> · Other` bucket so new catalog entries always show up.
 */
export function groupMacroCatalog(rows: MacroCatalogRow[]): MacroCategoryNode[] {
  const bySymbol = new Map(rows.map((row) => [row.symbol.toUpperCase(), row]));
  const assigned = new Set<string>();
  const nodes: MacroCategoryNode[] = [];

  for (const def of MACRO_CATEGORY_DEFS) {
    const nodeRows = def.symbols.map((s) => bySymbol.get(s.toUpperCase())).filter((r): r is MacroCatalogRow => !!r);
    for (const r of nodeRows) assigned.add(r.symbol);
    nodes.push({ id: def.id, title: def.title, description: def.description, rows: nodeRows });
  }

  const leftovers = rows.filter((r) => !assigned.has(r.symbol));
  const bySource = new Map<string, MacroCatalogRow[]>();
  for (const row of leftovers) {
    const key = row.source.toLowerCase();
    const list = bySource.get(key) ?? [];
    list.push(row);
    bySource.set(key, list);
  }
  for (const [source, sourceRows] of bySource) {
    nodes.push({
      id: `other-${source}`,
      title: `${macroSourceLabel(source)} · Other`,
      description: `Additional ${macroSourceLabel(source)} series.`,
      rows: sourceRows,
    });
  }

  // Drop empty categories entirely (keeps the tree focused on what is loaded).
  return nodes.filter((n) => n.rows.length > 0);
}

// ---- Feature catalog -----------------------------------------------------------

export type MacroFeatureFormat = "level" | "pct" | "number" | "days" | "flag";

/** Where a feature can be drawn: overlaid on the price axis or its own pane below. */
export type MacroFeatureMode = "overlap" | "pane";

export interface MacroFeatureDef {
  /** Column name in `get_macro_features` rows. */
  key: string;
  label: string;
  description: string;
  format: MacroFeatureFormat;
  modes: MacroFeatureMode[];
  defaultMode: MacroFeatureMode;
  /** Draw a dashed zero reference line (signed transforms). */
  signed?: boolean;
  /** Render as a step line (binary flags). */
  step?: boolean;
}

export const MACRO_FEATURES: MacroFeatureDef[] = [
  {
    key: "macro_value_ffill",
    label: "Value (ffill)",
    description: "Last observation forward-filled onto US trading days — shares the price units.",
    format: "level",
    modes: ["overlap", "pane"],
    defaultMode: "overlap",
  },
  {
    key: "macro_yoy",
    label: "YoY %",
    description: "Year-over-year change of the level (log-diff), stamped on native observation dates.",
    format: "pct",
    modes: ["pane"],
    defaultMode: "pane",
    signed: true,
  },
  {
    key: "macro_mom",
    label: "MoM %",
    description: "Month-over-month change of the level (log-diff), on native observation dates.",
    format: "pct",
    modes: ["pane"],
    defaultMode: "pane",
    signed: true,
  },
  {
    key: "macro_zscore",
    label: "Z-score",
    description: "Rolling z-score of the level over a one-year window.",
    format: "number",
    modes: ["pane"],
    defaultMode: "pane",
    signed: true,
  },
  {
    key: "macro_trend_slope_60",
    label: "Trend slope 60d",
    description: "Log-price trend slope over ~60 days — daily series only.",
    format: "number",
    modes: ["pane"],
    defaultMode: "pane",
    signed: true,
  },
  {
    key: "macro_above_sma200",
    label: "Above SMA200",
    description: "1 when the last value sits above its 200-day average — daily series only.",
    format: "flag",
    modes: ["pane"],
    defaultMode: "pane",
    step: true,
  },
  {
    key: "macro_age_days",
    label: "Observation age",
    description: "Days since the underlying observation was stamped (data staleness).",
    format: "days",
    modes: ["pane"],
    defaultMode: "pane",
  },
];

export const MACRO_FEATURES_BY_KEY: Record<string, MacroFeatureDef> = Object.fromEntries(
  MACRO_FEATURES.map((f) => [f.key, f]),
);

/** User selection: which feature column to plot and where to draw it. */
export interface SelectedMacroFeature {
  key: string;
  mode: MacroFeatureMode;
}

export const DEFAULT_MACRO_SELECTION: SelectedMacroFeature[] = [{ key: "macro_value_ffill", mode: "overlap" }];

const FEATURE_META_KEYS = new Set(["t", "family", "market", "symbol", "timeframe"]);

/** Feature keys that carry at least one finite value across the fetched rows. */
export function availableMacroFeatureKeys(rows: MacroFeatureRow[]): string[] {
  const seen = new Map<string, boolean>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (FEATURE_META_KEYS.has(key)) continue;
      if (!key.startsWith("macro_")) continue;
      if (typeof value === "number" && Number.isFinite(value)) seen.set(key, true);
    }
  }
  return MACRO_FEATURES.filter((f) => seen.get(f.key)).map((f) => f.key);
}

/** Compact chip label for the picker trigger. */
export function macroSelectionLabel(selection: SelectedMacroFeature[]): string {
  if (selection.length === 0) return "No features";
  return selection
    .map((s) => {
      const def = MACRO_FEATURES_BY_KEY[s.key];
      const label = def?.label ?? s.key;
      return s.mode === "overlap" ? `${label} (overlay)` : label;
    })
    .join(", ");
}

// ---- Formatting ----------------------------------------------------------------

const LEVEL_FMT_INT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const LEVEL_FMT_BIG = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const NUMBER_FMT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

/** Format one feature/level value according to its nature. */
export function formatMacroValue(value: number | null | undefined, format: MacroFeatureFormat = "level"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "pct":
      return `${(value * 100).toFixed(2)}%`;
    case "days":
      return `${Math.round(value)}d`;
    case "flag":
      return value >= 0.5 ? "Yes" : "No";
    case "number":
      return NUMBER_FMT.format(value);
    default:
      return Math.abs(value) >= 10_000 ? LEVEL_FMT_BIG.format(value) : LEVEL_FMT_INT.format(value);
  }
}

/** True when bars carry a real high/low or open/close spread → candlesticks make sense. */
export function macroBarsHaveRange(bars: MacroBar[]): boolean {
  const eps = 1e-9;
  return bars.some(
    (b) => Number.isFinite(b.h) && Number.isFinite(b.l) && (Math.abs(b.h - b.l) > eps || Math.abs(b.o - b.c) > eps),
  );
}
