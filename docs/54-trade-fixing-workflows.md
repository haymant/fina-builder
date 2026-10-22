# 54 — Trade fixing workflows: review, design and implementation

**Status:** individual capture, operator-reviewed due queue and bounded bulk capture are implemented for Phoenix autocalls. This is operational workflow support, not an unattended market-data fixing service. **Production readiness:** incomplete until correction/restate controls, maker-checker approval and an authorized market-data/evidence integration are designed.

Related specifications: [52 — Trade repository design](./52-trade-repository-design.md), [53 — Trade repository UI](./53-trade-repository-ui-spec.md), and [51 — Portfolio risk architecture](./51-portfolio-risk-architecture.md).

## Executive assessment

The former design supported a single Phoenix `FIXING` lifecycle event and derived coupon, knock-in, autocall and redemption outcomes. It did not expose an operational due queue, a validated multi-trade capture path, or mandatory source timestamp provenance. It also did not define correction/restate or maker-checker behavior. That was not enough for a complete fixing operations workflow.

The implementation now supports:

| Workflow | Support | Boundary |
| --- | --- | --- |
| Individual fixing | Yes. Use the trade's lifecycle dialog or `tr_trade_lifecycle`; the product contract requires underlying levels, source and a timezone-qualified source-observation timestamp. Optional evidence reference and operator reason are retained. | Product plugin and lifecycle guard determine dates/outcomes; users cannot silently overwrite an already-fixed observation. |
| Bulk fixing | Yes. `tr_fixings_bulk` accepts up to 500 distinct trades, previews every row, checks expected versions and row idempotency, then commits in `all-or-nothing` (default) or `best-effort` mode. | One pending observation per trade in one batch; there is no multi-observation catch-up import in one row. |
| Scheduled work | Yes, as a user-invoked due-observation queue. `tr_fixing_due` lists the next unresolved contractual observation on/before a supplied business date; the Fixings view can open the trade for individual capture or select rows for a batch. | This is not a scheduler, data feed, market-close monitor or automatic posting service. No price is sourced or posted without an operator. |
| Correction / restatement | No. Current duplicate-observation guards reject a second fixing for the same observation. | A separate superseding event, downstream cashflow restatement, dual approval and notification/reconciliation controls are needed before corrections are safe. |

The repository advertises these boundaries through `tr_capabilities`. Do not describe this implementation as automatic market-data fixing or production-grade correction management.

## Best-practice considerations and sources

Fixing behavior is contract-specific. Equity-derivative terms determine the observation date and valuation time, applicable exchange, disruption treatment, fallback and calculation-agent judgment. ISDA's smart-derivative legal guidance recommends defining the divergence points where automation hands off to manual intervention; its market-practice note illustrates why disruption and valuation treatment cannot be reduced to one universal rule. These materials are context, not legal advice or a product-specific interpretation.

Benchmark governance is a useful analogue, not a blanket regulatory mandate for every internal equity fixing. IOSCO's benchmark principles emphasize reliable input data, disclosed methodology, governance and audit/record controls. FIX protocol update fields are transport semantics rather than fixing policy; retaining source/update identifiers and lineage is preferable to an unexplained overwrite.

