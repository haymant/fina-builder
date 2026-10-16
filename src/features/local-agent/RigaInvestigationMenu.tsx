// One-click riga-flow investigations (§12.4). The six `riga-mcp` prompts are
// grounded templates seeded with real legs + ledger; this menu drops a starter
// that asks the local agent to run the prompt and cite its evidence.

import { unstable_useComposerInput } from '@assistant-ui/react'
import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { RIGA_PROMPTS } from '../riga/hooks'

const STARTERS: Record<string, string> = {
  explain_pv_change:
    'Use the riga-flow prompt `explain_pv_change`. Explain the latest PV change from the explain ledger (get_ledger) and the Taylor/PL contributions, citing every evidence_ref. Do not invent numbers.',
  investigate_validation_failure:
    'Use the riga-flow prompt `investigate_validation_failure`. Run validate_greeks and root_cause, then explain the finding and the change log from evidence.',
  triage_regression:
    'Use the riga-flow prompt `triage_regression`. Compare the frozen baseline with the current run (compare_corpus / triage_regression) and list the exceptions by family.',
  summarise_risk_report:
    'Use the riga-flow prompt `summarise_risk_report`. Summarise the three most important risks from risk_batch, query_risk_net and recommend_scenarios, with evidence.',
  recommend_stress_scenarios:
    'Use the riga-flow prompt `recommend_stress_scenarios`. Recommend stress bands from recommend_scenarios and explain why each band matters.',
  compose_governance_section:
    'Use the riga-flow prompt `compose_governance_section`. Draft a model-governance narrative from export_governance_evidence: assumptions, limitations and lineage.',
}

export function RigaInvestigationMenu() {
  const { setText } = unstable_useComposerInput()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        className="agent-surface agent-text flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition"
        title="riga-flow investigations"
        aria-label="riga-flow investigations"
        onClick={() => setOpen((value) => !value)}
      >
        <FlaskConical size={12} /> riga
      </button>
      {open ? (
        <div className="agent-surface absolute bottom-9 left-0 z-20 w-64 rounded-lg border p-1 shadow-lg" role="menu">
          <p className="px-2 py-1 text-[9px] tracking-wide text-muted uppercase">riga-flow prompts</p>
          {RIGA_PROMPTS.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              className="block w-full rounded px-2 py-1 text-left font-mono text-[10px] text-main hover:bg-surface"
              onClick={() => {
                setText(STARTERS[name] ?? name)
                setOpen(false)
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
