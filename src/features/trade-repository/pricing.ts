// Pricer binding → existing riga Phoenix model. The template's `pricing.mapping` produces the
// riga PhoenixTrade fields server-side (tr_trade_pricing); here we lay them onto a
// `fina.instrument/v1` document so Payoff Explorer / Trade Design price it unchanged.
import { blankDocument } from '@/features/riga/instrument/adapters/manual'
import type { InstrumentDocument } from '@/features/riga/instrument/schema'
import type { PricingBinding, Trade } from './types'

export function toInstrumentDocument(trade: Trade, binding: PricingBinding, base: InstrumentDocument = blankDocument()): InstrumentDocument {
  const r = binding.request as Record<string, unknown>
  const doc = structuredClone(base)
  const symbols = (r.symbols as string[]) ?? []
  const spots = (r.initialSpots as number[]) ?? []
  doc.source = { kind: 'manual', adapter: 'manual', fileName: `trade-repo:${trade.tradeId}@v${trade.version}`, importedAt: new Date().toISOString(), rawHash: trade.contentHash }
  doc.meta = { ...doc.meta, name: trade.tradeId, template: 'PHOENIX_AUTOCALL', product: 'Phoenix', currency: trade.currency, notional: trade.notional, tradeDate: trade.tradeDate, maturityDate: trade.maturityDate, expiryDate: trade.terms?.finalValuationDate ?? trade.maturityDate }
  const put = doc.legs.find((l) => l.kind === 'put')!.put!
  Object.assign(put, {
    initialSpots: spots, strike: r.strike, knockInBarrier: r.knockInBarrier, knockInType: r.knockInType, knockOutBarrier: r.knockOutBarrier,
    couponBarrier: r.couponBarrier, couponRate: r.couponRate, memoryCoupon: r.memoryCoupon, couponPeriods: r.couponPeriods,
    fixedFirstCoupon: r.fixedFirstCoupon, maturityYears: r.maturityYears, steps: r.steps, callStartStep: r.callStartStep,
  })
  // Market: keep the loaded market when the basket matches, else start from flat inputs at the strike.
  if (JSON.stringify(doc.market.symbols) !== JSON.stringify(symbols)) {
    doc.market = { ...doc.market, symbols, initialFixings: spots, spots, vols: spots.map(() => 0.3), dividendYields: spots.map(() => 0.01), correlation: spots.map((_, i) => spots.map((__, j) => (i === j ? 1 : 0.5))), localVol: [] }
  } else doc.market = { ...doc.market, initialFixings: spots }
  doc.issues = binding.notes.map((n) => ({ severity: 'info' as const, code: 'trade-repo.binding', path: '/legs/0/put', message: n }))
  return doc
}
