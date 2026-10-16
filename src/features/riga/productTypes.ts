// Product-type registry (§6.1/§6.2). A product declares its trade fields; the
// editor is registry-driven, so adding a product is a registry entry — not new
// JSX. `riga-flow` prices exactly one product today.

import type { RigaPhoenixTrade } from './types'

export type FieldKind = 'number' | 'int' | 'boolean' | 'text' | 'numberArray'

export interface TradeFieldSpec {
  key: keyof RigaPhoenixTrade
  label: string
  kind: FieldKind
  group: string
  step?: number
  min?: number
  max?: number
  nullable?: boolean
  help?: string
}

export interface ProductType {
  id: string
  name: string
  description: string
  /** Provenance tag: which engine capability this product needs. */
  engine: string
  fields: TradeFieldSpec[]
}

const phoenixFields: TradeFieldSpec[] = [
  { key: 'tradeId', label: 'Trade id', kind: 'text', group: 'Identity' },
  { key: 'initialSpots', label: 'Initial spots (2)', kind: 'numberArray', group: 'Identity', help: 'Per-factor initial fixing; length 2.' },
  { key: 'maturityYears', label: 'Maturity (years)', kind: 'number', group: 'Schedule', step: 0.01, min: 0.01 },
  { key: 'steps', label: 'Observation steps', kind: 'int', group: 'Schedule', step: 1, min: 1 },
  { key: 'callStartStep', label: 'Call start step', kind: 'int', group: 'Schedule', step: 1, min: 0, nullable: true },
  { key: 'strike', label: 'Strike', kind: 'number', group: 'Barriers', step: 0.01 },
  { key: 'knockInBarrier', label: 'Knock-in barrier', kind: 'number', group: 'Barriers', step: 0.01, min: 0 },
  { key: 'knockOutBarrier', label: 'Knock-out barrier', kind: 'number', group: 'Barriers', step: 0.01, min: 0, nullable: true },
  { key: 'couponBarrier', label: 'Coupon barrier', kind: 'number', group: 'Coupon', step: 0.01, min: 0, nullable: true },
  { key: 'couponRate', label: 'Coupon rate', kind: 'number', group: 'Coupon', step: 0.0001, nullable: true },
  { key: 'couponPeriods', label: 'Coupon periods', kind: 'int', group: 'Coupon', step: 1, min: 0, nullable: true },
  { key: 'memoryCoupon', label: 'Memory coupon', kind: 'boolean', group: 'Coupon' },
  { key: 'fixedFirstCoupon', label: 'Fixed first coupon', kind: 'boolean', group: 'Coupon' },
]

export const PRODUCT_TYPES: ProductType[] = [
  {
    id: 'worst-of-phoenix',
    name: 'Worst-of Phoenix Autocall',
    description: 'Daily KO, European KI, memory coupon — the only product riga-flow prices today.',
    engine: 'riga-flow (2-factor, Dupire local vol)',
    fields: phoenixFields,
  },
]

export function productType(id: string): ProductType {
  return PRODUCT_TYPES.find((product) => product.id === id) ?? PRODUCT_TYPES[0]!
}
