# TAC Engine feature candidates for R&D

Use these examples to select candidate model inputs; they are not additional YAML keys.

- **Raw daily fields:** `$open`, `$high`, `$low`, `$close`, `$volume`, and `$vwap` where available.
- **Parameterized TA indicators:** the lake TA feature operation accepts period forms such as `ema-20`, `ema_20`, or `ema20` and persists the output column as `ema_20`. Typical output fields include `sma_{n}`, `ema_{n}`, `dema_{n}`, `tema_{n}`, `trima_{n}`, `wma_{n}`, `t3_{n}`, `rma_{n}`, `rsi_{n}`, `mom_{n}`, `roc_{n}`, `cci_{n}`, `adx_{n}`, `atr_{n}`, and `natr_{n}`; replace `{n}` with a positive period such as `20`.
- **Other TA outputs:** `macd`, `macd_signal`, `macd_hist`, `bb_upper`, `bb_middle`, `bb_lower`, `stoch_k`, `stoch_d`, and `obv` are examples of multi-output or non-periodized indicators.
- **Implemented stochastic-process (SP) examples:** `sp_ou_zscore`, `sp_ou_half_life`, `sp_hmm_p_regime1`, `sp_hmm_state`, `sp_jump_ratio`, `sp_jump_flag`, `sp_rv1`, `sp_rv5`, `sp_rv22`, `sp_vol_ratio_5_22`, `sp_trend_slope_5`, `sp_trend_slope_20`, `sp_trend_slope_60`, `sp_ret_22`, `sp_ret_63`, `sp_ret_126`, `sp_ret_252`, and `sp_garch_cond_var`.

Write selected fields in `feature_fields` as comma-separated Qlib fields, normally prefixed with `$` (for example, `$ema_20`). A candidate is not evidence that a column exists in the user's lake. Check the selected market, symbols, and date coverage. For missing TA columns, use the TAC Engine lake TA operation with persistence enabled; for missing SP columns, use the corresponding stochastic-process feature workflow. Confirm the actual persisted column names, then validate/preflight the unchanged workflow. The R&D YAML selects persisted features; it does not calculate them. Prevent lookahead leakage: never use the label or future data as a model input. See the `tradeac-lake` skill for lake-tool operation details.
