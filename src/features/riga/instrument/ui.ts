// Tabular form sections for the `fina.instrument/v1` document (finap's
// `.fina-form-grid` layout). Field pointers are JSON pointers from the form
// root, so the same component edits the whole document or just the market.

import type { TabularSection } from './tabular-form'

/** Whole-document editor (trade tile). */
export const INSTRUMENT_FORM_SECTIONS: TabularSection[] = [
  {
    title: 'Identity',
    fields: [
      { path: '/meta/name', label: 'Trade name' },
      { path: '/meta/template', label: 'Template', readOnly: true },
      { path: '/meta/product', label: 'Product', readOnly: true },
      { path: '/meta/currency', label: 'Currency', renderer: 'currency-code' },
      { path: '/meta/notional', label: 'Notional', renderer: 'money-input' },
      { path: '/meta/multiplier', label: 'Multiplier' },
      { path: '/meta/systemDate', label: 'System date', renderer: 'date-input' },
      { path: '/meta/expiryDate', label: 'Expiry', renderer: 'date-input' },
    ],
  },
  {
    title: 'Put leg',
    fields: [
      { path: '/legs/0/put/strike', label: 'Strike (× initial)' },
      { path: '/legs/0/put/knockInBarrier', label: 'Knock-in barrier (× initial)' },
      { path: '/legs/0/put/knockOutBarrier', label: 'Autocall / KO barrier (× initial)' },
      { path: '/legs/0/put/couponBarrier', label: 'Coupon barrier (× initial)' },
      { path: '/legs/0/put/couponRate', label: 'Coupon / period (return)' },
      { path: '/legs/0/put/couponPeriods', label: 'Coupon periods' },
      { path: '/legs/0/put/memoryCoupon', label: 'Memory coupon', renderer: 'switch' },
      { path: '/legs/0/put/fixedFirstCoupon', label: 'Fixed first coupon', renderer: 'switch' },
      { path: '/legs/0/put/maturityYears', label: 'Maturity (years)' },
      { path: '/legs/0/put/steps', label: 'Observation steps' },
      { path: '/legs/0/put/callStartStep', label: 'Call start step' },
      { path: '/legs/0/put/knockInType', label: 'Knock-in type', readOnly: true },
      { path: '/legs/0/put/knockOutKind', label: 'Knock-out kind', readOnly: true },
      { path: '/legs/0/put/initialSpots/0', label: 'Initial fixing 1 (P0)' },
      { path: '/legs/0/put/initialSpots/1', label: 'Initial fixing 2 (P0)' },
    ],
  },
  {
    title: 'Market',
    fields: [
      { path: '/market/asOf', label: 'As-of (ISO)' },
      { path: '/market/symbols/0', label: 'Symbol 1' },
      { path: '/market/symbols/1', label: 'Symbol 2' },
      { path: '/market/spots/0', label: 'Spot 1 (mark)' },
      { path: '/market/spots/1', label: 'Spot 2 (mark)' },
      { path: '/market/vols/0', label: 'ATM vol 1' },
      { path: '/market/vols/1', label: 'ATM vol 2' },
      { path: '/market/dividendYields/0', label: 'Dividend yield 1' },
      { path: '/market/dividendYields/1', label: 'Dividend yield 2' },
      { path: '/market/correlation/0/1', label: 'Correlation' },
      { path: '/market/riskFreeRate', label: 'Risk-free rate', readOnly: true },
    ],
  },
  {
    title: 'Simulation',
    fields: [
      { path: '/simulation/paths', label: 'Paths' },
      { path: '/simulation/pathBlockSize', label: 'Path block size' },
      { path: '/simulation/seed', label: 'Seed' },
      { path: '/simulation/traceLevel', label: 'Trace level' },
    ],
  },
]

/** Market-only editor (market tile, document lane). */
export const MARKET_FORM_SECTIONS: TabularSection[] = [
  {
    title: 'Snapshot',
    fields: [
      { path: '/market/asOf', label: 'As-of (ISO)' },
      { path: '/market/symbols/0', label: 'Symbol 1' },
      { path: '/market/symbols/1', label: 'Symbol 2' },
      { path: '/market/initialFixings/0', label: 'Initial fixing 1 (P0)' },
      { path: '/market/initialFixings/1', label: 'Initial fixing 2 (P0)' },
      { path: '/market/spots/0', label: 'Spot 1 (mark)' },
      { path: '/market/spots/1', label: 'Spot 2 (mark)' },
      { path: '/market/vols/0', label: 'ATM vol 1' },
      { path: '/market/vols/1', label: 'ATM vol 2' },
      { path: '/market/dividendYields/0', label: 'Dividend yield 1' },
      { path: '/market/dividendYields/1', label: 'Dividend yield 2' },
      { path: '/market/correlation/0/1', label: 'Correlation' },
    ],
  },
]
