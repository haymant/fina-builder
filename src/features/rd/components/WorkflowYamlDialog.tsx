import { useState, type FormEvent } from 'react'
import { CheckCircle2, Play, ShieldCheck, X } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { lakeRecoveryRequest, rdApi, RdApiError, type RdLakeRecoveryRequest, type RdWorkflowValidation } from '../../../api/rdApi'
import { trading2Api } from '../../../api/trading2Api'
import { useTheme } from '../../themes/ThemeProvider'
import { DEFAULT_RD_WORKFLOW_YAML } from '../workflowYamlTemplate'

const btn = 'ghost-button inline-flex'
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const display = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

export function WorkflowYamlDialog({ onClose, onDispatched }: { onClose: () => void; onDispatched: () => void }) {
  const { mode } = useTheme()
  const [yamlText, setYamlText] = useState(DEFAULT_RD_WORKFLOW_YAML)
  const [validation, setValidation] = useState<RdWorkflowValidation | null>(null)
  const [preflight, setPreflight] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [recovery, setRecovery] = useState<RdLakeRecoveryRequest | null>(null)
  // The editor clears validation on every change, so a valid rendered result
  // is necessarily for the current YAML. Keep dispatch gated by that state;
  // dispatch() independently blocks duplicate submissions while busy.
  const canDispatch = validation?.valid === true

  const validate = async (event?: FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setMessage('')
    setValidation(null)
    setPreflight(null)
    setRecovery(null)
    try {
      const result = await rdApi.validateWorkflowYaml(yamlText)
      if (!result.valid || !result.experimentName || !result.configSha256) throw new Error('The R&D service returned an incomplete workflow preflight.')
      setValidation(result)
      setPreflight(result.datasetPreflight as unknown as Record<string, unknown>)
      setMessage('YAML and persisted dataset preflight passed. Review the summary before dispatch.')
    } catch (cause) {
      setMessage(cause instanceof RdApiError ? cause.message : String(cause))
      setRecovery(lakeRecoveryRequest(yamlText, cause))
    } finally {
      setBusy(false)
    }
  }

  const populateLake = async () => {
    if (!recovery || busy) return
    const confirmText = [
      'Populate the missing persisted lake data now?',
      `Market: ${recovery.market}`,
      `Symbols: ${recovery.symbols.join(', ')}`,
      `Daily bars and TA/SP features: ${recovery.start} through ${recovery.end}`,
      'This starts a background MCP lake-loading job and persists downloaded/computed data locally. The authored YAML will not be changed.',
    ].join('\n')
    if (!window.confirm(confirmText)) return
    setBusy(true)
    setMessage(`Starting lake population for ${recovery.symbols.join(', ')}…`)
    try {
      const started = await trading2Api.loadLakeSymbols(recovery)
      if (!started.jobId) throw new Error('The lake loader did not return a job id.')
      let job = started
      while (job.status === 'running' || job.status === 'started' || job.status === 'queued') {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        job = await trading2Api.getLoadStatus(started.jobId)
        setMessage(`Populating lake… ${job.processed}/${job.totalSymbols ?? recovery.symbols.length} symbols processed.`)
      }
      if (job.status !== 'completed') throw new Error(job.error || `Lake population ended with status “${job.status}”.`)
      setMessage('Lake population completed. Revalidating the unchanged YAML…')
      await validate()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async () => {
    if (!canDispatch || busy || !validation) return
    const confirmText = [
      `Dispatch Qlib workflow “${validation.experimentName}” once?`,
      `Model: ${validation.modelClass}`,
      `Market / universe: ${validation.market} / ${validation.universe}`,
      `Train / validation / test: ${validation.train.join(' → ')} / ${validation.validWindow.join(' → ')} / ${validation.test.join(' → ')}`,
      `Seed ${validation.seed}; LightGBM threads fixed at ${validation.numThreads}.`,
      `Config SHA-256: ${validation.configSha256}`,
      'This starts compute and creates a persisted MLflow run. The worker is isolated; no automatic retry will be made.',
    ].join('\n')
    if (!window.confirm(confirmText)) return
    setBusy(true)
    setMessage('Submitting workflow to the isolated Qlib worker…')
    try {
      const result = await rdApi.runWorkflowYaml(yamlText, validation.experimentName)
      setMessage(`Workflow submitted (${display(result.status)}). Refresh Experiments or Runs to read its persisted state.`)
      onDispatched()
    } catch (cause) {
      setMessage(cause instanceof RdApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const dataset = obj(preflight)
  const segments = obj(dataset.segments)
  const latest = (value: unknown) => {
    const segment = obj(value)
    return `${display(segment.rows ?? segment.row_count ?? segment.count)} rows · ${display(segment.date_min ?? segment.dateMin ?? segment.start ?? segment.start_time)} to ${display(segment.date_max ?? segment.dateMax ?? segment.end ?? segment.end_time)}`
  }

  return <div className="modal-backdrop z-50" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section role="dialog" aria-modal="true" aria-label="Create Qlib workflow from YAML" className="expanded-modal flex w-[min(1100px,96vw)] max-w-none flex-col" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div><p className="eyebrow">R&amp;D / New experiment</p><h2 className="text-sm font-semibold text-main">Qlib workflow YAML</h2><p className="text-[11px] text-muted">Bounded workflow schema · service-owned lake and MLflow settings</p></div>
        <button type="button" className="icon-button ml-auto" aria-label="Close YAML editor" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-3 text-[11px] text-muted">Edit the workflow, then validate against the persisted lake. Only the approved Qlib classes and fields are accepted. The service pins a seed and one LightGBM thread, and writes a config fingerprint to MLflow.</p>
        <div className="overflow-hidden rounded border border-line">
          <CodeMirror value={yamlText} height="min(54vh, 620px)" theme={mode} onChange={(value) => { setYamlText(value); setValidation(null); setPreflight(null); setRecovery(null); setMessage('YAML changed. Validate the current text again before dispatch.') }} aria-label="Workflow YAML editor" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btn} onClick={() => void validate()} disabled={busy}><ShieldCheck size={13} /> {busy ? 'Working…' : 'Validate & preflight'}</button>
          {recovery ? <button type="button" className={btn} onClick={() => void populateLake()} disabled={busy}>Populate missing lake data</button> : null}
          <button type="button" className={btn} onClick={() => void dispatch()} disabled={!canDispatch}><Play size={13} /> Dispatch workflow</button>
          {validation?.valid ? <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600"><CheckCircle2 size={12} /> Preflight passed</span> : null}
        </div>
        {validation ? <div className="mt-3 grid gap-2 rounded border border-line bg-bg p-3 text-[11px] sm:grid-cols-2 lg:grid-cols-3" aria-label="Workflow preflight summary">
          <p><span className="text-muted">Experiment:</span> <b>{validation.experimentName}</b></p>
          <p><span className="text-muted">Model:</span> <b>{validation.modelClass}</b></p>
          <p><span className="text-muted">Universe:</span> <b>{validation.universe}</b>{preflight && dataset.universeSize !== undefined ? ` (${display(dataset.universeSize)} symbols)` : ''}</p>
          <p><span className="text-muted">Train:</span> <b>{validation.train.join(' → ')}</b></p>
          <p><span className="text-muted">Validation:</span> <b>{validation.validWindow.join(' → ')}</b></p>
          <p><span className="text-muted">Test:</span> <b>{validation.test.join(' → ')}</b></p>
          <p><span className="text-muted">Determinism:</span> <b>{validation.determinismProfile}</b> (seed {validation.seed}, {validation.numThreads} thread)</p>
          <p className="truncate"><span className="text-muted">Config SHA-256:</span> <code>{validation.configSha256}</code></p>
          {Object.keys(segments).map((key) => <p key={key}><span className="text-muted">{key} data:</span> <b>{latest(segments[key])}</b></p>)}
          {Array.isArray(dataset.allNanDropped) && dataset.allNanDropped.length ? <p className="text-amber-600 sm:col-span-2 lg:col-span-3">All-NaN fields dropped: {dataset.allNanDropped.map(String).join(', ')}</p> : null}
        </div> : null}
        {recovery ? <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-900" role="alert"><b>Requested lake data is not available.</b> Confirming the recovery action will persist daily bars and TA/SP features for {recovery.symbols.join(', ')} from {recovery.start} through {recovery.end}, then validate again. No data is loaded automatically.</div> : null}
        {message ? <p className="mt-3 text-[11px] text-muted" role="status">{message}</p> : null}
      </div>
      <footer className="flex items-center justify-between border-t border-line px-4 py-3 text-[10px] text-muted"><span>Lake population and run creation are separate confirmed actions; neither happens automatically.</span><button type="button" className={btn} onClick={onClose}><X size={12} /> Close</button></footer>
    </section>
  </div>
}
