// Compact simulation-path control (docs/49 P3g) — one global selection drives
// every path-dependent tile. Kept next to the dashboard actions so it is always
// in reach while the tiles re-plot below it.
//
// The number is a scrubbable rotator: drag horizontally to run through paths,
// click to type an exact index, or use the arrows / dice. It navigates the
// bounded cube `path_series` renders (the engine caps it at 1024 paths), so the
// index shown here is the index the engine actually replays.

import { ChevronLeft, ChevronRight, Dices } from 'lucide-react'
import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { useSelectedPathSeries } from '../hooks'

/** Pixels of horizontal drag per path. Shift makes each pixel cover more paths. */
const PX_PER_PATH = 5
const PX_PER_PATH_COARSE = 40

export function PathStepper() {
  const pathId = useRigaSelectionStore((s) => s.selectedPathId)
  const pathCount = useRigaSelectionStore((s) => s.pathCount)
  const selectPath = useRigaSelectionStore((s) => s.selectPath)
  const stepPath = useRigaSelectionStore((s) => s.stepPath)
  const randomPath = useRigaSelectionStore((s) => s.randomPath)
  // Publishes the cube size back to the store on every load.
  const series = useSelectedPathSeries()
  const [draft, setDraft] = useState<string | null>(null)
  const scrub = useRef<{ startX: number; startId: number; moved: boolean } | null>(null)
  const ready = pathCount > 0
  const loading = series.status === 'loading'

  const commit = () => {
    if (draft !== null) {
      const parsed = Number.parseInt(draft.replace(/[^0-9]/g, ''), 10)
      if (Number.isFinite(parsed)) selectPath(parsed)
    }
    setDraft(null)
  }

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (!ready) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    scrub.current = { startX: event.clientX, startId: pathId, moved: false }
  }
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const active = scrub.current
    if (!active) return
    const dx = event.clientX - active.startX
    if (!active.moved && Math.abs(dx) < 3) return
    active.moved = true
    const per = event.shiftKey ? PX_PER_PATH_COARSE : PX_PER_PATH
    selectPath(active.startId + Math.round(dx / per))
  }
  const onPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const active = scrub.current
    scrub.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // A click (no drag) opens the index for typing.
    if (active && !active.moved) setDraft(String(pathId))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') setDraft(null)
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const parsed = Number.parseInt((draft ?? '').replace(/[^0-9]/g, ''), 10)
      const start = Number.isFinite(parsed) ? parsed : pathId
      const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? step : -step
      setDraft(String(Math.min(Math.max(start + delta, 0), Math.max(pathCount - 1, 0))))
    }
  }
  // When the number itself has focus (not the input), the arrows step the shared
  // selection directly; Enter opens the index for typing.
  const onValueKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      setDraft(String(pathId))
      return
    }
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault()
      stepPath(step)
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault()
      stepPath(-step)
    }
  }

  return (
    <div
      className={`path-stepper${loading ? ' path-stepper-busy' : ''}`}
      role="group"
      aria-label="Simulation path"
      data-testid="path-stepper"
    >
      <span className="path-stepper-label">Path</span>
      <button
        type="button"
        className="path-stepper-button"
        title="Previous path"
        aria-label="Previous path"
        disabled={!ready}
        onClick={() => stepPath(-1)}
      >
        <ChevronLeft size={13} />
      </button>
      <span
        className="path-stepper-value"
        role="spinbutton"
        tabIndex={ready ? 0 : -1}
        aria-valuemin={0}
        aria-valuemax={Math.max(pathCount - 1, 0)}
        aria-valuenow={pathId}
        aria-valuetext={`Path ${pathId} of ${pathCount}`}
        title="Drag to scrub · click to type an index · Shift drags faster"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { scrub.current = null }}
        onKeyDown={onValueKeyDown}
        onDoubleClick={() => { if (ready) setDraft(String(pathId)) }}
      >
        <span className="path-stepper-hash">#</span>
        {draft === null ? (
          <span className="path-stepper-number">{pathId.toLocaleString()}</span>
        ) : (
          <input
            className="path-stepper-input"
            aria-label="Path index"
            inputMode="numeric"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
        )}
        <span className="path-stepper-count">/ {ready ? pathCount.toLocaleString() : '—'}</span>
      </span>
      <button
        type="button"
        className="path-stepper-button"
        title="Next path"
        aria-label="Next path"
        disabled={!ready}
        onClick={() => stepPath(1)}
      >
        <ChevronRight size={13} />
      </button>
      <button
        type="button"
        className="path-stepper-button"
        title="Random path"
        aria-label="Random path"
        disabled={!ready}
        onClick={randomPath}
      >
        <Dices size={13} />
      </button>
    </div>
  )
}
