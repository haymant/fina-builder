/**
 * Local agent skills.
 *
 * A skill is a named block of instructions injected into the system prompt to
 * steer how the assistant answers (Claude/Codex "agent skills" convention:
 * markdown instructions the model applies). This is intentionally simple and
 * in-process; skills are selected from the composer `+` menu and only shape the
 * prompt — they never grant new capabilities.
 */
export type AgentSkill = {
  id: string
  name: string
  description: string
  /** Instruction text appended to the system prompt while the skill is active. */
  instructions: string
}

export const AGENT_SKILLS: AgentSkill[] = [
  {
    id: 'explain-demo-data',
    name: 'Explain demo data',
    description: 'Distinguish synthetic/demo outputs from market-calibrated values.',
    instructions:
      'When you report tool results, state plainly that the paths, distributions, and diagnostics are synthetic demonstrator data, not live market values. Label every number as demo/illustrative.',
  },
  {
    id: 'risk-summary',
    name: 'Risk summary',
    description: 'Summarize heuristic risk sensitivities in plain language.',
    instructions:
      'Focus on the heuristic risk sensitivities and their direction. Do not present them as production greeks or as trading advice; describe them as illustrative.',
  },
  {
    id: 'path-walkthrough',
    name: 'Path walkthrough',
    description: 'Walk through a single payoff path step by step.',
    instructions:
      'Walk the user through one payoff path: its barriers, knock-in/knock-out status, and settlement. Prefer the get_path and execution_events tools.',
  },
  {
    id: 'cashflow-explain',
    name: 'Cashflow explain',
    description: 'Break down the cashflow schedule and aggregates.',
    instructions:
      'Explain the cashflow schedule components and aggregates for the selected trade, using the build_cashflows tool. Keep the explanation structural, not advisory.',
  },
]

const byId = new Map(AGENT_SKILLS.map((skill) => [skill.id, skill]))

export function skillsByIds(ids: readonly string[]): AgentSkill[] {
  return ids.map((id) => byId.get(id)).filter((skill): skill is AgentSkill => Boolean(skill))
}
