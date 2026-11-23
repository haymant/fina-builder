const RD_TOOL_ARGS = new Map([
  ['rd_status', ['market']],
  ['rd_dataset', ['market', 'universe', 'start_time', 'end_time', 'fit_start_time', 'fit_end_time', 'freq', 'features', 'label', 'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end']],
  ['rd_exp_list', []],
  ['rd_exp_get_experiment', ['experiment_id']],
  ['rd_exp_get_run', ['run_id', 'experiment_id']],
  ['rd_exp_input', ['run_id', 'experiment_id']],
  ['rd_exp_dataset', ['run_id', 'experiment_id', 'group', 'instrument', 'page', 'page_size', 'sort', 'representation']],
  ['rd_exp_result', ['run_id', 'experiment_id']],
  ['rd_exp_model', ['run_id', 'experiment_id']],
  ['rd_exp_blotter', ['run_id', 'experiment_id']],
  ['rd_exp_lineage', ['run_id', 'experiment_id']],
  ['rd_trace_start', ['rational', 'details', 'experiment_name', 'evolved_from']],
  ['rd_trace_get', ['experiment_id']],
  ['rd_trace_list', ['limit']],
  ['rd_validate_workflow', ['config_yaml']],
  ['rd_run_workflow', ['config_yaml', 'experiment_name']],
  ['rd_predict', ['model_path', 'run_id', 'experiment_name', 'market', 'universe', 'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end', 'freq', 'features', 'label', 'out_dir', 'top']],
  ['rd_backtest', ['pred_path', 'start_time', 'end_time', 'market', 'topk', 'n_drop', 'risk_degree', 'benchmark', 'account', 'universe', 'open_cost', 'close_cost', 'min_cost', 'out_dir', 'risk_limits']],
  ['rd_strategy_targets', ['pred_path', 'signal_date', 'account', 'risk_degree', 'topk', 'n_drop', 'prices', 'risk_limits', 'equity', 'peak_equity']],
  ['rd_train', ['wait', 'market', 'universe', 'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end', 'freq', 'features', 'label', 'learning_rate', 'num_leaves', 'num_boost_round', 'early_stopping_rounds', 'colsample_bytree', 'subsample', 'subsample_freq', 'reg_alpha', 'reg_lambda', 'seed', 'experiment_name', 'record_analysis', 'benchmark', 'topk', 'n_drop', 'account', 'risk_degree', 'open_cost', 'close_cost', 'min_cost', 'risk_limits']],
])

