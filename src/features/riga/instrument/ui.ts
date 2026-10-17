// Deep-form schema/layout/hints for the `fina.instrument/v1` document (docs/46 §7.2).

import type { DeepFormFieldHints, DeepFormLayout } from '../../../components/deep-form'

/** JSON pointers -> labels/units for the instrument editor. */
export const INSTRUMENT_FIELD_HINTS: DeepFormFieldHints = {
  '/meta/name': { label: 'Trade name' },
  '/meta/template': { label: 'Template', readOnly: true },
  '/meta/product': { label: 'Product', readOnly: true },
  '/meta/currency': { label: 'Currency' },
  '/meta/notional': { label: 'Notional' },
  '/meta/multiplier': { label: 'Multiplier' },
  '/legs/0/put/initialSpots': { label: 'Initial fixings (P0 — not a mark)' },
  '/legs/0/put/strike': { label: 'Strike (× initial)' },
  '/legs/0/put/knockInBarrier': { label: 'Knock-in barrier (× initial)' },
  '/legs/0/put/knockOutBarrier': { label: 'Autocall / KO barrier (× initial)' },
  '/legs/0/put/couponBarrier': { label: 'Coupon barrier (× initial)' },
  '/legs/0/put/couponRate': { label: 'Coupon / period (return)' },
  '/legs/0/put/couponPeriods': { label: 'Coupon periods' },
  '/legs/0/put/memoryCoupon': { label: 'Memory coupon' },
  '/legs/0/put/fixedFirstCoupon': { label: 'Fixed first coupon' },
  '/legs/0/put/maturityYears': { label: 'Maturity (years)' },
  '/legs/0/put/steps': { label: 'Observation steps' },
  '/legs/0/put/callStartStep': { label: 'Call start step' },
  '/legs/0/put/knockInType': { label: 'Knock-in type', readOnly: true },
  '/legs/0/put/knockOutKind': { label: 'Knock-out kind', readOnly: true },
  '/market/asOf': { label: 'As-of (ISO)' },
  '/market/spots': { label: 'Spots (current marks)' },
  '/market/vols': { label: 'Flat ATM vols' },
  '/market/dividendYields': { label: 'Dividend yields' },
  '/simulation/paths': { label: 'Paths' },
  '/simulation/pathBlockSize': { label: 'Path block size' },
  '/simulation/seed': { label: 'Seed' },
  '/source/adapter': { label: 'Adapter', readOnly: true },
  '/source/fileName': { label: 'Source file', readOnly: true },
}

/** Curated layout for the market lane of the market tile (no `raw`). */
export const INSTRUMENT_MARKET_LAYOUT: DeepFormLayout = {
  title: 'Market',
  children: [
    {
      kind: 'group',
      title: 'Snapshot',
      path: '/market',
      children: [
        { kind: 'field', path: '/market/asOf' },
        { kind: 'field', path: '/market/symbols' },
        { kind: 'field', path: '/market/initialFixings' },
        { kind: 'field', path: '/market/spots' },
        { kind: 'field', path: '/market/vols' },
        { kind: 'field', path: '/market/dividendYields' },
        { kind: 'field', path: '/market/correlation' },
      ],
    },
  ],
}

export const INSTRUMENT_LAYOUT: DeepFormLayout = {
  title: 'Instrument',
  children: [
    {
      kind: 'group',
      title: 'Identity',
      path: '/meta',
      children: [
        { kind: 'field', path: '/meta/name' },
        { kind: 'field', path: '/meta/template' },
        { kind: 'field', path: '/meta/currency' },
        { kind: 'field', path: '/meta/notional' },
        { kind: 'field', path: '/meta/multiplier' },
      ],
    },
    {
      kind: 'group',
      title: 'Put leg',
      path: '/legs/0/put',
      children: [
        { kind: 'field', path: '/legs/0/put/strike' },
        { kind: 'field', path: '/legs/0/put/knockInBarrier' },
        { kind: 'field', path: '/legs/0/put/knockOutBarrier' },
        { kind: 'field', path: '/legs/0/put/couponBarrier' },
        { kind: 'field', path: '/legs/0/put/couponRate' },
        { kind: 'field', path: '/legs/0/put/couponPeriods' },
        { kind: 'field', path: '/legs/0/put/memoryCoupon' },
        { kind: 'field', path: '/legs/0/put/fixedFirstCoupon' },
        { kind: 'field', path: '/legs/0/put/initialSpots' },
        { kind: 'field', path: '/legs/0/put/maturityYears' },
        { kind: 'field', path: '/legs/0/put/steps' },
        { kind: 'field', path: '/legs/0/put/callStartStep' },
      ],
    },
    {
      kind: 'group',
      title: 'Market',
      path: '/market',
      children: [
        { kind: 'field', path: '/market/asOf' },
        { kind: 'field', path: '/market/spots' },
        { kind: 'field', path: '/market/vols' },
        { kind: 'field', path: '/market/dividendYields' },
      ],
    },
    {
      kind: 'group',
      title: 'Simulation',
      path: '/simulation',
      children: [
        { kind: 'field', path: '/simulation/paths' },
        { kind: 'field', path: '/simulation/pathBlockSize' },
        { kind: 'field', path: '/simulation/seed' },
      ],
    },
    {
      kind: 'group',
      title: 'Provenance',
      path: '/source',
      collapsible: true,
      defaultExpanded: false,
      children: [
        { kind: 'field', path: '/source/adapter' },
        { kind: 'field', path: '/source/fileName' },
      ],
    },
  ],
}
