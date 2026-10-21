# 53 — Trade repository UI specification

**Status:** IMPLEMENTED (v1) in `src/features/trade-repository/**`, exercised end-to-end by
`playwright/tests/trade-repository.spec.ts` and recorded by `walkthrough.spec.ts`.
Backend contract: `docs/52-trade-repository-design.md`.

## 1. Principles

Trade capture UIs are used for hours a day by traders, middle office and ops. Best
practice (Murex/Calypso blotters, Bloomberg TOMS, DTCC GTR portals, ag-grid finance demos)
translates into these rules:

1. **The blotter is home.** Dense, sortable, filterable grid; every other view is one click
   or one key away and returns to the same blotter state.
2. **Detail without losing context.** A side drawer, not a page navigation; the grid stays
   visible and selectable.
3. **History is never hidden.** Every trade shows its version, last event, full immutable
   timeline and a field-level diff between any two versions.
4. **Validation is early, specific and server-authoritative.** Inline field errors from the
   same rules the server enforces; warnings don't block; the submit button explains itself.
5. **Destructive and lifecycle actions are explicit.** Dedicated dialogs per event with the
   event's semantics spelled out, required fields only, reasons captured for audit.
6. **Time travel is obvious.** When looking at the past the whole UI says so and becomes
   read-only.
7. **Keyboard-first, mouse-friendly.**
8. **Honest states.** Loading, empty and error states are distinct and actionable; no fake
   data (doc 51 I-10).
9. **Entitlement-aware.** Actions the user cannot perform are not shown (and the server
   still enforces them).

## 2. Placement in the app

The app header keeps its structure (brand, dashboard select, theme toggle, trace level).
The **dashboard tab strip** gains a fixed, built-in tab **“Trade Repository”** (database
icon) after the tile dashboards (`data-testid=tab-trade-repository`). Selecting it
swaps the react-grid-layout canvas for the trade repository workspace (lazy-loaded chunk);
the dashboard tabs, Add tile, Chat and Notebook buttons stay where they are. Selecting a
dashboard tab returns to tiles. Styling reuses the theme tokens (`--theme-panel`,
`--theme-grid`, `--theme-primary`, `--theme-success/danger/warning`), the existing
`add-tile-button`, `icon-button`, `control-select`, `eyebrow`, `modal-backdrop` classes,
IBM Plex Sans/Mono, and an ag-grid Quartz theme bound to those tokens so light/dark mode
follow the app toggle.

