import { create } from 'zustand'
import { simulationBundle } from '../mock-data/generatePaths'
import type { PayoffNodeId, ThemeMode } from '../features/shared/types'

interface ExplorerState {
  selectedPathId: string
  selectedNodeId: PayoffNodeId
  selectedDateIndex: number
  theme: ThemeMode
  setSelectedPathId: (id: string) => void
  setSelectedNodeId: (id: PayoffNodeId) => void
  setSelectedDateIndex: (index: number) => void
  toggleTheme: () => void
  selectRandomPath: () => void
}

const initialPath = simulationBundle.paths[0]!

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  selectedPathId: initialPath.id,
  selectedNodeId: 'PathCube',
  selectedDateIndex: 0,
  theme: 'dark',

  setSelectedPathId: (id) => {
    const path = simulationBundle.paths.find((p) => p.id === id)
    if (!path) return
    set({
      selectedPathId: id,
      selectedDateIndex: 0,
      selectedNodeId: path.traversal[0] ?? 'PathCube',
    })
  },

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  setSelectedDateIndex: (index) => set({ selectedDateIndex: index }),

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', next === 'dark')
    document.documentElement.classList.toggle('light', next === 'light')
    set({ theme: next })
  },

  selectRandomPath: () => {
    const { selectedPathId } = get()
    const others = simulationBundle.paths.filter((p) => p.id !== selectedPathId)
    const pick = others[Math.floor(Math.random() * others.length)]
    if (pick) get().setSelectedPathId(pick.id)
  },
}))

export function useSelectedPath() {
  const id = useExplorerStore((s) => s.selectedPathId)
  return simulationBundle.paths.find((p) => p.id === id) ?? simulationBundle.paths[0]!
}