- [ISDA, Legal Guidelines for Smart Derivatives Contracts: Equity Derivatives](https://www.isda.org/a/CLXTE/ISDA-Legal-Guidelines-for-Smart-Derivatives-Contracts-Equities.pdf)
- [ISDA Equity Derivatives Committee, Market Practice Issues](https://www.isda.org/a/UViDE/equityderivativesmpissues.pdf)
- [IOSCO, Principles for Financial Benchmarks, FR07/13](https://www.iosco.org/library/pubdocs/pdf/ioscopd415.pdf)
- [FIX Trading Community, FIX Protocol](https://fixtrading.org/standards/fix-protocol/) and [MDUpdateAction / MDEntryRefID field reference](https://fiximate.fixtrading.org/en/FIX.Latest/fields_sorted_by_name.html)

## Implemented control flow

1. **Due work derives from the product schedule.** `tr_fixing_due` requires `asOfDate`, returns ops/admin-visible unresolved next observations only, and includes trade version, book, observation/payment dates and expected underlying symbols. It reads contractual schedule state; it does not infer a close or fetch data.
2. **Single capture keeps provenance with the event.** A fixing must include `source` and `sourceObservedAt` (ISO-8601 with `Z` or an explicit UTC offset). The Phoenix plugin validates timestamp shape/parseability and market levels, then records those values and optional `evidenceRef` in the immutable fixing detail. Actor, event-recorded time, reason and derived lifecycle events remain in the event/audit history.
3. **Bulk work previews before writes.** Each row carries `expectedVersion` and its own `idempotencyKey`. Preview shows row-level errors and the derived event sequence. In all-or-nothing mode, any invalid row means zero writes; best-effort commits valid rows and reports failures. Retries with the same key and payload return the original lifecycle result; reusing a key with a different payload is a conflict.
4. **The same payoff engine is used.** Bulk is not a second calculation path: every valid row is passed through the ordinary Phoenix lifecycle handler, preserving normal coupon, memory, knock-in, autocall and redemption derivation.
5. **Seed data is labelled honestly.** Demo fixings now identify their source as synthetic seeded market data rather than implying exchange/vendor prices.

## Remaining gaps / release gates

1. **Correction and restatement workflow (blocking for operational production use).** Add a correction request that preserves the original observation and source payload; require reason, corrected source/time/evidence and an independent approver; append a superseding event rather than mutate history; recompute all dependent lifecycle events/cashflows from a safe checkpoint; record who requested/approved it and notify downstream risk, valuation, reconciliation and reporting consumers. Define treatment when later observations or terminal events already exist. The current duplicate guard intentionally rejects a repeated observation instead of pretending this is solved.
2. **Maker-checker approval.** Ops/admin role restrictions are not equivalent to separation of duties. No independent review, self-approval prohibition or approval state exists. Define thresholds and delegation before live writes.
3. **Authorized market-data source and evidence object.** Source name and timestamp are required, while `evidenceRef` is optional and there is no vendor/exchange connector, raw quote payload, payload hash, feed sequence, stale/outlier check or source hierarchy. Live operations should preserve a retrievable immutable quote/evidence record and the approved source/venue/time methodology.
4. **Automated schedule/ingestion.** The queue is a read-only query run when the UI opens or refreshes. There is no timed run, exchange calendar close monitor, disruption state, service-level alert, vendor feed or unattended commit. Any future scheduler should enqueue/notify, not auto-post unreviewed or fabricated values.
5. **Product and venue coverage.** The new fixing queue and bulk path are for Phoenix products exposing a `FIXING` event. Other instruments need template-specific event/schema rules, units, market calendars, valuation time, currency/corporate-action handling and disruption/fallback semantics.
6. **Operational controls.** Production needs authorization by book/desk, limits/outlier escalation, evidence retention/retention period, correction reconciliation, monitoring, recovery, and observability around partial batches and downstream consumers.

## Verification

Focused browser journey:

```bash
npm run test:e2e:journey:trade-fixings
```

The focused Playwright cases book isolated trades, exercise one individual fixing through the lifecycle dialog, and preview/commit a two-trade batch from the due queue while asserting source and timestamp provenance. Repository-domain tests also cover due-date discovery, atomic no-write behavior on an invalid all-or-nothing batch, best-effort commit, persisted provenance, idempotent replay and idempotency-payload conflict.

**Verification run (2026-10-22):** focused fixing journeys: **2 passed**; trade-repository Playwright feature slice: **16 passed**; full Vitest suite: **268 passed, 1 skipped**; production build succeeded; Oxlint completed with **0 errors** (non-blocking warnings include the effect that loads the queue); `git diff --check` passed.