```text
┌ header (unchanged) ─────────────────────────────────────────────────────────────────────┐
│ [dashboards…] [Trade Repository]                         [+Add tile] [Chat] [Notebook]  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Blotter 1 | Positions 2 | Reconciliation 3 | Audit log 4 | Bulk import 5   [As-of] [User▾] [⌨] │
│ ⚠ time-travel banner (only when as-of is set)                                           │
│ ┌ view body ───────────────────────────────────────────┐ ┌ trade drawer (440px) ───────┐ │
│ │ toolbar / facets / grid                              │ │ header · actions · tabs     │ │
│ └──────────────────────────────────────────────────────┘ └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Workspace header

| Element | Behaviour |
| --- | --- |
| View tabs (Blotter, Positions, Reconciliation, Audit log, Bulk import) | ARIA `tablist`; shortcut digit shown as `<kbd>`. |
| **As-of** toggle | Reveals *Business date* (`validAt`, date) and *Known at* (`knownAt`, local datetime → UTC). Any value set ⇒ amber banner “Time travel: showing the repository as of … / as known at … Editing is disabled.”; New trade and all drawer actions are hidden. |
| Acting user | Select of reference users with role (`admin`, `trader`, `ops`, `viewer`). Sets the MCP `context`; refreshes all views. (Demo affordance for entitlements; in production this is the signed-in user.) |
| Shortcuts button | Opens the shortcuts dialog. |
| Toasts | Bottom-right (sonner): success messages for book/amend/lifecycle/import/break changes, including new ids and versions. |

## 4. Blotter

**Toolbar:** View select (saved views) · Save view · Delete view (user views only) ·
“modified” indicator when the current state differs from the view · search box
(`/` focuses; matches tradeId, UTI, externalId, underlying, trader, counterparty, book) ·
Group-by select · **Columns** chooser · **CSV** export · **+ New trade `N`** (hidden for
viewers and in time travel).

**Facets:** chip toggles for Status (LIVE, CANCELLED, MATURED, NOVATED, EXERCISED,
TERMINATED) and Product (IRS, FX FORWARD, EQUITY OPTION, CDS, PHOENIX AUTOCALL), `aria-pressed`.
Live trade count on the right. All filtering is **server-side** (`tr_trade_query`) with a
200 ms debounce; the client pages through `nextCursor` so the grid always holds the full
result.

**Grid (ag-grid community):** columns Trade · v · Status (badge) · Product · Side ·
Notional (compact `25.00m`) · Ccy · Underlying · Rate (`%`, 3dp) · Strike · C/P · Trade
date · Maturity · Counterparty · Book · Legal entity · Trader · UTI (mono) · Last event.
Sortable, resizable, per-column filter menus. Terminal trades are dimmed. Single-row
selection; click or **Enter** opens the drawer; the selected row stays highlighted.

**Grouping:** row grouping is an ag-grid *enterprise* feature, so v1 implements it
client-side: group header rows (full-width colspan) “▸ RATES-GBP (12) · net 35.00m”,
click to expand/collapse, groups sorted by key. Group by Book, Product, Counterparty,
Status, Currency, Legal entity.

**Column chooser:** popover with a checkbox per column (Trade is mandatory). Hidden
columns are part of a saved view.

**Saved views:** built-ins *All trades*, *Live only*, *Live by book* (grouped),
*Rates desk*; user views (★) store search text, facets, hidden columns and group-by in
`localStorage` (`fina.trade-repo.views.v1`) — a user preference, not business data.

**Export:** `tr_export` with the current filter and as-of → downloads
`trades-YYYY-MM-DD.csv`.

## 5. Trade detail drawer

Right-hand panel, 440 px, closes with × or **Esc**, keeps the grid interactive.

* **Header:** eyebrow “Trade detail”, `tradeId`, status badge, `vN`.
* **Time-travel note:** “Showing vN as of the selected time — latest is vM. Actions are
  disabled in time-travel mode.”
* **Action bar** (only LIVE, latest, entitled): **Amend** (primary) then the allowed
  lifecycle events returned by `tr_trade_get.allowedEvents` — Cancel (danger hover),
  Novate, Partial terminate, Exercise (options/autocalls only — server-rejected
  otherwise), Mature, Book transfer.
* **Tabs:**
  * *Economics:* definition list of economic, booking and system fields; UTI and content
    hash in mono; **Novated to / Novated from** as links that open the linked trade.
  * *Timeline (n):* vertical timeline, newest first: `vN · EVENT`, amend kind badge
    (ECONOMIC amber / NON-ECONOMIC blue), resulting status, “valid from … · recorded … ·
    by …”, the reason in quotes, and up to six changed fields `field before → after`.
  * *Version diff:* two version selects (defaults: previous → latest) and a table
    Field | vA (red, struck) | vB (green) | ECONOMIC badge.

## 6. Booking and amend form

Wide modal (3 columns ≥ 900 px, 1 column below). Fieldsets **Economics** (product, side
with market wording “Buy / pay fixed / long”, notional, currency, then *product-specific*
fields by progressive disclosure: IRS → fixed rate + index; FX forward → forward rate +
pair; option → underlying, call/put, strike, quantity; CDS → reference entity + spread;
Phoenix → basket + strike), **Dates** (trade, effective, maturity) and **Parties &
booking** (counterparty with LEI-backed names, book with name, trader, venue, external
id, comment).

* **Live validation:** every change (250 ms debounce) calls `tr_trade_validate`; errors
  render under the field (`aria-invalid`, red border) and disable submit; warnings
  (fat-finger > 5bn, off-market rate) render in an amber box but do not block.
* **Server errors** after submit (DUPLICATE, FORBIDDEN, CONFLICT) render in a red alert
  at the top; field-level `details` map back onto fields. CONFLICT tells the user to
  reopen to see the latest version.
* **Idempotency:** the form allocates an idempotency key when opened and shows it;
  double-click or retry cannot double-book.
* **Amend mode:** prefilled; changed fields get an amber left rule; footer shows
  “N field(s) changed · Economic/Non-economic amendment” (classification mirrors the
  server); **Reason** is mandatory; the book is read-only with a hint to use Book
  transfer; submit sends only changed fields with `expectedVersion`.
* On success the modal closes, the drawer opens on the trade, and a toast shows the id,
  UTI or new version.

## 7. Lifecycle dialogs

One dialog per event with a one-line explanation of its semantics, effective date
(defaults: today; maturity date for MATURE) and only the required parameters:

| Event | Fields | Notes |
| --- | --- | --- |
| Cancel | reason (required) | Danger-styled confirm. |
| Partial terminate | notional to terminate (shows outstanding) | Error if ≥ outstanding. |
| Novate | transferee (excludes current counterparty) | Toast shows the successor trade id; drawer shows links. |
| Exercise | — | Options / autocalls only. |
| Mature | effective date ≥ maturity | |
| Book transfer | destination book (excludes current) | |

Errors (`INVALID_TRANSITION`, `VALIDATION_FAILED` with paths, `CONFLICT`) display inline;
the dialog stays open.

## 8. Positions

Toolbar of dimension chips (Book, Product, Underlying, Currency, Counterparty, Legal
entity; any combination, order preserved) and a summary “N positions from M live
trades”. Grid: the chosen dimensions + Net (green/red), Gross, Long, Short notional and
trade count, sorted by gross. **Double-click** drills into the blotter with a “Position
drill-down: n trades” banner and opens the first trade. **Publish risk snapshot** calls
`tr_position_snapshot` and confirms the doc-51 `fina.position-snapshot/v1` id/version and
position count — the hand-off to valuation/risk. Honors as-of.

## 9. Reconciliation

* **KPI strip** for the latest run: run id/source/time, matched (of external), breaks by
  type.
* **Break status chips** (default OPEN + INVESTIGATING) and **Run reconciliation…** (ops/
  admin) — dialog with source name and the external records (JSON array keyed by UTI).
* **Breaks grid:** id, type, status badge, trade id, UTI, assignee, a human-readable
  detail (“notional: ours 10000000 vs theirs 11000000”).
* **Break panel** (right): status, type/source, link to the trade, raw detail, assignee,
  *Assign to me*, comment box, transition buttons allowed from the current status
  (Investigating / Resolved / Waived / Reopen). Resolving or waiving requires a comment
  (server-enforced, error shown inline). Comment history below. Read-only note for
  traders/viewers.

## 10. Audit log

Filters: actor, action (closed list), target id. Grid: when (UTC), actor, role, action,
target with version, detail JSON, correlation id. Newest first, “N entries
(append-only)”. Double-click a trade entry opens the trade.

## 11. Bulk import

Two-pane layout. Left: instructions, drop zone / file picker (CSV), a monospace textarea
(“Insert template” writes the header row), mode select (**All or nothing** default /
**Best effort**), **Validate** (dry run) and **Commit import**. Commit is enabled only
after a successful dry run of the current text, and — in all-or-nothing mode — only when
there are no row errors. Right: summary (“Dry run: 2 valid, 1 with errors”, then
“Committed … n booked”) and a per-row grid (row, OK/ERROR badge, external id, booked
trade id, all issues with field paths).

## 12. Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus blotter search (switches to Blotter) |
| `N` | New trade |
| `A` | Amend the selected trade (if LIVE) |
| `1`–`5` | Switch view |
| `T` | Toggle as-of time travel |
| `Enter` | Open the focused grid row |
| `Esc` | Close dialog, else close drawer |
| `?` | Shortcuts dialog |

Shortcuts are ignored while typing in inputs and while a dialog is open (except Esc).

## 13. States

| State | Treatment |
| --- | --- |
| Loading | Centered spinner + label (“Loading trades…”, “Connecting to trade repository…”), `aria-busy`. |
| Empty | Inbox icon, title (“No trades match”), hint (clear filters / book or import), **Reset filters** action. Positions/recon/audit have their own copy. |
| Error — server down | “Trade repository unavailable”, the message, the command to start it (`npm run mcp:http:trade-repo`), **Retry**. |
| Error — other | Code + message + correlation id + Retry. |
| Time travel | Amber banner + read-only. |
| Forbidden | Actions hidden; server errors shown inline if attempted. |

## 14. Accessibility

Tabs use `role=tablist/tab` + `aria-selected`; chips use `aria-pressed`; dialogs
`role=dialog` with `aria-label`; invalid inputs `aria-invalid`; alerts `role=alert`;
every control has a label; colour is never the only signal (badges carry text).

## 15. Test hooks

Stable `data-testid`s (`blotter-grid`, `trade-drawer`, `action-<EVENT>`, `f-<field>`,
`l-<field>`, `facet-status-<S>`, `break-to-<S>`, …) are part of this spec; the Playwright
suite depends on them.
