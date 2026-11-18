// Riga Petri-net node selection (§5.3) + the shared net layer. Kept separate from
// the demo `selectedNodeId` (a `PayoffNodeId`) — overloading the demo store would
// break the exhaustive demo graph typing.
//
// One net diagram is the source of truth; `layer` decides which overlay tint it
// draws, and every watcher tile (transition/token detail, risk, explain) reads
// the same `selectedTransitionId` / `selectedPlaceId`.
//
// The same store also holds the selected simulation path (§5.3b): the path cube
// window that `path_series` renders. Every path-dependent tile reads
// `selectedPathId`, so stepping the path re-plots the timeline, replays the
// branch flow and re-targets the token tape from one control.

import { create } from 'zustand'
import type { PathRecord } from '../features/riga/types'

/** The overlay the single source-of-truth net is tinted by. */
export type RigaNetLayer = 'execution' | 'risk' | 'explain'

/** `path_series` builds a bounded cube; the engine caps it at this many paths. */
export const PATH_CUBE_CAP = 1024

/** One `get_path` result, keyed by request generation + path index. */
export type CachedPathRecord = { key: string; record: PathRecord }

type RigaSelectionState = {
  selectedTransitionId: string | null
  selectedPlaceId: string | null
  layer: RigaNetLayer
  selectedPathId: number
  /** Number of paths in the bounded cube (0 until the first `path_series`). */
  pathCount: number
  cachedPath: CachedPathRecord | null
  /** The fixing step clicked on the Path Timeline, scoped to one path. */
  selectedObservation: { pathId: number; step: number } | null
  selectTransition: (id: string | null) => void
  selectPlace: (id: string | null) => void
  /** Select a node, clearing the other kind (place ↔ transition). */
  selectNode: (kind: 'place' | 'transition', id: string | null) => void
  setLayer: (layer: RigaNetLayer) => void
  selectPath: (id: number) => void
  /** Step by `delta` paths, wrapping inside the cube window. */
  stepPath: (delta: number) => void
  randomPath: () => void
  setPathCount: (count: number) => void
  cachePath: (key: string, record: PathRecord) => void
  /** Pin a fixing step of the selected path (Path Timeline dot). */
  selectObservation: (pathId: number, step: number) => void
}

function clampPath(id: number, count: number): number {
  if (!Number.isFinite(id)) return 0
  // Until `path_series` reports the cube size the upper bound is unknown: accept
  // the id as-is (a tape row can select before the stepper has loaded) and let
  // `setPathCount` re-clamp once the real window arrives.
  if (count <= 0) return Math.max(Math.round(id), 0)
  const max = count - 1
  return Math.min(Math.max(Math.round(id), 0), max)
}

export const useRigaSelectionStore = create<RigaSelectionState>((set, get) => ({
  selectedTransitionId: null,
  selectedPlaceId: null,
  layer: 'execution',
  selectedPathId: 0,
  pathCount: 0,
  cachedPath: null,
  selectedObservation: null,
  selectTransition: (selectedTransitionId) => set({ selectedTransitionId }),
  selectPlace: (selectedPlaceId) => set({ selectedPlaceId }),
  selectNode: (kind, id) =>
    set(
      kind === 'place'
        ? { selectedPlaceId: id, selectedTransitionId: null }
        : { selectedTransitionId: id, selectedPlaceId: null },
    ),
  setLayer: (layer) => set({ layer }),
  selectPath: (id) => set({ selectedPathId: clampPath(id, get().pathCount), selectedObservation: null }),
  stepPath: (delta) => {
    const { selectedPathId, pathCount } = get()
    if (pathCount <= 0) return
    const next = ((selectedPathId + Math.trunc(delta)) % pathCount + pathCount) % pathCount
    set({ selectedPathId: next, selectedObservation: null })
  },
  randomPath: () => {
    const { pathCount } = get()
    if (pathCount <= 0) return
    set({ selectedPathId: Math.floor(Math.random() * pathCount), selectedObservation: null })
  },
  setPathCount: (count) => {
    const pathCount = Math.min(Math.max(Math.round(count), 0), PATH_CUBE_CAP)
    set((state) => ({ pathCount, selectedPathId: clampPath(state.selectedPathId, pathCount) }))
  },
  cachePath: (key, record) => set({ cachedPath: { key, record } }),
  selectObservation: (pathId, step) => set({ selectedObservation: { pathId, step } }),
}))
