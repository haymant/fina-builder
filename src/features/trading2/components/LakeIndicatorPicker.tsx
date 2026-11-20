import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CATEGORIES, indicatorsByCategory, selectionLabel, VOLUME_RAW } from '../indicatorCatalog'
import type { IndicatorDef, SelectedIndicator } from '../marketTypes'

const buttonClass = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-main hover:border-primary'
const inputClass = 'w-20 rounded border border-line bg-bg px-1.5 py-1 text-[11px] text-main'

type Props = {
  selection: SelectedIndicator[]
  includeVolume: boolean
  updateLake: boolean
  onApply: (selection: SelectedIndicator[], includeVolume: boolean, updateLake: boolean) => void
}

export function LakeIndicatorPicker({ selection, includeVolume, updateLake, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(selection)
  const [draftVolume, setDraftVolume] = useState(includeVolume)
  const [draftPersist, setDraftPersist] = useState(updateLake)
  const [periods, setPeriods] = useState<Record<string, string>>({})
  const grouped = indicatorsByCategory()

  const openPicker = () => {
    setDraft(selection.map((item) => ({ id: item.id, periods: [...item.periods] })))
    setDraftVolume(includeVolume)
    setDraftPersist(updateLake)
    setPeriods(Object.fromEntries(selection.map((item) => [item.id, item.periods.join(',')])))
    setOpen(true)
  }
  const closePicker = () => {
    setOpen(false)
    onApply(draft, draftVolume, draftPersist)
  }
  const toggle = (item: IndicatorDef, checked: boolean) => {
    if (item.id === 'volume') return setDraftVolume(checked)
    setDraft((current) => checked
      ? current.some((selected) => selected.id === item.id) ? current : [...current, { id: item.id, periods: [...item.defaultPeriods] }]
      : current.filter((selected) => selected.id !== item.id))
  }
  const setPeriod = (item: IndicatorDef, raw: string) => {
    setPeriods((current) => ({ ...current, [item.id]: raw }))
    const values = raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 2)
    setDraft((current) => current.map((selected) => selected.id === item.id ? { ...selected, periods: values } : selected))
  }
  const checked = (id: string) => id === 'volume' ? draftVolume : draft.some((item) => item.id === id)
  const render = (item: IndicatorDef) => {
    const isChecked = checked(item.id)
    const value = periods[item.id] ?? (draft.find((selected) => selected.id === item.id)?.periods.join(',') || item.defaultPeriods.join(','))
    return <label key={item.id} className="flex min-w-0 items-start gap-2 rounded px-1 py-1 hover:bg-bg">
      <input type="checkbox" className="mt-1" checked={isChecked} onChange={(event) => toggle(item, event.target.checked)} />
      <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-xs font-medium text-main"><span>{item.name}</span>{item.needsPeriod ? <input className={inputClass} value={value} disabled={!isChecked} aria-label={`${item.name} periods`} onChange={(event) => setPeriod(item, event.target.value)} /> : null}</span><span className="block truncate text-[10px] text-muted" title={item.longDescription}>{item.description}</span></span>
    </label>
  }
  return <div className="relative">
    <button type="button" className={buttonClass} onClick={() => open ? closePicker() : openPicker()} aria-expanded={open}><span className="max-w-[260px] truncate font-mono">{selectionLabel(selection, includeVolume)}</span><ChevronDown size={13} className={open ? 'rotate-180' : ''} /></button>
    {open ? <div className="absolute right-0 z-20 mt-2 w-[min(720px,calc(100vw-2rem))] rounded-lg border border-line bg-panel p-3 shadow-xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2"><div><b className="text-xs text-main">Indicators and stochastic features</b><p className="text-[10px] text-muted">TradeAC catalog · closes apply to get_lake_ta / get_lake_sp</p></div><label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={draftPersist} onChange={(event) => setDraftPersist(event.target.checked)} /> Persist generated features to lake</label></div>
      <div className="max-h-[52vh] overflow-auto space-y-4">{CATEGORIES.map((category) => <section key={category.id}><div className="mb-1"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-main">{category.title}</h3><p className="text-[10px] text-muted">{category.blurb}</p></div><div className="grid gap-x-3 sm:grid-cols-2">{(category.id === 'volume' ? [VOLUME_RAW, ...grouped.volume] : grouped[category.id]).map(render)}</div></section>)}</div>
      <div className="mt-3 flex justify-end border-t border-line pt-2"><button type="button" className={buttonClass} onClick={closePicker}>Apply</button></div>
    </div> : null}
  </div>
}
