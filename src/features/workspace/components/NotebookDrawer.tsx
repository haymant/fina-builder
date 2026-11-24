import { ChevronLeft, ChevronRight, Copy, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { useDashboardDocsStore, defaultUsage } from '../../../store/dashboardDocsStore'
import { useTheme } from '../../themes/ThemeProvider'
import RD_WORKFLOW_SCHEMA_TEXT from '../../../../skills/tradeac-rd/schema/workflow-yaml.schema.json?raw'
import TRADEAC_RD_SKILL from '../../../../skills/tradeac-rd/SKILL.md?raw'
import RD_FEATURE_CANDIDATES from '../../../../skills/tradeac-rd/references/feature-candidates.md?raw'
import { DEFAULT_RD_WORKFLOW_YAML } from '../../rd/workflowYamlTemplate'
import NIP_TRANSCRIPTION_SKILL from '../../../../skills/nip-transcription/SKILL.md?raw'
import NIP_IMPORT_SCHEMA_TEXT from '../../../../skills/nip-transcription/schema/processed-transcript-import.schema.json?raw'
import { narrativeApi } from '../../narrative/api'
import type { NipEvent, NipPodcastEpisode } from '../../narrative/types'

const EMPTY_NOTES: import('../../../store/dashboardDocsStore').DashboardNote[] = []
const RD_STARTER_YAML_HREF = `data:text/yaml;charset=utf-8,${encodeURIComponent(DEFAULT_RD_WORKFLOW_YAML.trim() + '\n')}`
const RD_WORKFLOW_SCHEMA_HREF = `data:application/schema+json;charset=utf-8,${encodeURIComponent(RD_WORKFLOW_SCHEMA_TEXT)}`
const RD_FEATURE_CANDIDATES_HREF = `data:text/markdown;charset=utf-8,${encodeURIComponent(RD_FEATURE_CANDIDATES)}`
const NIP_SKILL_HREF = `data:text/markdown;charset=utf-8,${encodeURIComponent(NIP_TRANSCRIPTION_SKILL)}`
const NIP_IMPORT_SCHEMA_HREF = `data:application/schema+json;charset=utf-8,${encodeURIComponent(NIP_IMPORT_SCHEMA_TEXT)}`
const RD_AGENT_CONTEXT = `# TradeAC R&D YAML workflow authoring and run request\n\n## R&D skill (complete)\n\n${TRADEAC_RD_SKILL.trim()}\n\n## Feature-candidate reference (complete)\n\n${RD_FEATURE_CANDIDATES.trim()}\n\n## Starter YAML (complete reference)\n\n\`\`\`yaml\n${DEFAULT_RD_WORKFLOW_YAML.trim()}\n\`\`\`\n\n## JSON Schema (complete; validates the parsed YAML structure)\n\n\`\`\`json\n${RD_WORKFLOW_SCHEMA_TEXT.trim()}\n\`\`\``

export function NotebookDrawer({ dashboardId, dashboardName, open, onClose, rdMode = false, nipMode = false, nipEpisode = null, nipEvent = null, onNipImportSuccess }: { dashboardId: string; dashboardName: string; open: boolean; onClose: () => void; rdMode?: boolean; nipMode?: boolean; nipEpisode?: NipPodcastEpisode | null; nipEvent?: NipEvent | null; onNipImportSuccess?: () => void }) {
  const { mode } = useTheme()
  const notebookId = rdMode ? 'rd-workspace' : nipMode ? 'nip-workspace' : dashboardId
  const title = rdMode ? 'TradeAC R&D' : nipMode ? 'NIP transcript processing' : dashboardName
  const usage = useDashboardDocsStore((s) => s.usage[notebookId] ?? defaultUsage)
  const notes = useDashboardDocsStore((s) => s.notes[notebookId] ?? EMPTY_NOTES)
  const updateUsage = useDashboardDocsStore((s) => s.updateUsage)
  const addNote = useDashboardDocsStore((s) => s.addNote)
  const updateNote = useDashboardDocsStore((s) => s.updateNote)
  const deleteNote = useDashboardDocsStore((s) => s.deleteNote)
  const duplicateNote = useDashboardDocsStore((s) => s.duplicateNote)
  const togglePin = useDashboardDocsStore((s) => s.togglePin)
  const [width, setWidth] = useState(() => Number(localStorage.getItem('fina-notebook-width') ?? 450))
  const [editing, setEditing] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | undefined>(notes[0]?.id)
  const [query, setQuery] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [importing, setImporting] = useState(false)
  const importInput = useRef<HTMLInputElement | null>(null)
  const visibleNotes = useMemo(() => notes.filter((note) => `${note.title} ${note.content}`.toLowerCase().includes(query.toLowerCase())), [notes, query])

  if (!open) return null
  const saveWidth = (value: number) => {
    const next = Math.max(350, Math.min(Math.round(window.innerWidth * .6), value))
    setWidth(next)
    localStorage.setItem('fina-notebook-width', String(next))
  }
  const selectedNote = notes.find((note) => note.id === selected)
  const usageMarkdown = `# ${title}\n\n## Purpose\n${usage.purpose}\n\n## Target Users\n${usage.targetUsers.join(', ')}\n\n## Workflow\n${usage.workflow}\n\n## Methodology\n${usage.methodology}\n\n## Recommended Actions\n${usage.recommendedActions}\n\n## Related Dashboards\n${usage.relatedDashboards.map((item) => `- ${item}`).join('\n')}`
  const transcriptText = nipEvent?.content_text?.trim() ?? ''
  const selectedEpisodeTitle = nipEpisode?.title || nipEpisode?.source_native_id || nipEpisode?.canonical_url || 'Selected episode'
  const nipAgentContext = nipEvent && transcriptText ? `# Process this retained NIP transcript\n\nUse the workflow that matches your environment: direct NIP processing, an agent working in the fina-builder directory, or an external agent without fina-builder access. Use the registered NIP MCP server only when it is accessible. For this external handoff, return exactly one JSON object matching the schema below; do not wrap it in Markdown or add commentary. Keep claims and entity candidates grounded in this transcript. Every evidence_quote must be copied verbatim and occur exactly once.\n\n## Selected episode metadata\n\n- Title: ${selectedEpisodeTitle}\n- Source: ${nipEvent.source_id}\n- Source episode ID: ${nipEpisode?.source_native_id ?? nipEvent.source_native_id ?? 'not available'}\n- Published: ${nipEvent.times.published_at ?? nipEpisode?.published_at ?? 'not available'}\n- Canonical event ID: ${nipEvent.event_id}\n- Content hash: ${nipEvent.content_hash}\n\n## Complete nip-transcription skill\n\n${NIP_TRANSCRIPTION_SKILL.trim()}\n\n## Import JSON Schema\n\n\`\`\`json\n${NIP_IMPORT_SCHEMA_TEXT.trim()}\n\`\`\`\n\n## Complete retained transcript\n\n${transcriptText}` : ''
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyMessage(`${label} copied to clipboard.`)
    } catch {
      setCopyMessage('Clipboard access is unavailable; select and copy the text manually.')
    }
  }
  const importProcessedTranscript = async (file: File) => {
    setImporting(true)
    setCopyMessage('')
    try {
      if (!nipEvent || !transcriptText) throw new Error('Select a discovered episode with a retained transcript before importing results.')
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The import file must contain one JSON object.')
      const payload = parsed as Record<string, unknown>
      if (payload.event_id !== nipEvent.event_id) throw new Error(`This JSON targets event ${String(payload.event_id ?? '(missing event_id)')}, but the selected transcript is ${nipEvent.event_id}. Select its episode or use the matching JSON.`)
      for (const field of ['producer', 'model', 'prompt_version', 'narrative_title', 'narrative_thesis', 'narrative_summary']) {
        if (typeof payload[field] !== 'string' || (field !== 'narrative_summary' && !(payload[field] as string).trim())) throw new Error(`The JSON import needs a valid "${field}" string.`)
      }
      if (!Array.isArray(payload.entities) || !payload.entities.length || !Array.isArray(payload.claims) || !payload.claims.length) throw new Error('The JSON import needs at least one entity candidate and one claim.')
      await narrativeApi.buildAgentNarrativeGraph(payload)
      setCopyMessage('Import succeeded. Claims and Graph were persisted/rebuilt; reloading views. Radar/Timeline counts remain calculated from canonical events.')
      onNipImportSuccess?.()
    } catch (reason) {
      setCopyMessage(reason instanceof Error ? `Import failed: ${reason.message}` : 'Import failed: the JSON could not be processed.')
    } finally {
      setImporting(false)
      if (importInput.current) importInput.current.value = ''
    }
  }
  return <aside className="notebook-drawer" style={{ width }}>
    <div className="notebook-resize" onMouseDown={(event) => {
      const start = event.clientX
      const initial = width
      const move = (mouseEvent: MouseEvent) => saveWidth(initial - (mouseEvent.clientX - start))
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }} />
    <header className="flex items-center gap-2 border-b border-line px-4 py-3">
      <div><p className="eyebrow">{rdMode ? 'R&D notebook' : nipMode ? 'NIP notebook' : 'Dashboard notebook'}</p><h2 className="text-sm font-semibold text-main">{title}</h2></div>
      <button className="icon-button ml-auto" title="Collapse notebook" onClick={onClose} type="button"><X size={15} /></button>
    </header>
    <div className="notebook-body">
      {rdMode ? <section className="notebook-section">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold text-main">1. TradeAC R&amp;D skill / external-agent prompt</h3><button className="ghost-button ml-auto inline-flex" title="Copy the R&D skill, feature candidates, starter YAML, and JSON Schema" onClick={() => void copy(RD_AGENT_CONTEXT, 'Prompt and context')} type="button"><Copy size={12} /> Copy prompt and context</button></div>
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{TRADEAC_RD_SKILL}</ReactMarkdown></div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><a className="text-[10px] text-muted underline" href={RD_STARTER_YAML_HREF} download="tradeac-rd-workflow.yaml">Download starter YAML</a><a className="text-[10px] text-muted underline" href={RD_WORKFLOW_SCHEMA_HREF} download="workflow-yaml.schema.json" title="Schema with descriptions for every accepted workflow property">Download YAML JSON Schema</a><a className="text-[10px] text-muted underline" href={RD_FEATURE_CANDIDATES_HREF} download="feature-candidates.md">Download feature candidates</a><button className="ghost-button inline-flex" type="button" onClick={() => void copy(DEFAULT_RD_WORKFLOW_YAML.trim(), 'Starter YAML')}><Copy size={12} /> Copy starter YAML</button><span className="text-[9px] text-muted">Paste the returned YAML into Experiments → + YAML.</span></div>
        <p className="mt-1 text-[9px] text-muted">The combined copy includes the complete skill and all linked authoring dependencies.</p>
        {copyMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{copyMessage}</p> : null}
      </section> : nipMode ? <section className="notebook-section">
        <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold text-main">1. NIP transcript-processing skill</h3><button className="ghost-button ml-auto inline-flex" title="Copy the complete NIP skill, selected retained transcript, and import schema for an external agent" onClick={() => void copy(nipAgentContext, 'NIP skill and transcript context')} type="button" disabled={!nipAgentContext}><Copy size={12} /> Copy skill + transcript</button></div>
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{NIP_TRANSCRIPTION_SKILL}</ReactMarkdown></div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><a className="text-[10px] text-muted underline" href={NIP_SKILL_HREF} download="nip-transcription-SKILL.md">Download nip-transcription skill</a><a className="text-[10px] text-muted underline" href={NIP_IMPORT_SCHEMA_HREF} download="processed-transcript-import.schema.json">Download import JSON Schema</a></div>
        <div className="mt-3 rounded border border-line bg-bg p-2">
          <p className="eyebrow">Selected discovered episode</p>
          {nipEpisode ? <><p className="mt-1 text-xs font-semibold text-main">{selectedEpisodeTitle}</p><p className="mt-1 break-all text-[10px] text-muted">{nipEpisode.source_id} · {nipEpisode.source_native_id ?? 'No source episode ID'}</p></> : <p className="mt-1 text-[10px] text-muted">Select an item in Discovered Episodes to load its retained transcript here.</p>}
          {nipEvent && transcriptText ? <><p className="mt-1 break-all text-[9px] text-muted">Event {nipEvent.event_id}</p><a className="mt-1 inline-block text-[10px] text-primary underline" href={`data:text/plain;charset=utf-8,${encodeURIComponent(transcriptText)}`} download={`${nipEvent.event_id}.txt`} title="Open or download the complete retained transcript">Open retained transcript</a></> : nipEpisode ? <p className="mt-1 text-[10px] text-amber-700">No retained transcript is available yet. Transcribe this episode first.</p> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input ref={importInput} className="hidden" type="file" accept=".json,application/json" aria-label="Processed transcript JSON file" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importProcessedTranscript(file) }} />
          <button className="ghost-button inline-flex" type="button" title="Import processed transcript JSON: save evidence-linked claims and narrative, rebuild Graph, and refresh views. Radar/Timeline counts remain based on canonical events." disabled={!nipEvent || !transcriptText || importing} onClick={() => importInput.current?.click()}><Upload size={12} /> {importing ? 'Importing…' : 'Import'}</button>
          <span className="text-[9px] text-muted">Copy context for direct model processing, a working-directory agent, or an external agent; import its JSON result.</span>
        </div>
        {copyMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{copyMessage}</p> : null}
      </section> : <section className="notebook-section">
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-main">1. Usage</h3><button className="icon-button" title="Edit usage" onClick={() => setEditing(editing === 'usage' ? null : 'usage')} type="button">{editing === 'usage' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button></div>
        {editing === 'usage' ? <CodeMirror value={usageMarkdown} height="360px" extensions={[markdown()]} theme={mode} onChange={(value) => updateUsage(notebookId, { purpose: value.replace(/^#.*\n\n/, '').split('## Target Users')[0].replace('## Purpose\n', '').trim() })} /> : <div className="markdown-body" onDoubleClick={() => setEditing('usage')}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{usageMarkdown}</ReactMarkdown></div>}
        <p className="mt-2 text-[9px] text-muted">Last updated {new Date(usage.updatedAt).toLocaleString()} · {usage.editedBy}</p>
      </section>}
      <section className="notebook-section flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold text-main">{rdMode ? '2. R&D notes' : nipMode ? '2. NIP notes' : '2. Notes'}</h3><button className="icon-button ml-auto" title="New note" onClick={() => { addNote(notebookId); setSelected(undefined) }} type="button"><Plus size={14} /></button></div>
        <div className="mb-2 flex items-center gap-2"><Search size={13} className="text-muted" /><input className="notebook-search" placeholder="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="notebook-notes-list">{visibleNotes.map((note) => <button type="button" key={note.id} className={`notebook-note-item ${note.id === selected ? 'active' : ''}`} onClick={() => { setSelected(note.id); setEditing(null) }}><span>{note.pinned ? <Star size={11} /> : null}{note.title}</span><small>{new Date(note.updatedAt).toLocaleDateString()}</small></button>)}</div>
        {selectedNote ? <div className="notebook-note-detail"><div className="flex items-center gap-1"><input className="notebook-title" value={selectedNote.title} onChange={(event) => updateNote(notebookId, selectedNote.id, { title: event.target.value })} /><button className="icon-button" title="Pin" onClick={() => togglePin(notebookId, selectedNote.id)} type="button"><Star size={13} /></button><button className="icon-button" title="Duplicate" onClick={() => duplicateNote(notebookId, selectedNote.id)} type="button"><Copy size={13} /></button><button className="icon-button hover:text-danger" title="Delete" onClick={() => deleteNote(notebookId, selectedNote.id)} type="button"><Trash2 size={13} /></button></div>{editing === selectedNote.id ? <CodeMirror value={selectedNote.content} height="220px" extensions={[markdown()]} theme={mode} onChange={(content) => updateNote(notebookId, selectedNote.id, { content })} /> : <div className="markdown-body" onDoubleClick={() => setEditing(selectedNote.id)}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{selectedNote.content}</ReactMarkdown></div>}<p className="text-[9px] text-muted">Updated {new Date(selectedNote.updatedAt).toLocaleString()}</p></div> : <p className="py-6 text-center text-xs text-muted">Create a note to record findings.</p>}
      </section>
    </div>
  </aside>
}
