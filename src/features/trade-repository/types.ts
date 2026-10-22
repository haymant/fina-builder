/** Product template id (data-driven; PHOENIX_AUTOCALL is the first). */
export type ProductType = string
export type TradeStatus = string
export type LifecycleEvent = string
export type Role = 'viewer' | 'trader' | 'ops' | 'admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Terms = Record<string, any>

export interface TradeInput {
  productType: ProductType
  productTemplate?: { id: string; version: number }
  side: 'BUY' | 'SELL'
  notional: number
  currency: string
  underlying?: string
  tradeDate: string
  effectiveDate?: string
  maturityDate?: string
  counterpartyId: string
  bookId: string
  trader?: string
  venue?: string
  externalId?: string
  comment?: string
  tags?: Record<string, string>
  terms?: Terms
}

export interface Trade extends TradeInput {
  tradeId: string
  uti: string
  version: number
  status: TradeStatus
  legalEntityId: string
  lastEventType: string
  lastEventId: string
  validFrom: string
  recordedAt: string
  contentHash: string
  maturityDate: string
  originalNotional?: number
  terminatedNotional?: number
  novatedTo?: string
  productTemplate: { id: string; version: number }
  terms: Terms
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  productState: Record<string, any>
  display?: Record<string, unknown>
}

/** fina.product-template/v1 field descriptor (terms and event params). */
export interface FieldDef {
  path: string
  label?: string
  type: 'string' | 'number' | 'integer' | 'percent' | 'boolean' | 'date' | 'enum' | 'ref' | 'array' | 'map'
  required?: boolean
  default?: unknown
  values?: string[]
  ref?: 'party' | 'book'
  min?: number
  max?: number
  minLength?: number
  pattern?: string
  help?: string
  items?: FieldDef[]
  minItems?: number
  maxItems?: number
  keys?: string[]
}
export interface ProductTemplate {
  id: string
  version: number
  name: string
  description?: string
  kernel?: { defaults?: Record<string, unknown>; sideLabels?: Record<string, string> }
  terms: { fields: FieldDef[] }
  lifecycle: { initialStatus: string; statuses: Record<string, { terminal?: boolean }>; events: Record<string, { label?: string; derived?: boolean; kernel?: boolean }> }
  pricing?: { engine: string; tool: string; payoff: string; dashboard?: string }
  ui?: { form?: { id: string; title: string; fields: string[] }[]; widgets?: string[]; blotterColumns?: { field: string; header: string; width?: number }[] }
}
export interface ProductSummary { id: string; version: number; name: string; status: string; description: string | null }
export interface TermSheetSection { title: string; rows: (string | number)[][]; columns?: string[] }
export interface TermSheet { tradeId: string; version: number; sections: TermSheetSection[]; widgets: string[] }
export interface ScheduleRow {
  n: number; observationDate: string; paymentDate: string; autocallLevel: number | null; couponBarrier: number | null; couponRate: number
  fixing: { worst: number; worstSymbol: string; levels: Record<string, number>; performances: Record<string, number>; source?: string; sourceObservedAt?: string; evidenceRef?: string | null } | null
  coupon: { paid: boolean; amount: number; periods: number; memoryCatchUp: number } | null
  autocalled: boolean; status: 'FIXED' | 'PENDING' | 'NOT_REACHED'
}
export interface Schedule {
  tradeId: string; version: number; status: string
  knockIn: { barrier: number | null; observation: string | null; knockedIn: boolean; date: string | null; worst: number | null }
  underlyings: { symbol: string; name?: string; initialFixing: number }[]
  rows: ScheduleRow[]; monitor: { date: string; worst: number }[]; corporateActions: Record<string, unknown>[]
  redemption: { amount: number; pct: number; paymentDate: string; capitalLoss?: boolean; reason?: string } | null
}
export interface FixingDueItem { tradeId: string; version: number; bookId: string; productType: string; underlying?: string; n: number; observationCount: number; observationDate: string; paymentDate: string; levelsRequired: string[] }
export interface FixingDue { asOfDate: string; total: number; items: FixingDueItem[]; truncated: boolean; reviewRequired: true }
export interface FixingBatchResult { dryRun: boolean; mode: 'all-or-nothing' | 'best-effort'; total: number; valid: number; failed: number; committed: number; noWrites: boolean; results: { row: number; tradeId: string | null; n: number | null; status: 'READY' | 'ERROR' | 'COMMITTED'; errors: FieldIssue[]; message?: string; replayed?: boolean; version?: number; eventIds?: string[]; events: { eventType: string; detail?: Record<string, unknown> | null }[] }[] }
export interface EventDef { name: string; label: string; derived: boolean; kernel: boolean; effectiveDateDerived: boolean; allowed: boolean; roles: string[] | null; requiresReason: boolean; params: FieldDef[] }
export interface PricingBinding { engine: string; tool: string; payoff: string; dashboard: string | null; applicable: boolean; request: Record<string, unknown>; notes: string[] }

export interface FieldIssue { code: string; path: string; message: string }
export interface Validation { valid: boolean; errors: FieldIssue[]; warnings: FieldIssue[]; preview?: { maturityDate: string | null; underlying: string | null; effectiveDate: string | null; schedule: ScheduleRow[]; terms: Terms } | null }
export interface Page<T> { items: T[]; total: number; nextCursor: string | null }
export interface Change { field: string; before: unknown; after: unknown; economic: boolean }

export interface TradeEvent {
  eventId: string
  tradeId: string
  uti: string
  version: number
  eventType: string
  amendKind: 'ECONOMIC' | 'NON_ECONOMIC' | null
  validFrom: string
  recordedAt: string
  actor: string
  reason: string | null
  changes: Change[]
  notional: number
  status: TradeStatus
  related: Record<string, string> | null
  detail?: Record<string, unknown> | null
  causedBy?: string | null
}

export interface PositionRow { key: Record<string, string | null>; netNotional: number; grossNotional: number; longNotional: number; shortNotional: number; tradeCount: number; tradeIds: string[] }
export interface AuditRow { auditId: string; occurredAt: string; actor: string; role: string; action: string; target: { type: string; id: string; version?: number }; detail: Record<string, unknown>; correlationId: string | null }
export interface ReconRun { runId: string; source: string; asOfDate: string | null; ranAt: string; actor: string; summary: { external: number; internal: number; matched: number; breaks: number; byType: Record<string, number> } }
export type BreakStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'WAIVED'
export interface ReconBreak { breakId: string; runId: string; source: string; type: string; uti: string; tradeId: string | null; detail: Record<string, unknown>; status: BreakStatus; assignee: string | null; comments: { at: string; actor: string; text: string }[]; createdAt: string; updatedAt: string }
export interface Reference {
  parties: { partyId: string; kind: 'LEGAL_ENTITY' | 'COUNTERPARTY'; name: string; lei: string; country: string }[]
  desks: { deskId: string; name: string; legalEntityId: string }[]
  books: { bookId: string; name: string; deskId: string; legalEntityId: string; baseCurrency: string }[]
  users: { userId: string; name: string; role: Role; deskId: string | null; books: string[] }[]
}
export interface AsOf { validAt?: string; knownAt?: string }
export interface ImportResult { dryRun: boolean; committed: number; failed: number; results: { row: number; externalId: string | null; status: 'OK' | 'ERROR'; errors: FieldIssue[]; warnings: FieldIssue[]; tradeId?: string }[] }
