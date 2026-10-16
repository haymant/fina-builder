// Riga Petri-net node selection (§5.3). Kept separate from the demo
// `selectedNodeId` (a `PayoffNodeId`) — overloading the demo store would break
// the exhaustive demo graph typing.

import { create } from 'zustand'

type RigaSelectionState = {
  selectedTransitionId: string | null
  selectedPlaceId: string | null
  selectTransition: (id: string | null) => void
  selectPlace: (id: string | null) => void
}

export const useRigaSelectionStore = create<RigaSelectionState>((set) => ({
  selectedTransitionId: null,
  selectedPlaceId: null,
  selectTransition: (selectedTransitionId) => set({ selectedTransitionId }),
  selectPlace: (selectedPlaceId) => set({ selectedPlaceId }),
}))
