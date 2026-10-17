// riga-flow market-data editor (§6.1/§6.3/§6.6, docs/46 §7.3). Two lanes:
//  - `document`: the market block of the canonical `fina.instrument/v1`
//    document (import it from `1.json`, `termsheet1.md.json`, `termsheet1.json`
//    or edit it inline);
//  - `lake`: the effective tac-engine market (raw fetch + manipulations).
// The lane selects which market `composeRigaRequest` prices against.

import { useEffect, useRef, useState } from 'react'
import { useRigaMarketStore } from '../../../store/rigaMarketStore'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useTacMarketStore } from '../../../store/tacMarketStore'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { composeRigaRequest } from '../../../store/rigaRequestStore'
import { applyManipulations, clampCorrelation, volSurfaceWarnings } from '../../tac/manipulations'
import { effectiveRigaMarket, localVolGridsFromTac } from '../../tac/mapping'
import { INSTRUMENT_LABELS } from '../instrument/ui'
import { TabularForm } from '../instrument/tabular-form'
import { MARKET_DATA_TYPES } from '../marketDataTypes'
import { PanelCard } from '../../shared/components/PanelCard'
import { DataTable, Provenance } from './primitives'

function NumberField({ label, value, step = 'any', onChange }: { label: string; value: number; step?: number | string; onChange: (value: number) => void }) {
  return (
    <label className="block text-[10px] text-muted">
      {label}
      <input className="economics-number-input mt-0.5 w-full" type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

export function RigaMarketDataPanel() {
  const market = useRigaMarketStore((s) => s.market)
  const updateMarket = useRigaMarketStore((s) => s.updateMarket)
  const simulation = useRigaMarketStore((s) => s.simulation)
  const updateSimulation = useRigaMarketStore((s) => s.updateSimulation)
  const useSurfaceLocalVol = useRigaMarketStore((s) => s.useSurfaceLocalVol)
  const setUseSurfaceLocalVol = useRigaMarketStore((s) => s.setUseSurfaceLocalVol)
  const raw = useTacMarketStore((s) => s.raw)
  const manipulations = useTacMarketStore((s) => s.manipulations)
  const level = useObservabilityStore((s) => s.level)

  const document = useInstrumentStore((s) => s.document)
  const marketSource = useInstrumentStore((s) => s.marketSource)
  const setMarketSource = useInstrumentStore((s) => s.setMarketSource)
  const patch = useInstrumentStore((s) => s.patch)
  const importMarketText = useInstrumentStore((s) => s.importMarketText)

  const fileRef = useRef<HTMLInputElement>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    setJson(JSON.stringify(composeRigaRequest(), null, 2))
  }, [market, simulation, raw, manipulations, level, useSurfaceLocalVol, document, marketSource])

  const effective = applyManipulations(raw, manipulations)
  const warnings = Object.values(effective.volSurfaces).flatMap((surface) => volSurfaceWarnings(surface))
  const surfaceGrids = localVolGridsFromTac(effective, market.asOf)

  const setCorrelation = (row: number, col: number, value: number) => {
    const matrix = market.correlation.map((r) => [...r])
    matrix[row]![col] = value
    if (row !== col) matrix[col]![row] = value
    updateMarket({ correlation: clampCorrelation(matrix) })
  }

  const runImport = (text: string, fileName: string | null) => {
    const result = importMarketText(text, fileName)
    setMessage(result.ok ? `Imported market (${result.adapter})` : (result.error ?? 'import failed'))
  }

  return (
    <PanelCard title="riga-flow Market Data" subtitle="effective market → PriceRequest" className="h-full" bodyClassName="overflow-auto">
      <div className="space-y-3 p-3">
        {/* Source lane ------------------------------------------------------ */}
        <div className="flex items-center gap-1">
          {(['document', 'lake'] as const).map((lane) => (
            <button
              key={lane}
              type="button"
              className="shock-button"
              data-active={marketSource === lane}
              onClick={() => setMarketSource(lane)}
            >
              {lane === 'document' ? 'Instrument market' : 'Lake (tac-engine)'}
            </button>
          ))}
          <span className="ml-auto rounded border border-border bg-panel px-1.5 py-0.5 text-[9px] text-muted">
            {marketSource === 'document' ? (document.source.fileName ?? document.source.adapter) : 'tac-engine'}
          </span>
        </div>

        {marketSource === 'document' ? (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" className="shock-button" onClick={() => fileRef.current?.click()}>
                Import market JSON
              </button>
              <button type="button" className="shock-button" onClick={() => setPasteOpen((open) => !open)}>
                Paste
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                data-testid="market-file-input"
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (file) runImport(await file.text(), file.name)
                  event.target.value = ''
                }}
              />
            </div>
            {pasteOpen && (
              <div className="space-y-1">
                <textarea
                  className="economics-number-input h-20 w-full font-mono text-[10px]"
                  placeholder="Paste market JSON (1.json, termsheet1.md.json, termsheet1.json)…"
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                />
                <button type="button" className="shock-button" data-testid="market-paste-import" onClick={() => { runImport(pasteText, 'pasted.json'); setPasteOpen(false) }}>
                  Import pasted market
                </button>
              </div>
            )}
            {message && (
              <p className="rounded border border-border bg-surface px-2 py-1 text-[10px] text-muted" role="status">{message}</p>
            )}
            <TabularForm
              value={document.market as unknown as Record<string, unknown>}
              pathPrefix="/market"
              labels={INSTRUMENT_LABELS}
              onChange={patch}
            />
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {[0, 1].map((index) => (
                <NumberField key={`spot-${index}`} label={`Spot ${index}`} value={market.spots[index] ?? 0} step={0.01} onChange={(value) => {
                  const spots = [...market.spots]
                  spots[index] = value
                  updateMarket({ spots })
                }} />
              ))}
              {[0, 1].map((index) => (
                <NumberField key={`vol-${index}`} label={`ATM vol ${index}`} value={market.vols[index] ?? 0} step={0.0001} onChange={(value) => {
                  const vols = [...market.vols]
                  vols[index] = value
                  updateMarket({ vols })
                }} />
              ))}
              {[0, 1].map((index) => (
                <NumberField key={`div-${index}`} label={`Dividend yield ${index}`} value={market.dividendYields[index] ?? 0} step={0.0001} onChange={(value) => {
                  const dividendYields = [...market.dividendYields]
                  dividendYields[index] = value
                  updateMarket({ dividendYields })
                }} />
              ))}
              <NumberField label="Risk-free rate" value={market.riskFreeRate} step={0.0001} onChange={(value) => updateMarket({ riskFreeRate: value })} />
              <label className="block text-[10px] text-muted">
                As of (date)
                <input
                  className="economics-number-input mt-0.5 w-full"
                  value={market.asOf}
                  onChange={(e) => updateMarket({ asOf: e.target.value })}
                />
              </label>
            </div>

            <div>
              <p className="eyebrow mb-1">Correlation (2×2, PSD-clamped)</p>
              <div className="grid grid-cols-2 gap-1">
                {[0, 1].map((row) =>
                  [0, 1].map((col) => (
                    <input
                      key={`${row}-${col}`}
                      className="economics-number-input w-full"
                      type="number"
                      step="0.01"
                      disabled={row === col}
                      value={market.correlation[row]?.[col] ?? 0}
                      onChange={(e) => setCorrelation(row, col, Number(e.target.value))}
                    />
                  )),
                )}
              </div>
            </div>

            <div>
              <p className="eyebrow mb-1">Simulation</p>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Paths" value={simulation.paths} step={1} onChange={(value) => updateSimulation({ paths: Math.round(value) })} />
                <NumberField label="Path block size" value={simulation.pathBlockSize} step={1} onChange={(value) => updateSimulation({ pathBlockSize: Math.round(value) })} />
                <NumberField label="Seed" value={simulation.seed} step={1} onChange={(value) => updateSimulation({ seed: Math.round(value) })} />
                <label className="block text-[10px] text-muted">
                  Variance reduction
                  <select
                    className="control-select mt-0.5 w-full"
                    value={simulation.varianceReduction.kind}
                    onChange={(e) => updateSimulation({ varianceReduction: { kind: e.target.value as 'none' | 'halton' | 'sobol' } })}
                  >
                    <option value="none">none</option>
                    <option value="halton">halton</option>
                    <option value="sobol">sobol</option>
                  </select>
                </label>
              </div>
              <p className="mt-1 text-[9px] text-muted">trace level (from title bar): {level}</p>
            </div>

            <div>
              <p className="eyebrow mb-1">Dupire local vol</p>
              <label className="flex items-center gap-2 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={useSurfaceLocalVol}
                  onChange={(e) => setUseSurfaceLocalVol(e.target.checked)}
                />
                Use the calibrated tac-engine surface as localVol.grids[]
              </label>
              <p className="mt-1 text-[9px] text-muted">
                {useSurfaceLocalVol
                  ? surfaceGrids
                    ? `maturities → years anchored at asOf ${market.asOf}; ${surfaceGrids.length} factor grid(s)`
                    : 'unavailable — a factor has no usable surface, falling back to the flat ATM scalar'
                  : 'off — pricing on the flat ATM vols[] scalar'}
              </p>
            </div>

            <button
              type="button"
              className="shock-button"
              onClick={() => updateMarket(effectiveRigaMarket(market, effective))}
            >
              apply effective tac-engine market
            </button>

            {warnings.length ? (
              <div className="rounded border border-warning/40 bg-warning/10 p-2 text-[10px] text-warning">
                {warnings.slice(0, 4).map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </>
        )}

        <div>
          <p className="eyebrow mb-1">Source map</p>
          <DataTable
            columns={[
              { key: 'label', label: 'Type' },
              { key: 'tacTools', label: 'tac-engine', render: (row) => row.tacTools.join(', ') || '—' },
              { key: 'rigaField', label: 'riga-field' },
            ]}
            rows={MARKET_DATA_TYPES}
          />
        </div>

        <div>
          <p className="eyebrow mb-1">Assembled PriceRequest (JSON)</p>
          <textarea
            className="h-40 w-full rounded border border-line bg-bg p-2 font-mono text-[10px] text-main"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="shock-button"
              onClick={() => {
                setJsonError(null)
                try {
                  const parsed = JSON.parse(json) as { market?: typeof market; config?: typeof simulation }
                  if (parsed.market) updateMarket(parsed.market)
                  if (parsed.config) updateSimulation({ paths: parsed.config.paths, pathBlockSize: parsed.config.pathBlockSize, seed: parsed.config.seed, varianceReduction: parsed.config.varianceReduction })
                } catch (e) {
                  setJsonError((e as { message?: string }).message ?? String(e))
                }
              }}
            >
              apply JSON
            </button>
            <button type="button" className="shock-button" onClick={() => setJson(JSON.stringify(composeRigaRequest(), null, 2))}>
              revert
            </button>
            {jsonError ? <span className="text-[10px] text-danger">{jsonError}</span> : null}
          </div>
        </div>
        <Provenance tool="rigaRequestStore" />
      </div>
    </PanelCard>
  )
}

export const RigaMarketDataTile = RigaMarketDataPanel
