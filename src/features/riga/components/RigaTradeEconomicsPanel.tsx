// Schema-driven trade-economics editor for the riga-flow product (§6.1/§6.2).
// Both a workspace side-panel and a placeable tile (`RigaTradeEconomics`).
// `price_trade` is the authority: an invalid combination shows the structured
// `{code,message}` returned by the engine, never a UI-local rule.

import { useMemo } from 'react'
import { useRigaTradeStore } from '../../../store/rigaTradeStore'
import { useRigaSourceStore } from '../../../store/rigaSourceStore'
import { useRigaTradePrice } from '../hooks'
import { PRODUCT_TYPES, type TradeFieldSpec } from '../productTypes'
import { PanelCard } from '../../shared/components/PanelCard'
import { Kpi, num, Provenance } from './primitives'
import type { RigaPhoenixTrade } from '../types'

function Field({ spec, value, onChange }: { spec: TradeFieldSpec; value: unknown; onChange: (patch: Partial<RigaPhoenixTrade>) => void }) {
  if (spec.kind === 'boolean') {
    return (
      <label className="flex items-center justify-between gap-2 text-[10px] text-muted">
        <span>{spec.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange({ [spec.key]: e.target.checked } as Partial<RigaPhoenixTrade>)}
        />
      </label>
    )
  }
  if (spec.kind === 'text') {
    return (
      <label className="block text-[10px] text-muted">
        {spec.label}
        <input
          className="economics-number-input mt-0.5 w-full"
          value={String(value ?? '')}
          onChange={(e) => onChange({ [spec.key]: e.target.value } as Partial<RigaPhoenixTrade>)}
        />
      </label>
    )
  }
  if (spec.kind === 'numberArray') {
    const array = Array.isArray(value) ? (value as number[]) : []
    return (
      <label className="block text-[10px] text-muted">
        {spec.label}
        <span className="mt-0.5 flex gap-1">
          {[0, 1].map((index) => (
            <input
              key={index}
              className="economics-number-input w-full"
              type="number"
              step={spec.step ?? 'any'}
              value={array[index] ?? ''}
              onChange={(e) => {
                const next = [array[0] ?? 0, array[1] ?? 0]
                next[index] = Number(e.target.value)
                onChange({ [spec.key]: next } as Partial<RigaPhoenixTrade>)
              }}
            />
          ))}
        </span>
      </label>
    )
  }
  return (
    <label className="block text-[10px] text-muted">
      {spec.label}
      <input
        className="economics-number-input mt-0.5 w-full"
        type="number"
        step={spec.kind === 'int' ? 1 : (spec.step ?? 'any')}
        value={value === null || value === undefined ? '' : Number(value)}
        onChange={(e) => {
          const raw = e.target.value
          const parsed = raw === '' ? null : Number(raw)
          const keyed = spec.kind === 'int' && parsed !== null ? Math.round(parsed) : parsed
          onChange({ [spec.key]: keyed } as Partial<RigaPhoenixTrade>)
        }}
      />
    </label>
  )
}

export function RigaTradeEconomicsPanel() {
  const trade = useRigaTradeStore((s) => s.trade)
  const updateTrade = useRigaTradeStore((s) => s.updateTrade)
  const applyPreset = useRigaTradeStore((s) => s.applyPreset)
  const resetTrade = useRigaTradeStore((s) => s.resetTrade)
  const source = useRigaSourceStore((s) => s.source)
  const price = useRigaTradePrice()

  const product = PRODUCT_TYPES[0]!
  const groups = useMemo(() => {
    const map = new Map<string, TradeFieldSpec[]>()
    for (const field of product.fields) {
      map.set(field.group, [...(map.get(field.group) ?? []), field])
    }
    return [...map.entries()]
  }, [product])

  return (
    <PanelCard
      title="riga-flow Trade Economics"
      subtitle={product.name}
      className="h-full"
      bodyClassName="overflow-auto"
      actions={
        <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
          source: {source}
        </span>
      }
    >
      <div className="space-y-3 p-3">
        <p className="text-[10px] text-muted">{product.description}</p>
        <div className="flex flex-wrap gap-1">
          {['Termsheet 1', 'Defensive Phoenix', 'Aggressive Yield', 'No Memory'].map((preset) => (
            <button key={preset} type="button" className="shock-button" onClick={() => applyPreset(preset)}>
              {preset}
            </button>
          ))}
          <button type="button" className="shock-button" onClick={resetTrade}>
            reset
          </button>
        </div>
        {groups.map(([group, fields]) => (
          <div key={group}>
            <p className="eyebrow mb-1">{group}</p>
            <div className="grid grid-cols-2 gap-2">
              {fields.map((field) => (
                <Field key={String(field.key)} spec={field} value={trade[field.key]} onChange={updateTrade} />
              ))}
            </div>
          </div>
        ))}
        <div>
          <p className="eyebrow mb-1">price_trade</p>
          {price.status === 'error' ? (
            <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">{price.error}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Kpi label="PV" value={num(price.data?.pv)} tone="primary" />
              <Kpi label="Engine model" value={price.data?.engineModel ?? '—'} />
              <Kpi label="Seed" value={price.data?.determinism?.seed ?? '—'} />
            </div>
          )}
        </div>
        <Provenance tool="price_trade" runId={price.data?.determinism?.marketSnapshotId} />
      </div>
    </PanelCard>
  )
}

export const RigaTradeEconomicsTile = RigaTradeEconomicsPanel
