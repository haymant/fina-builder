import { create } from 'zustand'
export type DashboardNote = { id: string; title: string; content: string; createdAt: string; updatedAt: string; pinned?: boolean }
export type DashboardUsage = { purpose: string; targetUsers: string[]; workflow: string; methodology: string; recommendedActions: string; relatedDashboards: string[]; updatedAt: string; editedBy: string }
export type DashboardTemplate = { id: string; name: string; description: string; targetRoles: string[]; usageMarkdown: string; tileTypes: string[] }
const now = () => new Date().toISOString()
// Monotonic so two notes created in the same millisecond never share an id
// (a `Date.now()`-only id made `duplicateNote` + `deleteNote` collide).
let noteSeq = 0
const nextNoteId = () => `note-${Date.now()}-${++noteSeq}`
const defaultUsage: DashboardUsage = { purpose: 'Explore the selected dashboard through its linked analytics and record findings in the notebook.', targetUsers: ['Quantitative Analysts'], workflow: '1. Review the headline metrics.\n2. Select a path or scenario.\n3. Inspect the detailed charts.\n4. Record conclusions in Notes.', methodology: 'Charts are driven by the selected trade economics, market data, path, and shared explain ledger.', recommendedActions: 'Start with the summary tiles, then drill down into exceptions and residuals.', relatedDashboards: ['Payoff Explorer', 'Market & Risk'], updatedAt: now(), editedBy: 'System' }
const templates: DashboardTemplate[] = [
 { id: 'trade-structuring', name: 'Trade Structuring Workspace', description: 'Design and challenge a structured product before execution.', targetRoles: ['Structurer'], usageMarkdown: '# Trade Structuring Workspace\n\n## Purpose\nDesign structured products and understand how economics change valuation and risk.\n\n## Audience\nStructurers and desk quants.\n\n## Workflow\n1. Set barriers, coupon, strike, and maturity in Trade Economics.\n2. Review Sensitivity Tornado and Parameter Impact Matrix.\n3. Compare scenarios and inspect the Payoff Evaluation Graph.\n4. Confirm risk and tail behavior with Quantile Fan.\n\n## Interpretation Guide\nTreat the sensitivity views as directional diagnostics. Confirm material changes in the path and market-risk views before sharing terms.\n\n## Common Mistakes\nDo not interpret a single path as a population result, and do not confuse market P&L with PLVA.\n\n## Related Dashboards\n[[Market & Risk]] · [[Valuation Explainability]]', tileTypes: ['RigaEconomicsImpactSummary','RigaSensitivityTornado','RigaScenarioComparison','RigaPayoffGraph','RigaQuantileFan','RigaRiskSummary'] },
 { id: 'trader', name: 'Trader Workspace', description: 'Monitor pricing, market risk, and daily changes.', targetRoles: ['Trader'], usageMarkdown: '# Trader Workspace\n\n## Purpose\nMonitor current pricing, risk, and scenario behavior during the trading day.\n\n## Audience\nTraders and desk risk managers.\n\n## Workflow\n1. Check Risk Summary and Greeks.\n2. Review spot, volatility, and FX moves.\n3. Stress the scenario comparison.\n4. Use Taylor Explain and the Explain Ledger to understand P&L.\n\n## Interpretation Guide\nMarket Explain describes moves in risk factors; PLVA describes valuation-methodology changes. Keep the two explanations separate.\n\n## Common Mistakes\nDo not treat model changes as market risk or rely on an unchallenged residual.\n\n## Related Dashboards\n[[Market & Risk]] · [[P&L Explain]]', tileTypes: ['RigaRiskSummary','RigaGreeksTable','RigaBucketVega','RigaMarketExplorer','RigaScenarioComparison','RigaTaylorExplain'] },
 { id: 'validation', name: 'Model Validation Workspace', description: 'Validate schedule, observation, simulation, and explainability behavior.', targetRoles: ['Model Validator','Quant Developer'], usageMarkdown: '# Model Validation Workspace\n\n## Purpose\nValidate model behavior from generated dates through valuation explain.\n\n## Audience\nModel validators and quant developers.\n\n## Workflow\n1. Step through Schedule Explorer.\n2. Verify Observation Explorer and path trace.\n3. Check Monte Carlo convergence.\n4. Compare Taylor, PLVA, and Explain Ledger reconciliation.\n\n## Interpretation Guide\nA healthy model has stable convergence, explainable event transitions, and a small residual.\n\n## Common Mistakes\nDo not validate only the final PV; trace the event and cashflow lineage.\n\n## Related Dashboards\n[[Monte Carlo Diagnostics]] · [[Valuation Explainability]]', tileTypes: ['RigaScheduleExplorer','RigaObservationSchedule','RigaPayoffGraph','RigaStatisticsSummary','RigaTaylorExplain','RigaExplainNet','RigaTransitionDetail','RigaMasterExplainWaterfall'] },
 { id: 'cashflow', name: 'Cashflow Workspace', description: 'Monitor settlement cashflows, discounting, and P&L.', targetRoles: ['Product Control','Trader'], usageMarkdown: '# Cashflow Workspace\n\n## Purpose\nMonitor what cashflows are expected, when they occur, and how they contribute to P&L.\n\n## Audience\nTrading, operations, and product control.\n\n## Workflow\n1. Review Cashflow Summary.\n2. Select bars in Cashflow Timeline.\n3. Inspect discounting and cashflow detail.\n4. Reconcile P&L and valuation explain.\n\n## Interpretation Guide\nSeparate nominal cashflows from discounted PV and realized from unrealized P&L.\n\n## Common Mistakes\nDo not compare a gross cashflow directly with PV or treat a future cashflow as realized.\n\n## Related Dashboards\n[[P&L Explain]] · [[Market & Risk]]', tileTypes: ['RigaCashflowSummary','RigaCashflowTimeline','RigaSelectedPath','RigaStatisticsSummary','RigaDistributionSummary'] },
 { id: 'desk-quant', name: 'Desk Quant Workspace', description: 'Understand model behavior and diagnostics end to end.', targetRoles: ['Desk Quant','Quant Developer'], usageMarkdown: '# Desk Quant Workspace\n\n## Purpose\nConnect path behavior, simulation quality, and valuation explainability.\n\n## Audience\nDesk quants and quantitative developers.\n\n## Workflow\n1. Review Quantile Fan and Monte Carlo Diagnostics.\n2. Trace a selected path through the Payoff Graph.\n3. Compare Taylor Explain with PLVA.\n4. Check the Explain Ledger residual.\n\n## Interpretation Guide\nUse the path views to understand behavior and the explain views to understand valuation change.\n\n## Common Mistakes\nDo not use a single path as a convergence test.\n\n## Related Dashboards\n[[Model Validation Workspace]]', tileTypes: ['RigaQuantileFan','RigaStatisticsSummary','RigaPayoffGraph','RigaTaylorExplain','RigaExplainNet'] },
 { id: 'market-risk', name: 'Market Risk Workspace', description: 'Monitor market risk, stresses, and scenario changes.', targetRoles: ['Market Risk','Cross Asset Analyst'], usageMarkdown: '# Market Risk Workspace\n\n## Purpose\nMonitor factor risk and scenario sensitivities.\n\n## Audience\nMarket risk and cross-asset analysts.\n\n## Workflow\n1. Review Risk Summary and Greeks.\n2. Check Bucket Vega, correlation, and FX.\n3. Compare base and shocked scenarios.\n4. Escalate unexplained changes through Taylor Explain.\n\n## Interpretation Guide\nUse market moves for risk monitoring and retain PLVA for methodology changes.\n\n## Common Mistakes\nDo not treat scenario P&L as realized P&L.\n\n## Related Dashboards\n[[Trader Workspace]]', tileTypes: ['RigaRiskSummary','RigaBucketVega','TacCorrelationMatrix','TacFxSpot','RigaScenarioComparison'] },
 { id: 'product-control', name: 'Product Control Workspace', description: 'Perform valuation controls and cashflow reconciliation.', targetRoles: ['Product Control'], usageMarkdown: '# Product Control Workspace\n\n## Purpose\nControl valuation, cashflows, methodology changes, and reconciliation.\n\n## Audience\nProduct control and valuation control teams.\n\n## Workflow\n1. Review cashflow analytics.\n2. Check valuation explain and PLVA.\n3. Inspect Explain Ledger entries.\n4. Investigate residuals before sign-off.\n\n## Interpretation Guide\nA small reconciled residual is expected; unexplained drift requires investigation.\n\n## Common Mistakes\nDo not sign off from the headline PV alone.\n\n## Related Dashboards\n[[Cashflow Workspace]] · [[P&L Explain Workspace]]', tileTypes: ['RigaCashflowSummary','RigaCashflowTimeline','RigaTaylorExplain','RigaExplainNet','RigaMasterExplainWaterfall','RigaTransitionDetail'] },
 { id: 'pnl-explain', name: 'P&L Explain Workspace', description: 'Run the daily market and methodology P&L explain process.', targetRoles: ['Trader','Product Control'], usageMarkdown: '# P&L Explain Workspace\n\n## Purpose\nExplain daily PV change using market attribution, PLVA, and residual analysis.\n\n## Audience\nTrading and product control.\n\n## Workflow\n1. Start with the Master Explain Waterfall.\n2. Review Taylor market contributions.\n3. Review PLVA categories.\n4. Reconcile the Explain Ledger and record findings.\n\n## Interpretation Guide\nMarket Explain answers what moved in the market; PLVA answers what changed in valuation methodology.\n\n## Common Mistakes\nNever hide a material residual inside a Greek or PLVA bucket.\n\n## Related Dashboards\n[[Market Risk Workspace]] · [[Product Control Workspace]]', tileTypes: ['RigaTaylorExplain','RigaExplainNet','RigaMasterExplainWaterfall','RigaTransitionDetail','RigaStatisticsSummary','RigaRiskNet'] },
 { id: 'executive', name: 'Executive Dashboard', description: 'High-level monitoring with no low-level diagnostics.', targetRoles: ['Management'], usageMarkdown: '# Executive Dashboard\n\n## Purpose\nProvide a concise view of valuation, risk, P&L, and explain coverage.\n\n## Audience\nManagement and senior stakeholders.\n\n## Workflow\n1. Review summary KPIs.\n2. Check current risk and P&L.\n3. Review valuation explain coverage.\n4. Escalate exceptions to the relevant analytical workspace.\n\n## Interpretation Guide\nUse this dashboard for direction and escalation, not model validation.\n\n## Common Mistakes\nAvoid drawing conclusions from headline KPIs without opening the supporting workspace.\n\n## Related Dashboards\n[[Market & Risk]] · [[P&L Explain]]', tileTypes: ['RigaRiskSummary','RigaCashflowSummary','RigaStatisticsSummary','RigaTaylorExplain','RigaMasterExplainWaterfall'] },
 { id: 'riga-lineage', name: 'riga-flow Lineage & Explainability Workspace', description: 'End-to-end riga-flow journey: connect → configure → price → Petri drill-down → explain → govern.', targetRoles: ['Desk Quant', 'Model Validation', 'Product Control'], usageMarkdown: `# riga-flow Lineage & Explainability Workspace

## Purpose
Drive the live \`riga-flow\` pricing/risk engine and read its evidence surface: the execution Petri net, the risk net, the explain ledger, and the statistics/attribution views. The UI computes nothing — every number comes from a \`riga-mcp\` tool or resource.

## Audience
Desk quants, model validation and product control.

## Connect
1. Build the engine: \`cargo build --release -p riga-mcp\` inside \`modules/riga-flow\`.
2. Desktop: \`fina-builder\` spawns \`riga-mcp --transport stdio\` from the submodule default path.
3. Browser / dev: run \`npm run mcp:http:riga\` (riga-mcp on \`127.0.0.1:8788\`). The webview talks to the same-origin path \`/riga/mcp\`, which Vite proxies to the server — calling \`127.0.0.1:8788\` directly is blocked by CORS / private-network-access and would hang.

## Configure
- **Trade Economics**: the worst-of Phoenix field set (\`RigaPhoenixTrade\`). \`price_trade\` is the authority; a rejected field shows the engine's \`{code,message}\`.
- **Market Data**: spots, ATM vols, dividends, scalar rate and the 2×2 correlation. Market data is *fetched* from \`tac-engine\` and manipulated in the **Market Data Workbench** (tac-engine template), then mapped here.
- \`riga-flow\` is 2-factor only: \`spots\`, \`vols\` and \`dividendYields\` have length 2; \`correlation\` is 2×2.

## How to read each net layer
| Layer | Tool | Reads |
| --- | --- | --- |
| Execution | \`query_execution_net\` | places, transitions, token counts, firing probability |
| Risk | \`query_risk_net\` | per-transition PV/Δ/ν impact, per-asset Greeks, DV01, ρ |
| Explain | \`get_ledger\` | condition, populations, PV/Δ/ν impact, evidence refs |

Click a transition to open **Transition Detail** (logic, populations, stats, and the *static* reference formula). Click a place to open **Token Detail** — a bounded sample composed from \`execution_events\` and \`query_path_cube\` (riga-flow returns counts, not token vectors; R-EXT-2).

## Trace level
The title-bar selector (Off · Sampled · Full) is authoritative for what the UI shows **and** sets \`SimulationConfig.trace_level\`:
- **Off** — aggregate only; no path switcher, timeline or token tape.
- **Sampled** — bounded path switcher, one path timeline, execution tape.
- **Full** — governance evidence, PL explain, valuation explain, root cause.

The engine's \`trace_level\` produces the same production content today; the UI level is what gates the path UI.

## Evidence line
Each tile footer names the tool and the run/snapshot id. The **Data Lineage** tile renders the determinism envelope (seed, as_of, market snapshot id) and the evidence refs as a directed graph (trade → market sha256 → seed → transitions).

## Govern
\`freeze_baseline\` → \`compare_corpus\` → \`triage_regression\`; \`root_cause\` renders the RCA finding and change log; \`export_governance_evidence\` lists assumptions, limitations and sampled paths.

## Related Dashboards
[[Market Data Workbench (tac-engine)]]`, tileTypes: ['RigaHealthRun','RigaTradeEconomics','RigaMarketData','RigaPayoffPetriNet','RigaTransitionDetail','RigaTokenDetail','RigaRiskNet','RigaExplainNet','RigaDataLineage','RigaStatisticsSummary','RigaTaylorExplain','RigaScenarioComparison','RigaBookRisk','RigaRegressionTriage','RigaRootCause','RigaGovernanceEvidence','RigaPathCubeQuery','RigaExecutionTape'] },
 { id: 'tac-market-data', name: 'Market Data Workbench (tac-engine)', description: 'Fetch market data from tac-engine (tac-lake/Alpaca), manipulate it, and feed the priced trade.', targetRoles: ['Desk Quant', 'Trader', 'Market Risk'], usageMarkdown: `# Market Data Workbench (tac-engine)

## Purpose
Fetch the market data that prices a structure from \`tac-engine\` (Alpaca market data + the local tac-lake of parquet/DuckDB), manipulate it in-memory, and map the effective market onto the \`riga-flow\` request.

## Audience
Desk quants, traders and market risk.

## Required environment
| Variable | Required | Notes |
| --- | --- | --- |
| \`TAC_LAKE_DIR\` | yes | absolute path, no default |
| \`APCA_API_KEY_ID\` | yes | Alpaca key |
| \`APCA_API_SECRET_KEY\` | yes | Alpaca secret |
| \`FRED_API_KEY\` | for \`load_macro_symbols\` / FRED tenors | never committed |

Keys live in the host environment or a user-owned \`.env\` **only**. They never appear in the UI, logs or persisted state, and the market-data tiles never fall back to fake data.

## Run
\`cargo build --release\` inside \`modules/tac-engine\`, then \`./target/release/tac-engine\`. \`tac-engine\` is **stdio-only**; in the browser it is reached through the Rust sidecar (T-EXT-3).

**Desktop (Tauri):** the app spawns tac-engine over stdio and forwards env loaded from \`.env\` files (app-data, repo root, \`modules/tac-engine/.env\`) — so \`TAC_LAKE_DIR\`, \`APCA_*\`, \`FRED_API_KEY\` work whether exported or in a \`.env\`.

**Browser / dev:** tac-engine is stdio-only, so run the local bridge \`npm run mcp:http:tac\` (HTTP on \`127.0.0.1:8790\`). The webview uses the same-origin path \`/tac/mcp\`, which Vite proxies to the bridge. Market-data tiles auto-fetch once on first mount.

## Lake layout & freshness
Hive-partitioned parquet (\`market=<M>/timeframe=<tf>/symbol=<SYM>.parquet\`) queried with DuckDB. \`get_lake_bars\` is cache-first with lazy backfill and returns \`source ∈ {lake, partial, fetched}\`. \`vol_surface\` and the \`rate_curve\` use a 10-minute cache. Use \`quiet:true\` for write-only backfills and gate a window with \`validate_lake_dataset\`.

## Fetch tools per tile
| Tile | Tool(s) |
| --- | --- |
| Symbol Picker | \`get_lake_symbols\`, \`get_lake_coverage\` |
| Bar Chart | \`get_lake_bars\` |
| TA / SP Panes | \`get_lake_ta\`, \`get_lake_sp\` |
| Correlation Matrix | \`corr_matrix\`, \`corr_calc\` |
| Vol Surface | \`vol_surface\`, \`vol_surface_status\` |
| Yield Curve | \`get_macro_bars\` (FRED \`DGS\` tenors) |
| FX Spot | \`get_forex_latest_rates\`, \`get_forex_rates\` |
| FX Vol | \`get_lake_fx_vol\` (realized) |
| Corporate Actions | \`get_corporate_actions\` |
| Lake Coverage | \`get_lake_coverage\`, \`get_lake_status\`, \`validate_lake_dataset\` |

## Manipulation → riga-flow mapping
Manipulations are in-memory overlays (\`spot\`, \`volatility\`, \`correlation\`, \`interest_rate\`, \`dividend\`, \`fx_spot\`, \`fx_volatility\`) with operations \`absolute | relative | set | parallel\`. The pure \`applyManipulations\` selector produces the effective market; correlation is PSD-clamped and vol-surface manipulations warn on arbitrage. The effective market maps onto \`RigaMarketSnapshot\` (spots, vols, dividends, scalar rate, 2×2 correlation) and feeds the priced trade. The lake is never mutated and no mutating tool is called.

FX and FX-vol are real market data but are **not** sent to \`riga-flow\` until R-EXT-1.

## Related Dashboards
[[riga-flow Lineage & Explainability Workspace]]`, tileTypes: ['TacMarketDataPanel','TacSymbolPicker','TacBarChart','TacTaSpPanes','TacCorrelationMatrix','TacVolSurface','TacYieldCurve','TacFxSpot','TacFxVol','TacCorporateActions','TacLakeCoverage','TacManipulationEditor','RigaTradeEconomics','RigaMarketData','RigaHealthRun'] },
]
function load() { try { return JSON.parse(localStorage.getItem('fina-dashboard-docs') ?? '{}') as { usage?: Record<string, DashboardUsage>; notes?: Record<string, DashboardNote[]> } } catch { return {} } }
const saved = typeof window !== 'undefined' ? load() : {}
type DocsState = { usage: Record<string, DashboardUsage>; notes: Record<string, DashboardNote[]>; templates: DashboardTemplate[]; updateUsage: (id: string, patch: Partial<DashboardUsage>) => void; addNote: (id: string) => void; updateNote: (dashboardId: string, noteId: string, patch: Partial<DashboardNote>) => void; deleteNote: (dashboardId: string, noteId: string) => void; duplicateNote: (dashboardId: string, noteId: string) => void; togglePin: (dashboardId: string, noteId: string) => void }
function persist(usage: Record<string, DashboardUsage>, notes: Record<string, DashboardNote[]>) { try { localStorage.setItem('fina-dashboard-docs', JSON.stringify({ usage, notes })) } catch { /* optional */ } }
export const useDashboardDocsStore = create<DocsState>((set) => ({ usage: saved.usage ?? {}, notes: saved.notes ?? {}, templates, updateUsage: (id, patch) => set((s) => { const usage = { ...s.usage, [id]: { ...(s.usage[id] ?? defaultUsage), ...patch, updatedAt: now(), editedBy: 'Local User' } }; persist(usage, s.notes); return { usage } }), addNote: (id) => set((s) => { const note: DashboardNote = { id: nextNoteId(), title: 'New Note', content: '## Finding\n\nDouble-click to edit this note.', createdAt: now(), updatedAt: now() }; const notes = { ...s.notes, [id]: [note, ...(s.notes[id] ?? [])] }; persist(s.usage, notes); return { notes } }), updateNote: (dashboardId, noteId, patch) => set((s) => { const notes = { ...s.notes, [dashboardId]: (s.notes[dashboardId] ?? []).map((n) => n.id === noteId ? { ...n, ...patch, updatedAt: now() } : n) }; persist(s.usage, notes); return { notes } }), deleteNote: (dashboardId, noteId) => set((s) => { const notes = { ...s.notes, [dashboardId]: (s.notes[dashboardId] ?? []).filter((n) => n.id !== noteId) }; persist(s.usage, notes); return { notes } }), duplicateNote: (dashboardId, noteId) => set((s) => { const source = (s.notes[dashboardId] ?? []).find((n) => n.id === noteId); if (!source) return s; const note = { ...source, id: nextNoteId(), title: `${source.title} Copy`, createdAt: now(), updatedAt: now() }; const notes = { ...s.notes, [dashboardId]: [note, ...(s.notes[dashboardId] ?? [])] }; persist(s.usage, notes); return { notes } }), togglePin: (dashboardId, noteId) => set((s) => { const notes = { ...s.notes, [dashboardId]: (s.notes[dashboardId] ?? []).map((n) => n.id === noteId ? { ...n, pinned: !n.pinned, updatedAt: now() } : n) }; persist(s.usage, notes); return { notes } }) }))
export { defaultUsage }
