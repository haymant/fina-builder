// Golden transcript (§14.1): pin the canonical serialisation of the recorded
// riga-flow session. A drift here means the UI's parity anchor changed — the
// same discipline riga-flow applies to its own fixtures.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RIGA_TRANSCRIPT, TAC_TRANSCRIPT } from '../../../tests/mocks/transcripts'

const RIGA_TOOLS_SHA256 = '9b91509de7e8e4769458cbc64ccf93805953bc3715178fd99ff79e81c9ab0a05'
const TAC_TOOLS_SHA256 = '6813ee7e366f554ad1ce09f69cb2614889573cf77522952749bf4ae0eefe7945'

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Every riga tool the UI calls must be present in the transcript. */
const REQUIRED_RIGA_TOOLS = [
  'health', 'price_put', 'price_trade', 'explain_pv_attribution', 'list_markets', 'get_market', 'get_ledger',  'query_execution_net', 'query_risk_net', 'get_branch_stats', 'get_distributions', 'get_mc_diagnostics',
  'mc_convergence', 'distributions_histogram', 'risk_batch', 'compute_book_risk', 'price_book_async', 'scenario', 'validate_greeks', 'recommend_scenarios',
  'recommend_scenarios', 'risk_detailed', 'trade_design', 'path_series', 'payoff_graph', 'percentile_convergence',
  'query_path_cube', 'execution_events', 'get_path', 'replay_path', 'pl_explain', 'valuation_explain',
  'root_cause', 'export_governance_evidence', 'freeze_baseline', 'compare_corpus', 'triage_regression',
]

describe('riga-flow golden transcript', () => {
  it('matches the pinned SHA-256', () => {
    expect(sha256(RIGA_TRANSCRIPT.tools)).toBe(RIGA_TOOLS_SHA256)
  })

  it('covers every tool the UI calls', () => {
    for (const tool of REQUIRED_RIGA_TOOLS) {
      expect(RIGA_TRANSCRIPT.tools, `missing ${tool}`).toHaveProperty(tool)
    }
  })
})

describe('tac-engine golden transcript', () => {
  it('matches the pinned SHA-256', () => {
    expect(sha256(TAC_TRANSCRIPT.tools)).toBe(TAC_TOOLS_SHA256)
  })

  it('lists only non-mutating tools and forbids trading tools', () => {
    for (const forbidden of TAC_TRANSCRIPT.forbidden) {
      expect(Object.keys(TAC_TRANSCRIPT.tools)).not.toContain(forbidden)
    }
  })

  it('captures the live riga-flow market snapshot id', () => {
    const put = RIGA_TRANSCRIPT.tools.price_put as { result: { determinism: { market_snapshot_id: string } } }
    expect(put.result.determinism.market_snapshot_id).toMatch(/^sha256:/)
  })
})
