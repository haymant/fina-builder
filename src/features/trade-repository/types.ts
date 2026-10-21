export type ProductType = 'IRS' | 'FX_FORWARD' | 'EQUITY_OPTION' | 'CDS' | 'PHOENIX_AUTOCALL'
export type TradeStatus = 'LIVE' | 'CANCELLED' | 'TERMINATED' | 'EXERCISED' | 'MATURED' | 'NOVATED'
export type LifecycleEvent = 'CANCEL' | 'NOVATE' | 'PARTIAL_TERMINATE' | 'EXERCISE' | 'MATURE' | 'BOOK_TRANSFER'
export type Role = 'viewer' | 'trader' | 'ops' | 'admin'

export interface TradeInput {
  productType: ProductType
  side: 'BUY' | 'SELL'
  notional: number
  currency: string
  underlying?: string
  price?: number
  fixedRate?: number
  strike?: number
  optionType?: 'CALL' | 'PUT'
  quantity?: number
  tradeDate: string
  effectiveDate?: string
  maturityDate: string
  counterpartyId: string
  bookId: string
  trader?: string
  venue?: string
  externalId?: string
  comment?: string
  tags?: Record<string, string>
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
  originalNotional?: number
  terminatedNotional?: number
  novatedTo?: string
}

export interface FieldIssue { code: string; path: string; message: string }
export interface Validation { valid: boolean; errors: FieldIssue[]; warnings: FieldIssue[] }
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
