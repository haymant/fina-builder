import { ChevronLeft, ChevronRight, Copy, Plus, Search, Star, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { useDashboardDocsStore, defaultUsage } from '../../../store/dashboardDocsStore'
import { useTheme } from '../../themes/ThemeProvider'
import { DEFAULT_RD_WORKFLOW_YAML, RD_NOTEBOOK_PROMPT } from '../../rd/workflowYamlTemplate'

const EMPTY_NOTES: import('../../../store/dashboardDocsStore').DashboardNote[] = []

export function NotebookDrawer({ dashboardId, dashboardName, open, onClose, rdMode = false }: { dashboardId: string; dashboardName: string; open: boolean; onClose: () => void; rdMode?: boolean }) {
  const { mode } = useTheme()
  const notebookId = rdMode ? 'rd-workspace' : dashboardId
  const title = rdMode ? 'TradeAC R&D' : dashboardName
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
  const visibleNotes = useMemo(() => notes.filter((note) => `${note.title} ${note.content}`.toLowerCase().includes(query.toLowerCase())), [notes, query])

  if (!open) return null
  const saveWidth = (value: number) => {
    const next = Math.max(350, Math.min(Math.round(window.innerWidth * .6), value))
    setWidth(next)
    localStorage.setItem('fina-notebook-width', String(next))
  }
  const selectedNote = notes.find((note) => note.id === selected)
  const usageMarkdown = `# ${title}\n\n## Purpose\n${usage.purpose}\n\n## Target Users\n${usage.targetUsers.join(', ')}\n\n## Workflow\n${usage.workflow}\n\n## Methodology\n${usage.methodology}\n\n## Recommended Actions\n${usage.recommendedActions}\n\n## Related Dashboards\n${usage.relatedDashboards.map((item) => `- ${item}`).join('\n')}`
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyMessage(`${label} copied to clipboard.`)
    } catch {
      setCopyMessage('Clipboard access is unavailable; select and copy the text manually.')
    }
  }
  const promptWithStarter = `${RD_NOTEBOOK_PROMPT}\n\nStarter YAML schema/example to adapt:\n\n\`\`\`yaml\n${DEFAULT_RD_WORKFLOW_YAML.trim()}\n\`\`\``

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
      <div><p className="eyebrow">{rdMode ? 'R&D notebook' : 'Dashboard notebook'}</p><h2 className="text-sm font-semibold text-main">{title}</h2></div>
      <button className="icon-button ml-auto" title="Collapse notebook" onClick={onClose} type="button"><X size={15} /></button>
    </header>
    <div className="notebook-body">
      {rdMode ? <section className="notebook-section">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold text-main">1. External-agent YAML prompt</h3><button className="ghost-button ml-auto inline-flex" title="Copy the prompt and starter YAML" onClick={() => void copy(promptWithStarter, 'Prompt and starter YAML')} type="button"><Copy size={12} /> Copy prompt + YAML</button></div>
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{RD_NOTEBOOK_PROMPT}</ReactMarkdown></div>
        <div className="mt-2 flex items-center gap-2"><button className="ghost-button inline-flex" type="button" onClick={() => void copy(DEFAULT_RD_WORKFLOW_YAML.trim(), 'Starter YAML')}><Copy size={12} /> Copy starter YAML</button><span className="text-[9px] text-muted">Paste the returned YAML into Experiments → + YAML.</span></div>
        {copyMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{copyMessage}</p> : null}
      </section> : <section className="notebook-section">
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-main">1. Usage</h3><button className="icon-button" title="Edit usage" onClick={() => setEditing(editing === 'usage' ? null : 'usage')} type="button">{editing === 'usage' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button></div>
        {editing === 'usage' ? <CodeMirror value={usageMarkdown} height="360px" extensions={[markdown()]} theme={mode} onChange={(value) => updateUsage(notebookId, { purpose: value.replace(/^#.*\n\n/, '').split('## Target Users')[0].replace('## Purpose\n', '').trim() })} /> : <div className="markdown-body" onDoubleClick={() => setEditing('usage')}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{usageMarkdown}</ReactMarkdown></div>}
        <p className="mt-2 text-[9px] text-muted">Last updated {new Date(usage.updatedAt).toLocaleString()} · {usage.editedBy}</p>
      </section>}
      <section className="notebook-section flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold text-main">{rdMode ? '2. R&D notes' : '2. Notes'}</h3><button className="icon-button ml-auto" title="New note" onClick={() => { addNote(notebookId); setSelected(undefined) }} type="button"><Plus size={14} /></button></div>
        <div className="mb-2 flex items-center gap-2"><Search size={13} className="text-muted" /><input className="notebook-search" placeholder="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="notebook-notes-list">{visibleNotes.map((note) => <button type="button" key={note.id} className={`notebook-note-item ${note.id === selected ? 'active' : ''}`} onClick={() => { setSelected(note.id); setEditing(null) }}><span>{note.pinned ? <Star size={11} /> : null}{note.title}</span><small>{new Date(note.updatedAt).toLocaleDateString()}</small></button>)}</div>
        {selectedNote ? <div className="notebook-note-detail"><div className="flex items-center gap-1"><input className="notebook-title" value={selectedNote.title} onChange={(event) => updateNote(notebookId, selectedNote.id, { title: event.target.value })} /><button className="icon-button" title="Pin" onClick={() => togglePin(notebookId, selectedNote.id)} type="button"><Star size={13} /></button><button className="icon-button" title="Duplicate" onClick={() => duplicateNote(notebookId, selectedNote.id)} type="button"><Copy size={13} /></button><button className="icon-button hover:text-danger" title="Delete" onClick={() => deleteNote(notebookId, selectedNote.id)} type="button"><Trash2 size={13} /></button></div>{editing === selectedNote.id ? <CodeMirror value={selectedNote.content} height="220px" extensions={[markdown()]} theme={mode} onChange={(content) => updateNote(notebookId, selectedNote.id, { content })} /> : <div className="markdown-body" onDoubleClick={() => setEditing(selectedNote.id)}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{selectedNote.content}</ReactMarkdown></div>}<p className="text-[9px] text-muted">Updated {new Date(selectedNote.updatedAt).toLocaleString()}</p></div> : <p className="py-6 text-center text-xs text-muted">Create a note to record findings.</p>}
      </section>
    </div>
  </aside>
}
