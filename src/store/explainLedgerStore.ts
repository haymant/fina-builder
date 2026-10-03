// Explain-ledger UI selection state only (§5d.3).
//
// The ledger entries + reconciliation come from the `useExplainLedger` hook;
// this store holds exactly the selection state the tile tracks.

import { create } from 'zustand'

export type ExplainSource = 'market' | 'plva' | 'cashflow' | 'valuation' | 'risk'

type ExplainLedgerState = {
  selectedEntryId?: string
  selectedSource?: ExplainSource
  selectEntry: (id: string) => void
  selectSource: (source?: ExplainSource) => void
}

export const useExplainLedgerStore = create<ExplainLedgerState>((set) => ({
  selectedEntryId: undefined,
  selectedSource: undefined,
  selectEntry: (selectedEntryId) => set({ selectedEntryId }),
  selectSource: (selectedSource) => set({ selectedSource }),
}))