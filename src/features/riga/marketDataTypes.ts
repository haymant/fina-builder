// Market-data-type registry (§6.1/§6.3). Each type declares where it comes from
// in `tac-engine` and which `riga-flow` field it feeds. FX / FX-vol are real
// tac-engine data but are **not** priced by riga-flow until R-EXT-1 (§6.4).

export interface MarketDataType {
  id: string
  label: string
  group: string
  /** `tac-engine` tool(s) that produce the data. */
  tacTools: string[]
  /** The `riga-flow` field the effective value feeds, or `—`. */
  rigaField: string
  editor: 'numeric' | 'matrix' | 'grid' | 'curve' | 'date' | 'pair' | 'window' | 'table'
  note?: string
  /** True when the value is displayed but not sent to riga-flow. */
  displayOnly?: boolean
}

export const MARKET_DATA_TYPES: MarketDataType[] = [
  { id: 'spot', label: 'Spot', group: 'Equity', tacTools: ['get_stock_snapshot', 'get_lake_bars'], rigaField: 'spots[]', editor: 'numeric' },
  { id: 'vol_surface', label: 'Vol surface', group: 'Equity', tacTools: ['vol_surface', 'vol_surface_status'], rigaField: 'vols[] / localVol.grids[]', editor: 'grid', note: 'ATM read is the flat scalar; enable "Dupire local vol" to send the full grid (serials → years at asOf).' },
  { id: 'correlation', label: 'Correlation', group: 'Equity', tacTools: ['corr_matrix', 'corr_calc'], rigaField: 'correlation[][]', editor: 'matrix', note: 'Resolved pairwise value — never 0.' },
  { id: 'dividends', label: 'Dividends', group: 'Equity', tacTools: ['get_corporate_actions'], rigaField: 'dividendYields[]', editor: 'table' },
  { id: 'rates', label: 'Interest rate / curve', group: 'Rates', tacTools: ['get_macro_bars'], rigaField: 'riskFreeRate', editor: 'curve', note: 'Built from FRED DGS tenors (T-EXT-1); collapsed to the scalar riga-flow consumes.' },
  { id: 'as_of', label: 'As-of', group: 'Meta', tacTools: [], rigaField: 'asOf', editor: 'date', note: 'The fetch as_of — never the UI clock.' },
  { id: 'fx_spot', label: 'FX spot', group: 'FX', tacTools: ['get_forex_latest_rates', 'get_forex_rates'], rigaField: '—', editor: 'pair', displayOnly: true, note: 'Not sent to riga-flow (R-EXT-1).' },
  { id: 'fx_vol', label: 'FX vol (realized)', group: 'FX', tacTools: ['get_lake_fx_vol'], rigaField: '—', editor: 'window', displayOnly: true, note: 'Implied fx_vol_surface is spec-only (T-EXT-2); realized vol used.' },
  { id: 'bars', label: 'Bars / TA / SP', group: 'History', tacTools: ['get_lake_bars', 'get_lake_ta', 'get_lake_sp'], rigaField: '—', editor: 'window', displayOnly: true, note: 'Display only.' },
  { id: 'coverage', label: 'Lake coverage', group: 'Meta', tacTools: ['get_lake_coverage', 'get_lake_status', 'validate_lake_dataset'], rigaField: '—', editor: 'table', displayOnly: true },
]

export const MANIPULATION_TARGETS = [
  'spot',
  'volatility',
  'correlation',
  'interest_rate',
  'dividend',
  'fx_spot',
  'fx_volatility',
] as const
