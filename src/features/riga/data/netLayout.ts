// Real riga-flow execution-graph topology and layout.
//
// `query_execution_net` only returns a *summary* of three production-kernel
// transitions (`daily_global_ko`, `final_fixing_eki`, `memory_coupon`). The
// canonical workflow the atlas draws is the graph runtime's transition set
// (crates/riga-engine/src/{payoff.rs,note_graph.rs}):
//
//   worst_of_performance → global_ko_gate → ko_period
//   worst_of_performance → knock_in_gate  → ki_flag
//   worst_of_performance → coupon_strip   → coupon
//   worst_of_performance → memory_carry   → memory_coupon
//   {ki_flag, ko_period} → knock_in_alive → put_mask
//   {worst, put_mask}    → down_and_in_put→ put
//   ko_period            → notional_return→ funding
//   put/funding/coupon/memory_coupon → aggregate_* → *_pv
//
// This is reference structure (from the engine), not a computed result: the
// live token counts / probabilities / impacts are overlaid by the tile.

export interface Point {
  x: number
  y: number
}

export interface TopologyTransition {
  id: string
  inputs: string[]
  output: string
}

export const WORKFLOW_TRANSITIONS: TopologyTransition[] = [
  { id: 'worst_of_performance', inputs: ['start'], output: 'worst' },
  { id: 'global_ko_gate', inputs: ['worst'], output: 'ko_period' },
  { id: 'knock_in_gate', inputs: ['worst'], output: 'ki_flag' },
  { id: 'coupon_strip', inputs: ['worst', 'ko_period'], output: 'coupon' },
  { id: 'memory_carry', inputs: ['worst', 'ko_period'], output: 'memory_coupon' },
  { id: 'knock_in_alive', inputs: ['ki_flag', 'ko_period'], output: 'put_mask' },
  { id: 'notional_return', inputs: ['ko_period'], output: 'funding' },
  { id: 'down_and_in_put', inputs: ['worst', 'put_mask'], output: 'put' },
  { id: 'aggregate_coupon', inputs: ['coupon'], output: 'coupon_pv' },
  { id: 'aggregate_memory', inputs: ['memory_coupon'], output: 'memory_pv' },
  { id: 'aggregate_funding', inputs: ['funding'], output: 'funding_pv' },
  { id: 'aggregate_put', inputs: ['put'], output: 'put_pv' },
]

/** Source places (tensor/paths) with no incoming transition. */
export const WORKFLOW_SOURCES = ['start']

/**
 * Map the production-kernel ledger transition ids (returned by
 * `query_execution_net`) onto the workflow stages they correspond to, so the
 * live numbers land on the right node.
 */
export const ENGINE_TO_WORKFLOW: Record<string, string> = {
  daily_global_ko: 'global_ko_gate',
  final_fixing_eki: 'down_and_in_put',
  memory_coupon: 'memory_carry',
}

/** Map a `{id}_out` place to its workflow place. */
export const ENGINE_PLACE_TO_WORKFLOW: Record<string, string> = {
  daily_global_ko_out: 'ko_period',
  final_fixing_eki_out: 'put',
  memory_coupon_out: 'memory_coupon',
}

const COLUMN = 210
const ROW = 86

/** Longest-path rank of every place/transition in the DAG. */
function ranks(): Map<string, number> {
  const rank = new Map<string, number>()
  for (const source of WORKFLOW_SOURCES) rank.set(source, 0)
  // Relax until fixpoint (the graph is acyclic; a few passes suffice).
  for (let pass = 0; pass < WORKFLOW_TRANSITIONS.length + 1; pass++) {
    let changed = false
    for (const transition of WORKFLOW_TRANSITIONS) {
      const inputRank = Math.max(0, ...transition.inputs.map((input) => rank.get(input) ?? 0))
      const tRank = inputRank + 1
      if ((rank.get(transition.id) ?? -1) < tRank) {
        rank.set(transition.id, tRank)
        changed = true
      }
      if ((rank.get(transition.output) ?? -1) < tRank + 1) {
        rank.set(transition.output, tRank + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  return rank
}

export interface WorkflowLayout {
  /** Every node id with its kind and position. */
  nodes: Array<{ id: string; kind: 'place' | 'transition'; position: Point }>
  edges: Array<{ id: string; from: string; to: string }>
}

/** Lay the workflow out left→right by rank, top→bottom by insertion order. */
export function layoutWorkflow(): WorkflowLayout {
  const rank = ranks()
  const perColumn = new Map<number, number>()
  const nodes: WorkflowLayout['nodes'] = []

  const place = (id: string) => {
    const r = rank.get(id) ?? 0
    const row = perColumn.get(r) ?? 0
    perColumn.set(r, row + 1)
    nodes.push({ id, kind: 'place', position: { x: r * COLUMN, y: row * ROW } })
  }
  const transition = (id: string) => {
    const r = rank.get(id) ?? 0
    const row = perColumn.get(r) ?? 0
    perColumn.set(r, row + 1)
    nodes.push({ id, kind: 'transition', position: { x: r * COLUMN, y: row * ROW } })
  }

  for (const source of WORKFLOW_SOURCES) place(source)
  // Emit places and transitions in rank order so rows line up with the flow.
  const emitted = new Set<string>()
  const all = [
    ...WORKFLOW_TRANSITIONS.map((t) => ({ id: t.id, kind: 'transition' as const, rank: rank.get(t.id) ?? 0 })),
    ...WORKFLOW_TRANSITIONS.map((t) => ({ id: t.output, kind: 'place' as const, rank: rank.get(t.output) ?? 0 })),
  ].sort((a, b) => a.rank - b.rank)
  for (const item of all) {
    if (emitted.has(`${item.kind}:${item.id}`)) continue
    emitted.add(`${item.kind}:${item.id}`)
    if (item.kind === 'transition') transition(item.id)
    else place(item.id)
  }

  const edges: WorkflowLayout['edges'] = []
  for (const t of WORKFLOW_TRANSITIONS) {
    for (const input of t.inputs) edges.push({ id: `${input}->${t.id}`, from: input, to: t.id })
    edges.push({ id: `${t.id}->${t.output}`, from: t.id, to: t.output })
  }
  return { nodes, edges }
}

export function transitionLabel(id: string): string {
  return id
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
