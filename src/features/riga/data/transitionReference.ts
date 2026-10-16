// Static transition reference (§5.4). This is **reference copy**, not computed:
// each entry is tagged "formula (static)" in the UI and is visually distinct
// from live data. No formula in `fina-builder` is ever evaluated.

export interface TransitionReference {
  id: string
  label: string
  formula: string
  fields: string[]
  note: string
}

export const TRANSITION_REFERENCE: Record<string, TransitionReference> = {
  // Live `riga-mcp` transitions (termsheet1): verified against the engine.
  daily_global_ko: {
    id: 'daily_global_ko',
    label: 'Daily global KO',
    formula: 'ko = min{ t : all names ≥ call barrier }, else u64::MAX',
    fields: ['callStartStep', 'knockOutBarrier'],
    note: 'Daily global autocall gate; first observation where every factor is at/above its call barrier.',
  },
  final_fixing_eki: {
    id: 'final_fixing_eki',
    label: 'Final-fixing EKI',
    formula: 'put = DF·max(exercise − worst[T], 0)·1{worst[T] ≤ KI ∧ ¬KO}',
    fields: ['knockInBarrier', 'strike'],
    note: 'European knock-in down-and-in put on the terminal worst-of.',
  },
  memory_coupon: {
    id: 'memory_coupon',
    label: 'Memory coupon',
    formula: 'daily worst-of ≥ coupon barrier; memory carry enabled',
    fields: ['couponBarrier', 'couponRate', 'memoryCoupon'],
    note: 'Daily accrual with segmented-scan memory carry.',
  },
  worst_of_performance: {
    id: 'worst_of_performance',
    label: 'Worst-of performance',
    formula: 'worst[t] = min_f S_f[t] / S_f[0]',
    fields: ['initialSpots'],
    note: 'Minimum across the (2-factor) basket, per path.',
  },
  global_ko_gate: {
    id: 'global_ko_gate',
    label: 'Global KO gate',
    formula: 'ko = min{ t : worst[t] ≥ K }, else u64::MAX',
    fields: ['knockOutBarrier', 'callStartStep'],
    note: 'First observation at or above the KO barrier.',
  },
  knock_in_gate: {
    id: 'knock_in_gate',
    label: 'Knock-in gate (European)',
    formula: 'ki = worst[T] ≤ KI',
    fields: ['knockInBarrier'],
    note: 'Final-fixing European knock-in.',
  },
  knock_in_alive: {
    id: 'knock_in_alive',
    label: 'Knock-in alive',
    formula: 'put_mask = ki ∧ (ko = u64::MAX)',
    fields: [],
    note: 'KI and never KO\u2019d.',
  },
  down_and_in_put: {
    id: 'down_and_in_put',
    label: 'Down-and-in put',
    formula: 'put = DF·max(strike − worst[T], 0)·1{put_mask}',
    fields: ['strike', 'discount'],
    note: 'Discounted, KI-gated put payoff.',
  },
  notional_return: {
    id: 'notional_return',
    label: 'Notional return',
    formula: 'par at first KO-or-maturity',
    fields: ['knockOutBarrier'],
    note: 'Par redemption on the KO/maturity date.',
  },
  coupon_strip: {
    id: 'coupon_strip',
    label: 'Coupon strip',
    formula: 'coupon = Σ_t rate·1{worst[t] ≥ B} / DF',
    fields: ['couponBarrier', 'couponRate'],
    note: 'Per-period coupon accrual (non-memory).',
  },
  memory_carry: {
    id: 'memory_carry',
    label: 'Memory carry',
    formula: 'segmented-scan memory coupon',
    fields: ['couponBarrier', 'couponRate'],
    note: 'Unpaid coupons carry forward until paid or maturity.',
  },
  aggregate_put: { id: 'aggregate_put', label: 'Aggregate put', formula: 'put_pv = E[put]', fields: [], note: 'Discounted mean.' },
  aggregate_funding: { id: 'aggregate_funding', label: 'Aggregate funding', formula: 'funding_pv = E[funding]', fields: [], note: 'Discounted mean.' },
  aggregate_coupon: { id: 'aggregate_coupon', label: 'Aggregate coupon', formula: 'coupon_pv = E[coupon]', fields: [], note: 'Discounted mean.' },
  aggregate_memory: { id: 'aggregate_memory', label: 'Aggregate memory', formula: 'memory_pv = E[memory_coupon]', fields: [], note: 'Discounted mean.' },
}

export function transitionReference(id: string): TransitionReference | undefined {
  return TRANSITION_REFERENCE[id]
}
