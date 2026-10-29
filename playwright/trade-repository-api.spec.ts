import { expect, test } from './fixtures/test'
import {
  ADMIN,
  ALICE,
  EDDIE,
  OPS,
  VIEWER,
  bookPhoenix,
  callTradeRepoTool,
  phoenixTrade,
  tradeRepoCall,
  tradeRepoError,
  uniqueExternalId,
} from './support/tradeRepoApi'
import { TAG } from './support/tags'

const { journey, feature, priority } = TAG

/**
 * Doc-52 backend contract through the same MCP endpoint the UI uses. These cases
 * complement the browser journeys with deterministic checks for the rules that are
 * hard to reach from the UI in a single short flow: concurrency, idempotency,
 * entitlements, bitemporal reads, bulk modes and the reconciliation workflow.
 */
test.describe('trade repository MCP contract', () => {
  test('exposes capabilities, reference data, product templates and validation warnings', {
    tag: [priority.p0, journey.tradeNavigation, feature.tradeRepository, feature.tradeProductTemplates, feature.tradeReferenceData, feature.tradeErrors],
  }, async ({ request }) => {
    const capabilities = await tradeRepoCall<{
      productTypes: string[]
      kernelEvents: string[]
      roles: string[]
      bitemporal: boolean
      idempotency: boolean
      optimisticConcurrency: boolean
      maxPageSize: number
    }>(request, 'tr_capabilities')

    expect(capabilities.productTypes).toContain('PHOENIX_AUTOCALL')
    expect(capabilities.kernelEvents).toEqual(expect.arrayContaining(['NEW', 'AMEND', 'NOVATE', 'BOOK_TRANSFER']))
    expect(capabilities).toMatchObject({ bitemporal: true, idempotency: true, optimisticConcurrency: true, maxPageSize: 500 })

    const reference = await tradeRepoCall<{
      parties: Array<{ partyId: string; kind: string }>
      books: Array<{ bookId: string; legalEntityId: string }>
      users: Array<{ userId: string; role: string; books: string[] }>
    }>(request, 'tr_reference_list')
    expect(reference.books.map((book) => book.bookId)).toEqual(expect.arrayContaining(['PHX-EUR', 'PHX-USD', 'PHX-ASIA', 'PHX-HEDGE']))
    expect(reference.users.find((user) => user.userId === 'alice.sg')).toMatchObject({ role: 'trader', books: ['PHX-ASIA', 'PHX-HEDGE'] })
    expect(reference.parties.find((party) => party.partyId === 'LE-FINA-SG')).toBeTruthy()

    const products = await tradeRepoCall<{ items: Array<{ id: string; version: number }> }>(request, 'tr_product_list')
    expect(products.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'PHOENIX_AUTOCALL' })]))
    const template = await tradeRepoCall<{ id: string; version: number; terms: { fields: Array<{ path: string }> } }>(
      request,
      'tr_product_get',
      { id: 'PHOENIX_AUTOCALL' },
    )
    expect(template.terms.fields.map((field) => field.path)).toEqual(expect.arrayContaining(['isin', 'underlyings', 'strikeDate', 'coupon.ratePerPeriod']))

    const invalid = structuredClone(phoenixTrade({ externalId: uniqueExternalId('VALIDATION') }))
    delete (invalid.terms as Record<string, unknown>).isin
    const validation = await tradeRepoCall<{ valid: boolean; errors: Array<{ path: string; code: string }> }>(
      request,
      'tr_trade_validate',
      { trade: invalid },
    )
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((error) => error.path.includes('isin'))).toBe(true)

    const warningTrade = phoenixTrade({ externalId: uniqueExternalId('WARNING') })
    ;(warningTrade.terms as Record<string, unknown>).coupon = { ratePerPeriod: 0.025, barrier: 0.5, memory: true }
    const warned = await tradeRepoCall<{ valid: boolean; warnings: Array<{ code: string; path: string }> }>(
      request,
      'tr_trade_validate',
      { trade: warningTrade },
    )
    expect(warned.valid).toBe(true)
    expect(warned.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNUSUAL', path: 'terms.coupon.barrier' })]))
  })

  test('books by external id and UTI, and replays idempotent requests without duplicates', {
    tag: [priority.p0, journey.tradeCapture, feature.tradeCapture, feature.tradeIdempotency, feature.tradeReferenceData],
  }, async ({ request }) => {
    const externalId = uniqueExternalId('IDEMPOTENCY')
    const idempotencyKey = `idem-${externalId}`
    const trade = phoenixTrade({ externalId })

    const first = await tradeRepoCall<{ tradeId: string; version: number; trade: { uti: string; externalId: string } }>(
      request,
      'tr_trade_book',
      { trade, idempotencyKey },
    )
    expect(first.tradeId).toMatch(/^TR-\d+$/)
    expect(first).toMatchObject({ version: 1, trade: { externalId } })

    const replay = await tradeRepoCall<{ tradeId: string; version: number }>(
      request,
      'tr_trade_book',
      { trade, idempotencyKey },
    )
    expect(replay).toMatchObject({ tradeId: first.tradeId, version: 1 })

    const byExternalId = await tradeRepoCall<{ trade: { tradeId: string; uti: string } }>(
      request,
      'tr_trade_get',
      { tradeId: externalId },
    )
    expect(byExternalId.trade.tradeId).toBe(first.tradeId)
    const byUti = await tradeRepoCall<{ trade: { tradeId: string } }>(request, 'tr_trade_get', { tradeId: first.trade.uti })
    expect(byUti.trade.tradeId).toBe(first.tradeId)

    const duplicate = await tradeRepoError(request, 'tr_trade_book', { trade: phoenixTrade({ externalId }) })
    expect(duplicate).toMatchObject({ code: 'DUPLICATE', retryable: false })
  })

  test('classifies amendments, rejects stale versions and blocks changes to terminal trades', {
    tag: [priority.p0, journey.tradeLifecycle, feature.tradeLifecycle, feature.tradeConcurrency, feature.tradeErrors],
  }, async ({ request }) => {
    const booked = await bookPhoenix(request, { notional: 2_000_000 })

    const economic = await tradeRepoCall<{ version: number; amendKind: string }>(
      request,
      'tr_trade_amend',
      { tradeId: booked.tradeId, expectedVersion: 1, changes: { notional: 2_100_000 }, reason: 'Notional increased after client confirmation' },
    )
    expect(economic).toMatchObject({ version: 2, amendKind: 'ECONOMIC' })

    const nonEconomic = await tradeRepoCall<{ version: number; amendKind: string }>(
      request,
      'tr_trade_amend',
      { tradeId: booked.tradeId, expectedVersion: 2, changes: { trader: 'desk.head' }, reason: 'Trader reassignment during leave' },
    )
    expect(nonEconomic).toMatchObject({ version: 3, amendKind: 'NON_ECONOMIC' })

    const stale = await tradeRepoError(request, 'tr_trade_amend', {
      tradeId: booked.tradeId,
      expectedVersion: 1,
      changes: { notional: 2_200_000 },
      reason: 'Stale tab edit',
    })
    expect(stale).toMatchObject({ code: 'CONFLICT', retryable: true })
    expect(stale.details?.some((detail) => detail.code === 'STALE_VERSION')).toBe(true)

    const missingReason = await tradeRepoError(request, 'tr_trade_amend', {
      tradeId: booked.tradeId,
      expectedVersion: 3,
      changes: { notional: 2_200_000 },
      reason: '',
    })
    expect(missingReason.code).toBe('VALIDATION_FAILED')
    expect(missingReason.details?.some((detail) => detail.path === 'reason')).toBe(true)

    const cancelled = await tradeRepoCall<{ trade: { status: string } }>(request, 'tr_trade_lifecycle', {
      tradeId: booked.tradeId,
      eventType: 'CANCEL',
      effectiveDate: '2026-04-01',
      reason: 'Booked in error during contract testing',
    })
    expect(cancelled.trade.status).toBe('CANCELLED')

    const afterTerminal = await tradeRepoError(request, 'tr_trade_amend', {
      tradeId: booked.tradeId,
      expectedVersion: 4,
      changes: { notional: 2_300_000 },
      reason: 'Should be rejected',
    })
    expect(afterTerminal.code).toBe('INVALID_TRANSITION')
  })

  test('supports partial and full unwind, book transfer and linked novation', {
    tag: [priority.p0, journey.tradeLifecycle, feature.tradeLifecycle, feature.tradeHistory],
  }, async ({ request }) => {
    const partial = await bookPhoenix(request, { notional: 1_000_000 })
    const unwound = await tradeRepoCall<{ trade: { notional: number; status: string; terminatedNotional: number } }>(
      request,
      'tr_trade_lifecycle',
      {
        tradeId: partial.tradeId,
        eventType: 'UNWIND',
        effectiveDate: '2026-04-01',
        reason: 'Client requested a partial buyback',
        params: { notional: 250_000, pricePct: 0.98, date: '2026-04-01' },
      },
    )
    expect(unwound.trade).toMatchObject({ notional: 750_000, terminatedNotional: 250_000, status: 'LIVE' })

    const terminated = await tradeRepoCall<{ trade: { notional: number; status: string } }>(request, 'tr_trade_lifecycle', {
      tradeId: partial.tradeId,
      eventType: 'UNWIND',
      effectiveDate: '2026-04-02',
      reason: 'Full buyback of the remaining notional',
      params: { notional: 750_000, pricePct: 0.99, date: '2026-04-02' },
    })
    expect(terminated.trade.status).toBe('TERMINATED')

    const transfer = await bookPhoenix(request, { bookId: 'PHX-USD' })
    const moved = await tradeRepoCall<{ trade: { bookId: string; legalEntityId: string } }>(request, 'tr_trade_lifecycle', {
      tradeId: transfer.tradeId,
      eventType: 'BOOK_TRANSFER',
      effectiveDate: '2026-04-01',
      reason: 'Move to the Singapore book',
      params: { toBookId: 'PHX-ASIA' },
    })
    expect(moved.trade).toMatchObject({ bookId: 'PHX-ASIA', legalEntityId: 'LE-FINA-SG' })

    const original = await bookPhoenix(request, { counterpartyId: 'CP-GSI' })
    const novation = await tradeRepoCall<{ trade: { status: string }; novatedTo: string }>(request, 'tr_trade_lifecycle', {
      tradeId: original.tradeId,
      eventType: 'NOVATE',
      effectiveDate: '2026-04-01',
      reason: 'Novate to the client’s preferred counterparty',
      params: { transfereeId: 'CP-JPM' },
    })
    // The Phoenix template has no NOVATED state; the old leg terminates and the
    // successor trade carries the lifecycle state.
    expect(novation.trade.status).toBe('TERMINATED')
    expect(novation.novatedTo).toMatch(/^TR-\d+$/)

    const successor = await tradeRepoCall<{ trade: { counterpartyId: string; status: string; tags: Record<string, string> } }>(
      request,
      'tr_trade_get',
      { tradeId: novation.novatedTo },
    )
    expect(successor.trade).toMatchObject({ counterpartyId: 'CP-JPM', status: 'LIVE' })
    expect(successor.trade.tags.novatedFrom).toBe(original.tradeId)
  })

  test('resolves bitemporal state and exposes immutable history and field diffs', {
    tag: [priority.p0, journey.tradeHistory, feature.tradeHistory, feature.bitemporal],
  }, async ({ request }) => {
    const booked = await bookPhoenix(request, { notional: 2_000_000 })
    await tradeRepoCall(request, 'tr_trade_amend', {
      tradeId: booked.tradeId,
      expectedVersion: 1,
      changes: { notional: 2_400_000 },
      reason: 'Correction effective in April',
      validFrom: '2026-04-01',
    })

    const beforeKnown = await tradeRepoError(request, 'tr_trade_get', {
      tradeId: booked.tradeId,
      knownAt: '2000-01-01T00:00:00.000Z',
    })
    expect(beforeKnown.code).toBe('NOT_FOUND')
    const beforeValid = await tradeRepoError(request, 'tr_trade_get', {
      tradeId: booked.tradeId,
      validAt: '2026-03-01',
    })
    expect(beforeValid.code).toBe('NOT_FOUND')

    const march = await tradeRepoCall<{ trade: { version: number; notional: number }; isLatest: boolean }>(
      request,
      'tr_trade_get',
      { tradeId: booked.tradeId, validAt: '2026-03-15' },
    )
    expect(march.trade).toMatchObject({ version: 1, notional: 2_000_000 })
    expect(march.isLatest).toBe(false)

    const april = await tradeRepoCall<{ trade: { version: number; notional: number }; isLatest: boolean }>(
      request,
      'tr_trade_get',
      { tradeId: booked.tradeId, validAt: '2026-04-02' },
    )
    expect(april.trade).toMatchObject({ version: 2, notional: 2_400_000 })
    expect(april.isLatest).toBe(true)

    const history = await tradeRepoCall<{ events: Array<{ version: number; eventType: string; recordedAt: string }> }>(
      request,
      'tr_trade_history',
      { tradeId: booked.tradeId },
    )
    expect(history.events.map((event) => [event.version, event.eventType])).toEqual([[1, 'NEW'], [2, 'AMEND']])
    expect(history.events.every((event) => Date.parse(event.recordedAt) > 0)).toBe(true)

    const diff = await tradeRepoCall<{ changes: Array<{ field: string; economic: boolean }> }>(request, 'tr_trade_diff', {
      tradeId: booked.tradeId,
      fromVersion: 1,
      toVersion: 2,
    })
    expect(diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'notional', economic: true })]))
  })

  test('queries with filters, sorting and cursor pagination and enforces the page limit', {
    tag: [priority.p1, journey.tradeBlotter, feature.tradeBlotter, feature.tradeErrors],
  }, async ({ request }) => {
    const externalId = uniqueExternalId('QUERY')
    await bookPhoenix(request, { externalId })

    const one = await tradeRepoCall<{ items: Array<{ externalId: string }>; total: number; nextCursor: string | null }>(
      request,
      'tr_trade_query',
      { filter: { text: externalId }, limit: 10 },
    )
    expect(one.total).toBe(1)
    expect(one.items[0]).toMatchObject({ externalId })

    const pageOne = await tradeRepoCall<{ items: unknown[]; total: number; nextCursor: string | null }>(request, 'tr_trade_query', {
      sort: [{ field: 'tradeId', dir: 'asc' }],
      limit: 1,
    })
    expect(pageOne.items).toHaveLength(1)
    expect(pageOne.total).toBeGreaterThan(1)
    expect(pageOne.nextCursor).toBeTruthy()
    const pageTwo = await tradeRepoCall<{ items: Array<{ tradeId: string }> }>(request, 'tr_trade_query', {
      sort: [{ field: 'tradeId', dir: 'asc' }],
      limit: 1,
      cursor: pageOne.nextCursor!,
    })
    expect(pageTwo.items[0].tradeId).not.toBe((pageOne.items[0] as { tradeId: string }).tradeId)

    const tooLarge = await tradeRepoError(request, 'tr_trade_query', { limit: 501 })
    expect(tooLarge.code).toBe('VALIDATION_FAILED')
    expect(tooLarge.details?.some((detail) => detail.path === 'limit')).toBe(true)
  })

  test('aggregates positions and publishes the doc-51 risk snapshot and exports', {
    tag: [priority.p0, journey.portfolioRiskHandoff, journey.tradePositions, feature.tradePositions, feature.portfolioRisk, feature.positionSnapshot, feature.tradeExport],
  }, async ({ request }) => {
    const externalId = uniqueExternalId('SNAPSHOT')
    const booked = await bookPhoenix(request, { externalId })

    const positions = await tradeRepoCall<{ rows: Array<{ key: Record<string, unknown>; tradeCount: number; grossNotional: number }>; tradeCount: number }>(
      request,
      'tr_position_query',
      { groupBy: ['bookId', 'currency'] },
    )
    expect(positions.tradeCount).toBeGreaterThan(0)
    expect(positions.rows.every((row) => row.tradeCount > 0 && Number.isFinite(row.grossNotional))).toBe(true)

    const snapshot = await tradeRepoCall<{
      schema: string
      id: string
      version: string
      producer: { name: string; version: string }
      links: { trades: string[] }
      payload: { portfolioIds: string[]; positions: Array<{ positionId: string; instrumentVersion: string; quantity: number; quantityKind: string }> }
    }>(request, 'tr_position_snapshot')
    expect(snapshot).toMatchObject({ schema: 'fina.position-snapshot/v1', id: 'fina:position-snapshot:all' })
    expect(snapshot.version).toMatch(/^h:[a-f\d]+$/)
    expect(snapshot.producer.name).toBe('fina-trade-repo')
    expect(snapshot.links.trades).toHaveLength(snapshot.payload.positions.length)
    expect(snapshot.links.trades).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${booked.tradeId}@\\d+$`))]))
    const snapshotted = snapshot.payload.positions.find((position) => position.positionId === `pos:${booked.tradeId}`)
    expect(snapshotted).toMatchObject({ instrumentVersion: expect.stringMatching(/^h:/), quantity: -2_000_000, quantityKind: 'notional' })

    const json = await tradeRepoCall<{ format: string; count: number; content: string }>(request, 'tr_export', {
      format: 'json',
      filter: { text: externalId },
    })
    expect(json).toMatchObject({ format: 'json', count: 1 })
    expect(JSON.parse(json.content)[0].externalId).toBe(externalId)

    const csv = await tradeRepoCall<{ format: string; count: number; content: string }>(request, 'tr_export', {
      format: 'csv',
      filter: { text: externalId },
    })
    expect(csv.format).toBe('csv')
    expect(csv.content.split('\n')[0]).toContain('tradeId,uti,version,status')
    expect(csv.content).toContain(externalId)
  })

  test('serves term sheets, schedules and the pricer binding for the booked trade', {
    tag: [priority.p1, journey.tradeCapture, feature.tradeProductTemplates, feature.tradePricingLink],
  }, async ({ request }) => {
    const booked = await bookPhoenix(request)

    const termSheet = await tradeRepoCall<{ sections: Array<{ title: string; rows: unknown[] }>; widgets: unknown[] }>(request, 'tr_trade_termsheet', {
      tradeId: booked.tradeId,
    })
    expect(termSheet.sections.length).toBeGreaterThan(0)
    expect(termSheet.sections.some((section) => section.rows.length > 0)).toBe(true)

    const schedule = await tradeRepoCall<{ rows: Array<{ n: number; observationDate: string; status: string }> }>(request, 'tr_trade_schedule', {
      tradeId: booked.tradeId,
    })
    expect(schedule.rows).toHaveLength(8)
    expect(schedule.rows[0]).toMatchObject({ n: 1, status: 'PENDING' })

    const pricing = await tradeRepoCall<{ engine: string; tool: string; applicable: boolean; request: Record<string, unknown> }>(request, 'tr_trade_pricing', {
      tradeId: booked.tradeId,
    })
    expect(pricing).toMatchObject({ engine: 'riga', tool: 'price_trade', applicable: true })
    expect(pricing.request).toBeTruthy()
  })

  test('scopes trader reads and writes to entitled books and hides break actions from viewers', {
    tag: [priority.p0, journey.tradeEntitlements, feature.entitlements, feature.tradeReferenceData, feature.tradeErrors],
  }, async ({ request }) => {
    const asia = await bookPhoenix(request, { bookId: 'PHX-ASIA' }, ALICE)
    expect(asia.tradeId).toMatch(/^TR-\d+$/)

    const london = await tradeRepoError(request, 'tr_trade_book', { trade: phoenixTrade({ bookId: 'PHX-EUR' }) }, ALICE)
    expect(london.code).toBe('FORBIDDEN')
    const eddieAsia = await tradeRepoError(request, 'tr_trade_book', { trade: phoenixTrade({ bookId: 'PHX-ASIA' }) }, EDDIE)
    expect(eddieAsia.code).toBe('FORBIDDEN')
    const viewerBook = await tradeRepoError(request, 'tr_trade_book', { trade: phoenixTrade() }, VIEWER)
    expect(viewerBook.code).toBe('FORBIDDEN')

    const aliceLondon = await tradeRepoCall<{ items: unknown[] }>(request, 'tr_trade_query', { filter: { bookIds: ['PHX-EUR'] } }, ALICE)
    expect(aliceLondon.items).toHaveLength(0)
    const adminLondon = await tradeRepoCall<{ items: unknown[] }>(request, 'tr_trade_query', { filter: { bookIds: ['PHX-EUR'] }, limit: 1 })
    expect(adminLondon.items.length).toBeGreaterThan(0)
    const hidden = await tradeRepoError(
      request,
      'tr_trade_get',
      { tradeId: (adminLondon.items[0] as { tradeId: string }).tradeId },
      ALICE,
    )
    expect(hidden.code).toBe('FORBIDDEN')

    const viewerBreaks = await tradeRepoCall<{ items: Array<{ breakId: string }> }>(request, 'tr_recon_breaks_query', { filter: { statuses: ['OPEN'] } }, VIEWER)
    if (viewerBreaks.items[0]) {
      const denied = await tradeRepoError(
        request,
        'tr_recon_break_update',
        { breakId: viewerBreaks.items[0].breakId, status: 'INVESTIGATING' },
        VIEWER,
      )
      expect(denied.code).toBe('FORBIDDEN')
    }
  })

  test('records append-only audit entries with actor, target and correlation id', {
    tag: [priority.p0, journey.tradeGovernance, feature.tradeAudit],
  }, async ({ request }) => {
    const externalId = uniqueExternalId('AUDIT')
    const booked = await bookPhoenix(request, { externalId })

    const audit = await tradeRepoCall<{ items: Array<{ actor: string; action: string; target?: { id: string }; correlationId?: string }>; total: number }>(
      request,
      'tr_audit_query',
      { filter: { action: 'trade.book', targetId: booked.tradeId } },
    )
    expect(audit.total).toBeGreaterThan(0)
    expect(audit.items[0]).toMatchObject({ actor: 'trash.box', action: 'trade.book', target: { id: booked.tradeId } })
    expect(audit.items[0].correlationId).toMatch(/^cor-/)

    const filtered = await tradeRepoCall<{ items: Array<{ action: string }> }>(request, 'tr_audit_query', {
      filter: { action: 'trade.amend' },
      limit: 5,
    })
    expect(filtered.items.every((entry) => entry.action === 'trade.amend')).toBe(true)
  })

  test('runs reconciliation, creates typed breaks and enforces the break workflow', {
    tag: [priority.p0, journey.tradeReconciliation, feature.tradeRecon, feature.tradeAudit],
  }, async ({ request }) => {
    const live = await tradeRepoCall<{ items: Array<{ uti: string; notional: number; maturityDate: string; currency: string; counterpartyId: string; side: string }> }>(
      request,
      'tr_trade_query',
      { filter: { statuses: ['LIVE'] }, limit: 500 },
    )
    const records = live.items.map((trade) => ({
      uti: trade.uti,
      notional: trade.notional,
      maturityDate: trade.maturityDate,
      currency: trade.currency,
      counterpartyId: trade.counterpartyId,
      side: trade.side,
    }))
    const ghostUti = `GHOST-${Date.now()}`
    const run = await tradeRepoCall<{ runId: string; summary: { matched: number; breaks: number; byType: Record<string, number> } }>(
      request,
      'tr_recon_run',
      { source: `Playwright contract ${Date.now()}`, asOfDate: '2026-10-20', records: [...records, { uti: ghostUti }] },
      OPS,
    )
    expect(run.summary.matched).toBeGreaterThanOrEqual(records.length)
    expect(run.summary.byType.MISSING_IN_REPO).toBeGreaterThanOrEqual(1)

    const breaks = await tradeRepoCall<{ items: Array<{ breakId: string; type: string; status: string; uti: string; updatedAt: string }> }>(
      request,
      'tr_recon_breaks_query',
      { filter: { runId: run.runId } },
      OPS,
    )
    const ghost = breaks.items.find((item) => item.uti === ghostUti)
    expect(ghost).toMatchObject({ type: 'MISSING_IN_REPO', status: 'OPEN' })

    const missingComment = await tradeRepoError(
      request,
      'tr_recon_break_update',
      { breakId: ghost!.breakId, status: 'RESOLVED', expectedUpdatedAt: ghost!.updatedAt },
      OPS,
    )
    expect(missingComment.code).toBe('VALIDATION_FAILED')
    expect(missingComment.details?.some((detail) => detail.path === 'comment')).toBe(true)

    const investigating = await tradeRepoCall<{ status: string; assignee?: string; updatedAt: string }>(
      request,
      'tr_recon_break_update',
      { breakId: ghost!.breakId, status: 'INVESTIGATING', assignee: 'olga.ops', comment: 'Investigating with the distributor', expectedUpdatedAt: ghost!.updatedAt },
      OPS,
    )
    expect(investigating).toMatchObject({ status: 'INVESTIGATING', assignee: 'olga.ops' })

    const resolved = await tradeRepoCall<{ status: string; comments: Array<{ text: string; actor: string }> }>(
      request,
      'tr_recon_break_update',
      { breakId: ghost!.breakId, status: 'RESOLVED', comment: 'Matched to the signed distributor statement', expectedUpdatedAt: investigating.updatedAt },
      OPS,
    )
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.comments.at(-1)).toMatchObject({ actor: 'olga.ops', text: 'Matched to the signed distributor statement' })
  })

  test('validates, commits and retries bulk imports in all-or-nothing and best-effort modes', {
    tag: [priority.p0, journey.tradeImportExport, feature.tradeImport, feature.tradeIdempotency],
  }, async ({ request }) => {
    const goodId = uniqueExternalId('IMPORT-GOOD')
    const badId = uniqueExternalId('IMPORT-BAD')
    const good = phoenixTrade({ externalId: goodId })
    const bad = { ...phoenixTrade({ externalId: badId }), notional: -10 }

    const dryRun = await tradeRepoCall<{ dryRun: boolean; committed: number; failed: number; results: Array<{ status: string; errors: unknown[] }> }>(
      request,
      'tr_bulk_import',
      { rows: [good, bad], dryRun: true, mode: 'all-or-nothing' },
    )
    expect(dryRun).toMatchObject({ dryRun: true, committed: 0, failed: 1 })
    expect(dryRun.results.filter((row) => row.status === 'OK')).toHaveLength(1)

    const blocked = await tradeRepoCall<{ dryRun: boolean; committed: number; failed: number }>(request, 'tr_bulk_import', {
      rows: [good, bad],
      mode: 'all-or-nothing',
    })
    expect(blocked).toMatchObject({ dryRun: false, committed: 0, failed: 1 })

    const bestEffort = await tradeRepoCall<{ committed: number; failed: number; results: Array<{ externalId: string; status: string; tradeId?: string }> }>(
      request,
      'tr_bulk_import',
      { rows: [good, bad], mode: 'best-effort' },
    )
    expect(bestEffort).toMatchObject({ committed: 1, failed: 1 })
    const imported = bestEffort.results.find((row) => row.externalId === goodId)
    expect(imported?.tradeId).toMatch(/^TR-\d+$/)
    const fetched = await tradeRepoCall<{ trade: { externalId: string } }>(request, 'tr_trade_get', { tradeId: goodId })
    expect(fetched.trade.externalId).toBe(goodId)

    const retry = await tradeRepoCall<{ committed: number; failed: number; results: Array<{ status: string; errors: Array<{ code: string }> }> }>(
      request,
      'tr_bulk_import',
      { rows: [good], mode: 'best-effort' },
    )
    expect(retry.committed).toBe(0)
    expect(retry.failed).toBe(1)
    expect(retry.results[0].errors.some((error) => error.code === 'DUPLICATE')).toBe(true)
  })

  test('surfaces the error envelope with paths and a correlation id', {
    tag: [priority.p1, journey.tradeCapture, feature.tradeErrors],
  }, async ({ request }) => {
    const result = await callTradeRepoTool(request, 'tr_trade_amend', {
      tradeId: 'TR-000000',
      expectedVersion: 1,
      changes: { notional: 1 },
      reason: 'Missing trade',
    })
    expect(result.isError).toBe(true)
    expect(result.data).toMatchObject({ code: 'NOT_FOUND', retryable: false })
    expect((result.data as { correlationId?: string }).correlationId).toMatch(/^cor-/)
  })
})
