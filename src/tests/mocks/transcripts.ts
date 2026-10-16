// Test doubles for the two engine MCP servers, backed by the recorded
// transcripts in `src/features/riga/__tests__/fixtures` and
// `src/features/tac/__tests__/fixtures`. No live engine is required.

import type { PromptMessage, ResourceDescriptor, RigaTask, RigaTransport, ToolDescriptor } from '../../api/rigaTransport'
import { setRigaTransport } from '../../api/rigaTransport'
import { setTacTransport, type TacTransport } from '../../api/tacTransport'
import { toCamelKeys } from '../../api/keyCase'
import { useTacMarketStore } from '../../store/tacMarketStore'
import { EMPTY_TAC_RAW } from '../../store/tacMarketStore'
import type { MarketManipulation, TacMarketRaw } from '../../features/tac/types'
import {
  toBars,
  toCorrelations,
  toCorporateActions,
  toCoverage,
  toCurve,
  toFxRates,
  toFxVol,
  toSnapshot,
  toSpSeries,
  toTaSeries,
  toVolSurface,
} from '../../features/tac/normalize'
import rigaFixture from '../../features/riga/__tests__/fixtures/termsheet1.transcript.json'
import tacFixture from '../../features/tac/__tests__/fixtures/tac-market.transcript.json'

type RigaTranscript = { tools: Record<string, unknown> }

export const RIGA_TRANSCRIPT = rigaFixture as unknown as RigaTranscript
export const TAC_TRANSCRIPT = tacFixture as unknown as {
  tools: Record<string, unknown>
  manipulations: MarketManipulation[]
  forbidden: string[]
}

/** Records every tool call so a test can assert nothing mutating ran. */
export interface CallRecorder {
  calls: Array<{ tool: string; args: unknown }>
}

/** Install a transcript-backed RigaTransport. Returns the call recorder. */
export function installRigaTranscript(): CallRecorder {
  const recorder: CallRecorder = { calls: [] }
  const transport: RigaTransport = {
    async listTools(): Promise<ToolDescriptor[]> {
      return Object.keys(RIGA_TRANSCRIPT.tools).map((name) => ({ name }))
    },
    async callTool<T>(name: string, args?: unknown): Promise<T> {
      recorder.calls.push({ tool: name, args })
      if (!(name in RIGA_TRANSCRIPT.tools)) throw new Error(`unrecorded riga tool: ${name}`)
      // Mirror the transports: the engine is snake_case, the UI camelCase.
      return toCamelKeys(RIGA_TRANSCRIPT.tools[name]) as T
    },
    async listResources(): Promise<ResourceDescriptor[]> {
      return []
    },
    async readResource<T>(uri: string): Promise<T> {
      return { uri } as T
    },
    async listPrompts() {
      return []
    },
    async getPrompt(): Promise<PromptMessage[]> {
      return []
    },
    async getTask(taskId: string): Promise<RigaTask> {
      return { taskId, status: 'completed', progress: 100, result: RIGA_TRANSCRIPT.tools.price_book_async }
    },
  }
  setRigaTransport(transport)
  return recorder
}

/** Install a transcript-backed tac-engine transport. Mutating tools throw. */
export function installTacTranscript(): CallRecorder {
  const recorder: CallRecorder = { calls: [] }
  const forbidden = new Set(TAC_TRANSCRIPT.forbidden)
  const transport: TacTransport = {
    async callTool<T>(name: string, args?: unknown): Promise<T> {
      recorder.calls.push({ tool: name, args })
      if (forbidden.has(name)) throw new Error(`mutating tac-engine tool is not permitted: ${name}`)
      if (!(name in TAC_TRANSCRIPT.tools)) throw new Error(`unrecorded tac tool: ${name}`)
      return toCamelKeys(TAC_TRANSCRIPT.tools[name]) as T
    },
  }
  setTacTransport(transport)
  return recorder
}

/** Preload `tacMarketStore.raw` from the recorded transcript. */
export function preloadTacMarket(): void {
  const tools = TAC_TRANSCRIPT.tools as Record<string, unknown>
  const bars = toBars(tools.get_lake_bars)
  const snapshots: Record<string, ReturnType<typeof toSnapshot>> = {}
  for (const [symbol, series] of Object.entries(bars)) {
    const last = series.bars[series.bars.length - 1]
    if (last) snapshots[symbol] = { symbol, price: last.c, asOf: last.t }
  }
  if (tools.get_stock_snapshot) snapshots.ADBE = toSnapshot('ADBE', tools.get_stock_snapshot)
  const fxVolRows = toFxVol(tools.get_lake_fx_vol)
  const fxVol: Record<string, typeof fxVolRows> = {}
  for (const row of fxVolRows) fxVol[row.pair] = [...(fxVol[row.pair] ?? []), row]
  const fx: Record<string, ReturnType<typeof toFxRates>[number]> = {}
  for (const rate of toFxRates(tools.get_forex_latest_rates)) fx[rate.pair] = rate
  const ta: Record<string, ReturnType<typeof toTaSeries>> = {}
  const sp: Record<string, ReturnType<typeof toSpSeries>> = {}
  const taSeries = toTaSeries('ADBE', tools.get_lake_ta)
  const spSeries = toSpSeries('ADBE', tools.get_lake_sp)
  if (taSeries) ta.ADBE = taSeries
  if (spSeries) sp.ADBE = spSeries

  const raw: TacMarketRaw = {
    ...EMPTY_TAC_RAW,
    bars,
    snapshots,
    correlations: toCorrelations(tools.corr_matrix),
    volSurfaces: (() => {
      const surface = toVolSurface(tools.vol_surface)
      return surface ? { [surface.underlying]: surface } : {}
    })(),
    curve: toCurve(tools.get_macro_bars),
    fx,
    fxVol: fxVol as TacMarketRaw['fxVol'],
    corporateActions: tools.get_corporate_actions ? toCorporateActions(tools.get_corporate_actions) : [],
    coverage: toCoverage(tools.get_lake_coverage),
    ta: ta as TacMarketRaw['ta'],
    sp: sp as TacMarketRaw['sp'],
  }
  useTacMarketStore.setState({ raw, manipulations: TAC_TRANSCRIPT.manipulations, status: 'ready', error: null, revision: 1 })
}

/** Release the test transports (restore detection). */
export function resetTranscripts(): void {
  setRigaTransport(null)
  setTacTransport(null)
}
