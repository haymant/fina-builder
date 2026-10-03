// Valuation-explain UI selection state only (§5d.3).
//
// The explain data itself comes from the `useValuationExplain` hook; this store
// holds exactly the `selectedCategory` the tile tracks.

import { create } from 'zustand'

type ValuationExplainState = {
  selectedCategory: string
  selectCategory: (category: string) => void
}

export const useValuationExplainStore = create<ValuationExplainState>((set) => ({
  selectedCategory: 'Volatility Calibration',
  selectCategory: (selectedCategory) => set({ selectedCategory }),
}))