export const DEFAULT_RD_WORKFLOW_YAML = `experiment_name: tac-rd-experiment

task:
  model:
    class: RankICLGBModel
    module_path: tac_qlib.contrib.model.rank_gbdt
    kwargs:
      loss: mse
      learning_rate: 0.02
      num_leaves: 31
      num_boost_round: 500
      early_stopping_rounds: 50
      min_data_in_leaf: 20
      colsample_bytree: 0.8
      subsample: 0.8
      subsample_freq: 1
      reg_alpha: 0.1
      reg_lambda: 1.0
      seed: 2026

  dataset:
    class: DatasetH
    module_path: qlib.data.dataset
    kwargs:
      handler:
        class: TACHandler
        module_path: tac_qlib.contrib.data.handler
        kwargs:
          instruments: SPY,QQQ,DIA
          start_time: 2020-01-01
          end_time: 2025-12-31
          fit_start_time: 2020-01-01
          fit_end_time: 2023-12-31
          freq: day
          market: US
          label: "Ref($close,-6)/Ref($close,-1)-1"
          feature_fields: "$open,$high,$low,$close,$volume,sp_ret,sp_rv5,sp_rv22"
          infer_processors:
            - class: DropAllNaN
              kwargs: {}
            - class: TACProcessInf
              kwargs: {}
            - class: TACCSRankNorm
              kwargs: {}
            - class: TACZScoreNorm
              kwargs: {}
            - class: Fillna
              kwargs: {}
      segments:
        train: [2020-01-01, 2023-12-31]
        valid: [2024-01-01, 2024-12-31]
        test: [2025-01-01, 2025-12-31]

  record:
    - class: SignalRecord
      module_path: qlib.workflow.record_temp
      kwargs: {}
    - class: SigAnaRecord
      module_path: qlib.workflow.record_temp
      kwargs:
        ana_long_short: true
        ann_scaler: 252
    - class: PortAnaRecord
      module_path: qlib.workflow.record_temp
      kwargs:
        config:
          strategy:
            class: TopkDropoutStrategy
            module_path: qlib.contrib.strategy
            kwargs:
              signal: "<PRED>"
              topk: 3
              n_drop: 1
              only_tradable: true
              risk_degree: 0.95
          backtest:
            start_time: 2025-01-01
            end_time: 2025-12-31
            account: 1000000
            benchmark: SPY
            exchange_kwargs:
              codes: [SPY, QQQ, DIA]
              deal_price: "$close"
              freq: day
              open_cost: 0.0005
              close_cost: 0.0015
              min_cost: 5.0
        risk_analysis_freq: 1d
`

export const RD_NOTEBOOK_PROMPT = `You are helping author a deterministic TradeAC R&D Qlib workflow YAML for fina-builder.

Return only one complete YAML document inside a fenced yaml block. Do not run tools or assume RIGA is available. The user will paste your YAML into fina-builder's R&D > Experiments > + editor, validate it, review its preflight summary, and confirm dispatch.

Requirements:
- Follow the exact bounded schema and approved class/module names in the starter document the user provides. Do not add qlib_init, filesystem paths, lake_root, provider URIs, MLflow/database URLs, credentials, Python/Jinja templates, custom modules, or extra keys.
- Use only LGBModel (qlib.contrib.model.gbdt) or RankICLGBModel (tac_qlib.contrib.model.rank_gbdt), DatasetH (qlib.data.dataset), TACHandler (tac_qlib.contrib.data.handler), approved processors (DropAllNaN, TACProcessInf, TACCSRankNorm, TACZScoreNorm, TACCSZScoreNorm, Fillna), records SignalRecord/SigAnaRecord/optional PortAnaRecord, and TopkDropoutStrategy (qlib.contrib.strategy).
- Keep the requested experiment name, market US, frequency day, explicit train/valid/test date ranges, universe and feature fields. Ensure dates are ordered and lie inside the handler's date window; fit dates must not extend past the train segment, and portfolio backtest dates must stay inside the test segment.
- Include explicit model seed. The service fixes LightGBM to one thread and deterministic mode, and rejects conflicting values.
- For portfolio analysis, keep strategy signal exactly <PRED>, benchmark and costs explicit, price expression $close, and universe codes consistent with the dataset.
- Never invent lake coverage or claim the run succeeded. The service will validate fields and actual data coverage before the user confirms execution.

Ask the user for missing dates, universe, label/features, model choice, and portfolio assumptions before producing YAML. Preserve their inputs; explain any assumptions outside the YAML only if requested.`
