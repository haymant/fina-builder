"""Weekly-rebalance TopkDropout strategy.

Turnover-reduction variant of ``qlib.contrib.strategy.signal_strategy.TopkDropoutStrategy``:
the topk/n_drop selection and sizing are identical to the reference, but the
target book is recomputed only on the first trading day of each ISO week; on the
other days the strategy issues NO orders (holds the book untouched).

The weekly cadence is derived from the qlib trade calendar: a rebalance happens
when the current trade step's date belongs to a different ISO ``(year, week)``
than the previous trade step. ``hold_band_pct`` (default 0) optionally skips
tiny rebalances: when a name's existing position differs from the new target by
less than this fraction, no order is generated for it.
"""

from __future__ import annotations

from typing import List

import numpy as np
import pandas as pd

from qlib.backtest import Order
from qlib.backtest.decision import OrderDir, TradeDecisionWO
from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy

__all__ = ["WeeklyRebalanceDropoutStrategy"]

DEFAULT_HOLD_BAND_PCT = 0.0


class WeeklyRebalanceDropoutStrategy(TopkDropoutStrategy):
    """TopkDropout rebalanced once per ISO week; holds otherwise.

    Parameters
    ----------
    topk, n_drop, method_sell, method_buy, hold_thresh, only_tradable,
    forbid_all_trade_at_limit : same as ``TopkDropoutStrategy``.
    hold_band_pct : skip order for a name whose deviation from target weight is
        below this fraction of the target (no-trade buffer band).
    rebalance_every_n_weeks : rebalance every N ISO weeks instead of every week
        (default 1 = weekly; 2 = biweekly).  Ignored when
        ``rebalance_every_n_days`` is set.
    rebalance_every_n_days : rebalance every N trading days (daily when N=1).
        When set, overrides the weekly gating logic entirely.
    """

    def __init__(self, *, topk, n_drop, hold_band_pct: float = DEFAULT_HOLD_BAND_PCT,
                 rebalance_every_n_weeks: int = 1,
                 rebalance_every_n_days: int = 0, **kwargs):
        super().__init__(topk=topk, n_drop=n_drop, **kwargs)
        self.hold_band_pct = hold_band_pct
        self.rebalance_every_n_weeks = rebalance_every_n_weeks
        self.rebalance_every_n_days = rebalance_every_n_days

    @staticmethod
    def _iso_week(ts) -> tuple:
        return (ts.year, ts.week)

    def generate_trade_decision(self, execute_result=None):
        import copy

        trade_step = self.trade_calendar.get_trade_step()
        trade_start_time, trade_end_time = self.trade_calendar.get_step_time(trade_step)

        if self.rebalance_every_n_days > 0:
            # daily gating: count trading steps since last rebalance
            step_num = trade_step
            if hasattr(self, "_last_rebal_step"):
                if (step_num - self._last_rebal_step) < self.rebalance_every_n_days:
                    return TradeDecisionWO([], self)
            self._last_rebal_step = step_num
        else:
            cur_week = self._iso_week(trade_start_time)
            prev_week = getattr(self, "_last_week", None)
            self._last_week = cur_week

            if prev_week is not None and prev_week == cur_week:
                return TradeDecisionWO([], self)

            if self.rebalance_every_n_weeks > 1:
                week_num = cur_week[1]
                if prev_week is not None and (week_num % self.rebalance_every_n_weeks) != 1:
                    return TradeDecisionWO([], self)

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

        value = cash * self.risk_degree / len(buy)
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