const TAC_MUTATION_ARGS = new Map([
  ['place_order', ['symbol', 'side', 'type', 'time_in_force', 'qty', 'notional', 'limit_price', 'stop_price', 'trail_price', 'trail_percent', 'extended_hours', 'client_order_id', 'order_class', 'position_intent']],
  ['cancel_order', ['order_id']],
  ['get_order', ['order_id']],
  ['create_watchlist', ['name', 'symbols']],
  ['add_watchlist_asset', ['watchlist_id', 'symbol']],
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
  if (name === 'rd_trace_start') {
    if (typeof args.rational !== 'string' || args.rational.trim().length < 3 || args.rational.length > 5000) throw new Error('R&D rational must be 3-5000 characters')
    for (const key of ['details', 'experiment_name', 'evolved_from']) if (args[key] !== undefined && typeof args[key] !== 'string') throw new Error(`R&D ${key} must be a string`)
  }
  if (name === 'rd_train') {
    if (args.wait !== undefined && typeof args.wait !== 'boolean') throw new Error('R&D wait must be boolean')
    for (const key of ['train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end', 'experiment_name', 'market', 'universe', 'freq', 'features', 'label', 'benchmark', 'risk_limits']) if (args[key] !== undefined && typeof args[key] !== 'string') throw new Error(`R&D ${key} must be a string`)
    for (const key of ['learning_rate', 'colsample_bytree', 'subsample', 'reg_alpha', 'reg_lambda', 'risk_degree', 'open_cost', 'close_cost', 'min_cost']) if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) throw new Error(`R&D ${key} must be a finite number`)
    for (const key of ['num_leaves', 'num_boost_round', 'early_stopping_rounds', 'subsample_freq', 'seed', 'topk', 'n_drop', 'account']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 0)) throw new Error(`R&D ${key} must be a non-negative integer`)
  }
  if (name === 'rd_validate_workflow' || name === 'rd_run_workflow') {
    if (typeof args.config_yaml !== 'string' || !args.config_yaml.trim() || Buffer.byteLength(args.config_yaml, 'utf8') > 128 * 1024) throw new Error('R&D config_yaml must be a non-empty string no larger than 128 KiB')
    if (name === 'rd_run_workflow' && (typeof args.experiment_name !== 'string' || args.experiment_name.trim().length < 1 || args.experiment_name.length > 64)) throw new Error('R&D experiment_name must be a 1-64 character string')
    if (name === 'rd_validate_workflow' && args.experiment_name !== undefined) throw new Error('R&D experiment_name is not accepted for validation')
  }
  if (name === 'rd_exp_dataset') {
    if (typeof args.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.run_id)) throw new Error('R&D run_id is invalid')
    if (args.experiment_id !== undefined && (typeof args.experiment_id !== 'string' || !/^[0-9]{1,32}$/.test(args.experiment_id))) throw new Error('R&D experiment_id is invalid')
    if (!['train', 'valid', 'test', 'backtest'].includes(args.group)) throw new Error('R&D dataset group is invalid')
    if (typeof args.instrument !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(args.instrument)) throw new Error('R&D dataset instrument is invalid')
    if (!Number.isInteger(args.page) || args.page < 1 || args.page > 100000) throw new Error('R&D dataset page is invalid')
    if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 200) throw new Error('R&D dataset page_size is invalid')
    if (!['asc', 'desc'].includes(args.sort)) throw new Error('R&D dataset sort is invalid')
    if (args.representation !== undefined && !['raw', 'inference'].includes(args.representation)) throw new Error('R&D dataset representation is invalid')
  }
}

export function validateTacToolCall(params) {
  const name = params?.name
  const allowed = TAC_MUTATION_ARGS.get(name)
  if (!allowed) return
  const args = params?.arguments ?? {}
  validateObject('TAC', args)
  const invalid = Object.keys(args).find((key) => !allowed.includes(key))
  if (invalid) throw new Error(`TAC argument is not allowed: ${invalid}`)
  if (name === 'cancel_order' || name === 'get_order') {
    if (typeof args.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.order_id)) throw new Error('TAC order_id is invalid')
    return
  }
  if (name === 'add_watchlist_asset') {
    if (typeof args.watchlist_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.watchlist_id)) throw new Error('TAC watchlist_id is invalid')
    if (typeof args.symbol !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(args.symbol)) throw new Error('TAC watchlist symbol is invalid')
    return
  }
  if (name === 'create_watchlist') {
    if (typeof args.name !== 'string' || args.name.trim().length < 1 || args.name.length > 64) throw new Error('TAC watchlist name is invalid')
    if (args.symbols !== undefined && (!Array.isArray(args.symbols) || args.symbols.some((symbol) => typeof symbol !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(symbol)))) throw new Error('TAC watchlist symbols are invalid')
    return
  }
  if (typeof args.symbol !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(args.symbol)) throw new Error('TAC symbol is invalid')
  if (!['buy', 'sell'].includes(args.side)) throw new Error('TAC side must be buy or sell')
  if (!['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'].includes(args.type)) throw new Error('TAC order type is invalid')
  if (!['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'].includes(args.time_in_force)) throw new Error('TAC time_in_force is invalid')
  if ((args.qty === undefined) === (args.notional === undefined)) throw new Error('TAC order requires exactly one of qty or notional')
  for (const key of ['qty', 'notional', 'limit_price', 'stop_price', 'trail_price', 'trail_percent']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !/^\d+(\.\d{1,18})?$/.test(args[key]) || Number(args[key]) <= 0)) throw new Error(`TAC ${key} must be a positive decimal string`)
  if (args.client_order_id !== undefined && (typeof args.client_order_id !== 'string' || args.client_order_id.length > 128)) throw new Error('TAC client_order_id is invalid')
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
