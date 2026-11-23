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
          instruments: SPY,QQQ
          start_time: 2026-01-02
          end_time: 2026-08-10
          fit_start_time: 2026-01-02
          fit_end_time: 2026-05-29
          freq: day
          market: US
          label: "Ref($close,-6)/Ref($close,-1)-1"
          feature_fields: "$open,$high,$low,$close,$volume"
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
        train: [2026-01-02, 2026-05-29]
        valid: [2026-06-01, 2026-06-30]
        test: [2026-07-01, 2026-08-10]

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
            start_time: 2026-07-01
            end_time: 2026-08-10
            account: 1000000
            benchmark: SPY
            exchange_kwargs:
              codes: [SPY, QQQ]
              deal_price: "$close"
              freq: day
              open_cost: 0.0005
              close_cost: 0.0015
              min_cost: 5.0
        risk_analysis_freq: 1d
`
