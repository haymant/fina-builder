// Riga Petri-net node selection (§5.3) + the shared net layer. Kept separate from
// the demo `selectedNodeId` (a `PayoffNodeId`) — overloading the demo store would
// break the exhaustive demo graph typing.
//
// One net diagram is the source of truth; `layer` decides which overlay tint it
// draws, and every watcher tile (transition/token detail, risk, explain) reads
// the same `selectedTransitionId` / `selectedPlaceId`.

import { create } from 'zustand'

/** The overlay the single source-of-truth net is tinted by. */
export type RigaNetLayer = 'execution' | 'risk' | 'explain'

type RigaSelectionState = {
  selectedTransitionId: string | null
  selectedPlaceId: string | null
  layer: RigaNetLayer
  selectTransition: (id: string | null) => void
  selectPlace: (id: string | null) => void
  /** Select a node, clearing the other kind (place ↔ transition). */
  selectNode: (kind: 'place' | 'transition', id: string | null) => void
  setLayer: (layer: RigaNetLayer) => void
}

export const useRigaSelectionStore = create<RigaSelectionState>((set) => ({
  selectedTransitionId: null,
  selectedPlaceId: null,
  layer: 'execution',
  selectTransition: (selectedTransitionId) => set({ selectedTransitionId }),
  selectPlace: (selectedPlaceId) => set({ selectedPlaceId }),
  selectNode: (kind, id) =>
    set(
      kind === 'place'
        ? { selectedPlaceId: id, selectedTransitionId: null }
        : { selectedTransitionId: id, selectedPlaceId: null },
    ),
  setLayer: (layer) => set({ layer }),
}))
