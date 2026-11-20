"""HMM-regime overlay TopkDropout strategy.

Regime-gate overlay on ``qlib.contrib.strategy.signal_strategy.TopkDropoutStrategy``:
selection and sizing are identical to the reference, but a name is only BOUGHT
(entry gate) when its per-symbol HMM regime posterior ``sp_hmm_p_regime1`` on
the signal date is >= ``regime_threshold``; otherwise it is held in cash instead
of being opened.

The regime posterior is read from the lake feature provider on the fly via
``qlib.data.D.features`` (field ``$sp_hmm_p_regime1``) for the signal window, so
no regime column needs to enter the model's ``feature_fields`` — the gate is a
pure overlay (book ch.01: regime flags regressed as model features, survived
only as an overlay). The HMM itself was fit with ``fit_end=<train end>`` when
the lake features were backfilled, so there is no lookahead.

Names already held are NOT force-sold when the regime turns unfavourable
(entry gate only, matching the queue-10 design).
"""

from __future__ import annotations

from typing import List

import numpy as np
import pandas as pd

from qlib.backtest import Order
from qlib.backtest.decision import OrderDir, TradeDecisionWO
from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

try:
    from qlib.data import D
except ImportError:  # pragma: no cover - qlib always present in this stack
    D = None

__all__ = ["RegimeGateDropoutStrategy"]

DEFAULT_REGIME_THRESHOLD = 0.5
REGIME_FIELD = "$sp_hmm_p_regime1"


