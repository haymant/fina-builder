const RD_TOOL_ARGS = new Map([
  ['rd_exp_list', []],
  ['rd_exp_get_experiment', ['experiment_id']],
  ['rd_exp_get_run', ['run_id', 'experiment_id']],
  ['rd_exp_input', ['run_id', 'experiment_id']],
  ['rd_exp_result', ['run_id', 'experiment_id']],
  ['rd_exp_model', ['run_id', 'experiment_id']],
  ['rd_exp_lineage', ['run_id', 'experiment_id']],
])

const RISKCUBE_TOOL_ARGS = new Map([
  ['riskcube_capabilities', []],
  ['risk_cube_partitions', []],
  ['olap_query', ['scope', 'dimensions', 'measures', 'aggregation', 'filters', 'limit']],
])

function validateObject(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${name} arguments must be an object`)
}

export function validateRdToolCall(params) {
  const name = params?.name
  const allowed = RD_TOOL_ARGS.get(name)
  if (!allowed) throw new Error(`R&D tool is not allowed: ${String(name)}`)
  const args = params?.arguments ?? {}
  validateObject('R&D', args)
  const invalid = Object.keys(args).find((key) => !allowed.includes(key))
  if (invalid) throw new Error(`R&D argument is not allowed: ${invalid}`)
}

export function validateRiskcubeToolCall(params) {
  const name = params?.name
  const allowed = RISKCUBE_TOOL_ARGS.get(name)
  if (!allowed) throw new Error(`RiskCube tool is not allowed: ${String(name)}`)
  const args = params?.arguments ?? {}
  validateObject('RiskCube', args)
  const invalid = Object.keys(args).find((key) => !allowed.includes(key))
  if (invalid) throw new Error(`RiskCube argument is not allowed: ${invalid}`)
  if (name === 'olap_query' && typeof args.limit !== 'number') throw new Error('RiskCube query limit is required')
}
