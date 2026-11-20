"""Fractional-Kelly dropout strategy for cross-sectional signals.

Sizing rule variant of ``qlib.contrib.strategy.signal_strategy.TopkDropoutStrategy``:
the topk/n_drop SELECTION is identical to the reference, but the buy size is
proportional to the score MAGNITUDE (edge) instead of equal-weight, capped at a
fraction ``cap_frac`` of the equal-weight notional so a single name cannot
over-concentrate the book.

``cap_frac`` is the fraction of the equal-weight per-name notional that a top
signal can deploy at most (e.g. 0.5 = at most half the equal-weight size).
Names whose score is below the median of the buy set get a proportionally
smaller slice; the residual stays in cash (that is the point of the rule:
throw away less edge per name, deploy less capital when conviction is low).
"""

from __future__ import annotations

from typing import List

import numpy as np
import pandas as pd

from qlib.backtest import Order
from qlib.backtest.decision import OrderDir, TradeDecisionWO
from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

__all__ = ["FractionalKellyDropoutStrategy"]

DEFAULT_CAP_FRAC = 0.5


class FractionalKellyDropoutStrategy(TopkDropoutStrategy):
    """TopkDropout selection with score-magnitude (fractional-Kelly) sizing.

    Parameters
    ----------
    topk, n_drop, method_sell, method_buy, hold_thresh, only_tradable,
    forbid_all_trade_at_limit : same as ``TopkDropoutStrategy``.
    cap_frac : max buy notional as a fraction of the equal-weight notional.
    """

    def __init__(self, *, topk, n_drop, cap_frac: float = DEFAULT_CAP_FRAC, **kwargs):
        super().__init__(topk=topk, n_drop=n_drop, **kwargs)
        self.cap_frac = cap_frac

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

        if len(buy) == 0:
            return TradeDecisionWO(sell_order_list, self)

        # ---- fractional-Kelly sizing --------------------------------------
        # equal-weight notional (reference baseline)
        eq_notional = cash * self.risk_degree / len(buy)
        buy_scores = pred_score.reindex(buy).astype(float)
        lo, hi = buy_scores.min(), buy_scores.max()
        if hi == lo:
            w = pd.Series(1.0, index=buy_scores.index)
        else:
            w = (buy_scores - lo) / (hi - lo)  # [0,1] edge magnitude
            w = w.clip(lower=0.0)
            w_max = w.max()
            w = w / w_max if w_max > 0 else w  # max == 1.0
        for code in buy:
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
            notional = eq_notional * min(self.cap_frac, float(w.get(code, 0.0)))
            buy_amount = notional / buy_price
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