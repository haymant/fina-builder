// Which pricing source the workspace is driving: the demo `fina-kernel` or the
// live `riga-flow` engine. New state → a new key (§9.4 / I-6).

import { create } from 'zustand'
import type { RigaSource } from '../features/riga/types'

const KEY = 'fina-riga-source'

function load(): { source?: RigaSource } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as { source?: RigaSource }
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

function persist(source: RigaSource) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ source }))
  } catch {
    /* optional */
  }
}

type RigaSourceState = {
  source: RigaSource
  setSource: (source: RigaSource) => void
}

export const useRigaSourceStore = create<RigaSourceState>((set) => ({
  source: saved.source ?? 'demo',
  setSource: (source) => {
    set({ source })
    persist(source)
  },
}))
