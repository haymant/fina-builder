// Instrument editor for the riga-flow product (§6.1/§6.2, docs/46 §7.2). The
// tile edits the canonical `fina.instrument/v1` document with the deep-form
// editor and imports/pastes instrument JSON (`1.json`, `termsheet1.md.json`,
// `termsheet1.json`). `price_trade` remains the authority: an invalid
// combination shows the structured `{code,message}` returned by the engine,
// never a UI-local rule.

import { useRef, useState } from 'react'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useRigaSourceStore } from '../../../store/rigaSourceStore'
import { useRigaTradePrice } from '../hooks'
import { RIGA_TRADE_PRESETS } from '../../../store/rigaTradeStore'
import { INSTRUMENT_LABELS } from '../instrument/ui'
import { TabularForm } from '../instrument/tabular-form'
import { PanelCard } from '../../shared/components/PanelCard'
import { Kpi, num, Provenance } from './primitives'

const SOURCE_BADGE: Record<string, string> = {
  'murex-chunk@1': 'Murex chunk',
  'riga-fixture@1': 'riga fixture',
  manual: 'manual',
}

export function RigaTradeEconomicsPanel() {
  const document = useInstrumentStore((s) => s.document)
  const applyDocument = useInstrumentStore((s) => s.applyDocument)
  const patch = useInstrumentStore((s) => s.patch)
  const importText = useInstrumentStore((s) => s.importText)
  const reset = useInstrumentStore((s) => s.reset)
  const source = useRigaSourceStore((s) => s.source)
  const price = useRigaTradePrice()

  const fileRef = useRef<HTMLInputElement>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const runImport = (text: string, fileName: string | null) => {
    const result = importText(text, fileName)
    setMessage(result.ok ? `Imported (${SOURCE_BADGE[result.adapter ?? ''] ?? result.adapter})` : (result.error ?? 'import failed'))
  }

  const applyPreset = (name: string) => {
    const preset = RIGA_TRADE_PRESETS[name]
    if (!preset) return
    const next = structuredClone(document)
    const put = next.legs.find((leg) => leg.put)?.put
    if (!put) return
    put.strike = preset.strike
    put.knockInBarrier = preset.knockInBarrier
    put.knockOutBarrier = preset.knockOutBarrier
    put.couponRate = preset.couponRate
    put.memoryCoupon = preset.memoryCoupon
    applyDocument(next)
  }

  return (
    <PanelCard
      title="riga-flow Trade Economics"
      subtitle="fina.instrument/v1"
      className="h-full"
      bodyClassName="overflow-auto"
      actions={
        <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
          source: {source}
        </span>
      }
    >
      <div className="space-y-3 p-3">
        {/* Import / paste / reset ------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className="shock-button" onClick={() => fileRef.current?.click()}>
            Import JSON
          </button>
          <button type="button" className="shock-button" onClick={() => setPasteOpen((open) => !open)}>
            Paste
          </button>
          <button type="button" className="shock-button" onClick={() => { reset(); setMessage('Reset to the flat defaults') }}>
            Reset
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="instrument-file-input"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (file) runImport(await file.text(), file.name)
              event.target.value = ''
            }}
          />
          <span className="ml-auto rounded border border-border bg-panel px-1.5 py-0.5 text-[9px] text-muted">
            {SOURCE_BADGE[document.source.adapter] ?? document.source.adapter}
            {document.source.fileName ? ` · ${document.source.fileName}` : ''}
          </span>
        </div>

        {pasteOpen && (
          <div className="space-y-1">
            <textarea
              className="economics-number-input h-24 w-full font-mono text-[10px]"
              placeholder="Paste instrument JSON (1.json, termsheet1.md.json, termsheet1.json)…"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <button
              type="button"
              className="shock-button"
              data-testid="instrument-paste-import"
              onClick={() => { runImport(pasteText, 'pasted.json'); setPasteOpen(false) }}
            >
              Import pasted JSON
            </button>
          </div>
        )}

        {message && (
          <p className="rounded border border-border bg-surface px-2 py-1 text-[10px] text-muted" role="status">
            {message}
          </p>
        )}

        {/* Presets ---------------------------------------------------------- */}
        <div className="flex flex-wrap gap-1">
          {['Termsheet 1', 'Defensive Phoenix', 'Aggressive Yield', 'No Memory'].map((preset) => (
            <button key={preset} type="button" className="shock-button" onClick={() => applyPreset(preset)}>
              {preset}
            </button>
          ))}
        </div>

        {/* The document, as a finap-style heuristic tabular form. */}
        <TabularForm
          value={document as unknown as Record<string, unknown>}
          labels={INSTRUMENT_LABELS}
          onChange={patch}
        />

        {/* Findings --------------------------------------------------------- */}
        {document.issues.length > 0 && (
          <div>
            <p className="eyebrow mb-1">Findings ({document.issues.length})</p>
            <ul className="space-y-1">
              {document.issues.map((issue, index) => (
                <li
                  key={`${issue.code}-${index}`}
                  className={
                    issue.severity === 'error'
                      ? 'rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger'
                      : issue.severity === 'warn'
                        ? 'rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-text-main'
                        : 'rounded border border-border bg-surface px-2 py-1 text-[10px] text-muted'
                  }
                >
                  <span className="font-mono">{issue.code}</span> · {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* price_trade — the authority -------------------------------------- */}
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
