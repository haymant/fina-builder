// Which tiles react to the shared simulation-path selection. The workspace shows
// the path stepper only when the current dashboard contains at least one of
// these, so dashboards unrelated to path behaviour stay untouched.

import type { TileType } from './types'

export const PATH_TILE_TYPES: ReadonlySet<TileType> = new Set<TileType>([
  // Path views: the selected path is drawn on top of the population bands.
  'RigaSelectedPathDetail',
  'RigaPathTimeline',
  'RigaQuantileFan',
  // Payoff decision tree: the selected path's branch is highlighted.
  'RigaBranchFlow',
  'RigaPayoffTree',
  'RigaCouponEngine',
  // Path tables: the matching row is highlighted and a row click re-selects.
  'RigaExecutionTape',
  'RigaTokenDetail',
  'RigaCashflowSummary',
])
