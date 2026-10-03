// Cashflow UI selection state only (§5d.3).
//
// The cashflow schedule + analytics come from the `useCashflows` hook; the
// `buildCashflows` implementation lived in this file and was ported to
// fina-kernel in Phase 4. This store holds exactly the selected-row state the
// tile tracks.

import { create } from 'zustand'

type CashflowState = {
  selectedCashflowId: string | null
  selectCashflow: (id: string) => void
}

export const useCashflowStore = create<CashflowState>((set) => ({
  selectedCashflowId: null,
  selectCashflow: (selectedCashflowId) => set({ selectedCashflowId }),
}))

export type { Cashflow, CashflowAnalytics } from '../api/types'