// Schema-driven riga-flow market-data editor (§6.1/§6.3/§6.6). Both a workspace
// side-panel and a placeable tile (`RigaMarketData`). It edits the *effective*
// riga-flow market inputs; the raw fetch + manipulations live in the tac-engine
// workbench, which maps onto these fields.

import { useEffect, useState } from 'react'
import { useRigaMarketStore } from '../../../store/rigaMarketStore'
import { useTacMarketStore } from '../../../store/tacMarketStore'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { composeRigaRequest } from '../../../store/rigaRequestStore'
import { applyManipulations, clampCorrelation, volSurfaceWarnings } from '../../tac/manipulations'
import { effectiveRigaMarket } from '../../tac/mapping'
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
  const raw = useTacMarketStore((s) => s.raw)
  const manipulations = useTacMarketStore((s) => s.manipulations)
  const level = useObservabilityStore((s) => s.level)
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    setJson(JSON.stringify(composeRigaRequest(), null, 2))
  }, [market, simulation, raw, manipulations, level])

  const effective = applyManipulations(raw, manipulations)
  const warnings = Object.values(effective.volSurfaces).flatMap((surface) => volSurfaceWarnings(surface))

  const setCorrelation = (row: number, col: number, value: number) => {
    const matrix = market.correlation.map((r) => [...r])
    matrix[row]![col] = value
    if (row !== col) matrix[col]![row] = value
    updateMarket({ correlation: clampCorrelation(matrix) })
  }

  return (
    <PanelCard title="riga-flow Market Data" subtitle="effective market → PriceRequest" className="h-full" bodyClassName="overflow-auto">
      <div className="space-y-3 p-3">
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