class RegimeGateDropoutStrategy(TopkDropoutStrategy):
    """TopkDropout with an HMM-regime entry gate on buy candidates.

    Parameters
    ----------
    topk, n_drop, method_sell, method_buy, hold_thresh, only_tradable,
    forbid_all_trade_at_limit : same as ``TopkDropoutStrategy``.
    regime_threshold : minimum ``sp_hmm_p_regime1`` posterior required to open a
        new position (default 0.5).
    """

    def __init__(self, *, topk, n_drop, regime_threshold: float = DEFAULT_REGIME_THRESHOLD, **kwargs):
        super().__init__(topk=topk, n_drop=n_drop, **kwargs)
        self.regime_threshold = regime_threshold

    def _regime_for(self, codes, pred_start, pred_end) -> pd.Series:
        """Return {code: sp_hmm_p_regime1} for the signal window (last day)."""
        if D is None:
            return pd.Series(dtype=float)
        try:
            df = D.features(list(codes), [REGIME_FIELD], start_time=pred_start, end_time=pred_end, freq="day")
        except Exception:  # noqa: BLE001 - a regime read failure should gate open, not crash
            return pd.Series(dtype=float)
        if df is None or len(df) == 0:
            return pd.Series(dtype=float)
        # df index is MultiIndex (datetime, instrument); take the last day's values
        df = df.reset_index()
        ts_col = "datetime" if "datetime" in df.columns else df.columns[0]
        sym_col = "instrument" if "instrument" in df.columns else df.columns[1]
        last_ts = df[ts_col].max()
        last = df[df[ts_col] == last_ts]
        out = {}
        for _, row in last.iterrows():
            sym = str(row[sym_col]).split("/")[-1].upper()
            val = row.iloc[-1]
            out[sym] = float(val) if val == val else np.nan
        return pd.Series(out)

    def generate_trade_decision(self, execute_result=None):
        import copy

        trade_step = self.trade_calendar.get_trade_step()
        trade_start_time, trade_end_time = self.trade_calendar.get_step_time(trade_step)
        pred_start_time, pred_end_time = self.trade_calendar.get_step_time(trade_step, shift=1)
        pred_score = self.signal.get_signal(start_time=pred_start_time, end_time=pred_end_time)
        if isinstance(pred_score, pd.DataFrame):
            pred_score = pred_score.iloc[:, 0]
        if pred_score is None:
            return TradeDecisionWO([], self)

        if self.only_tradable:

            def get_first_n(li, n, reverse=False):
                cur_n = 0
                res = []
                for si in reversed(li) if reverse else li:
                    if self.trade_exchange.is_stock_tradable(
                        stock_id=si, start_time=trade_start_time, end_time=trade_end_time
                    ):
                        res.append(si)
                        cur_n += 1
                        if cur_n >= n:
                            break
                return res[::-1] if reverse else res

            def get_last_n(li, n):
                return get_first_n(li, n, reverse=True)

            def filter_stock(li):
                return [
                    si
                    for si in li
                    if self.trade_exchange.is_stock_tradable(
                        stock_id=si, start_time=trade_start_time, end_time=trade_end_time
                    )
                ]

        else:

            def get_first_n(li, n):
                return list(li)[:n]

            def get_last_n(li, n):
                return list(li)[-n:]

            def filter_stock(li):
                return li

        current_temp: "object" = copy.deepcopy(self.trade_position)
        sell_order_list: List[Order] = []
        buy_order_list: List[Order] = []
        cash = current_temp.get_cash()
        current_stock_list = current_temp.get_stock_list()
        last = pred_score.reindex(current_stock_list).sort_values(ascending=False).index

        if self.method_buy == "top":
            today = get_first_n(
                pred_score[~pred_score.index.isin(last)].sort_values(ascending=False).index,
                self.n_drop + self.topk - len(last),
            )
        elif self.method_buy == "random":
            topk_candi = get_first_n(pred_score.sort_values(ascending=False).index, self.topk)
            candi = list(filter(lambda x: x not in last, topk_candi))
            n = self.n_drop + self.topk - len(last)
            try:
                today = np.random.choice(candi, n, replace=False)
            except ValueError:
                today = candi
        else:
            raise NotImplementedError(f"This type of input is not supported")

        comb = pred_score.reindex(last.union(pd.Index(today))).sort_values(ascending=False).index

        if self.method_sell == "bottom":
            sell = last[last.isin(get_last_n(comb, self.n_drop))]
        elif self.method_sell == "random":
            candi = filter_stock(last)
            try:
                sell = pd.Index(np.random.choice(candi, self.n_drop, replace=False) if len(last) else [])
            except ValueError:
                sell = candi
        else:
            raise NotImplementedError(f"This type of input is not supported")

        buy = today[: len(sell) + self.topk - len(last)]

        # ---- regime gate -----------------------------------------------------
        if buy:
            regime = self._regime_for(buy, pred_start_time, pred_end_time)
            gated = [c for c in buy if regime.get(c, np.nan) >= self.regime_threshold]
        else:
            gated = []

        for code in current_stock_list:
            if not self.trade_exchange.is_stock_tradable(
                stock_id=code,
                start_time=trade_start_time,
                end_time=trade_end_time,
                direction=None if self.forbid_all_trade_at_limit else OrderDir.SELL,
            ):
                continue
            if code in sell:
                time_per_step = self.trade_calendar.get_freq()
                if current_temp.get_stock_count(code, bar=time_per_step) < self.hold_thresh:
                    continue
                sell_amount = current_temp.get_stock_amount(code=code)
                sell_order = Order(
                    stock_id=code,
                    amount=sell_amount,
                    start_time=trade_start_time,
                    end_time=trade_end_time,
                    direction=Order.SELL,
                )
                if self.trade_exchange.check_order(sell_order):
                    sell_order_list.append(sell_order)
                    trade_val, trade_cost, trade_price = self.trade_exchange.deal_order(
                        sell_order, position=current_temp
                    )
                    cash += trade_val - trade_cost

        if len(gated) == 0:
            return TradeDecisionWO(sell_order_list, self)

        value = cash * self.risk_degree / len(gated)
        for code in gated:
            if not self.trade_exchange.is_stock_tradable(
                stock_id=code,
                start_time=trade_start_time,
                end_time=trade_end_time,
                direction=None if self.forbid_all_trade_at_limit else OrderDir.BUY,
            ):
                continue
            buy_price = self.trade_exchange.get_deal_price(
                stock_id=code, start_time=trade_start_time, end_time=trade_end_time, direction=OrderDir.BUY
            )
            buy_amount = value / buy_price
            factor = self.trade_exchange.get_factor(
                stock_id=code, start_time=trade_start_time, end_time=trade_end_time
            )
            buy_amount = self.trade_exchange.round_amount_by_trade_unit(buy_amount, factor)
            buy_order = Order(
                stock_id=code,
                amount=buy_amount,
                start_time=trade_start_time,
                end_time=trade_end_time,
                direction=Order.BUY,
            )
            buy_order_list.append(buy_order)

        return TradeDecisionWO(sell_order_list + buy_order_list, self)