"""Optimal-stopping / stochastic-control strategy for cross-sectional signals.

Entry is a control policy: a symbol opens a position only when its cross-sectional
signal percentile is at or above ``entry_pct`` (i.e. it is one of the top-ranked
names) and the portfolio has fewer than ``topk`` open positions.

Exit is an optimal-stopping rule: a held position is stopped (closed) when its
signal percentile falls below ``exit_pct`` (the continuation value of holding is
no longer worth the risk), OR after ``max_hold_days`` (time stop / finite
horizon), OR when the position P&L breaches ``sl`` (loss control) and the
position has been held at least ``min_hold_days``.

Sizing is fixed ``notional`` per position (equal-weight control), unlike the
TopkDropout cash-allocation heuristic.

Wired into qrun workflows like any ``BaseStrategy`` (see ``PortAnaRecord``
config). Mirrors the API usage of qlib's ``TopkDropoutStrategy``: ``Order``/
``OrderDir`` from ``qlib.backtest.decision``, ``trade_calendar`` /
``trade_exchange`` / ``trade_position`` injected by the backtest executor.
"""

from __future__ import annotations

from typing import List

import pandas as pd

from qlib.backtest import Order
from qlib.backtest.decision import OrderDir, TradeDecisionWO
from qlib.contrib.strategy.signal_strategy import BaseSignalStrategy

__all__ = ["OptimalStopControl"]

DEFAULT_NOTIONAL = 20_000.0
DEFAULT_ENTRY_PCT = 0.80
DEFAULT_EXIT_PCT = 0.50
DEFAULT_MAX_HOLD_DAYS = 10
DEFAULT_MIN_HOLD_DAYS = 2
DEFAULT_SL = -0.06


class OptimalStopControl(BaseSignalStrategy):
    """Optimal-stopping long-only strategy over a cross-sectional signal.

    Parameters
    ----------
    topk : max number of concurrent positions.
    entry_pct : min cross-sectional score percentile required to OPEN (0..1).
    exit_pct : held positions are stopped when score percentile < exit_pct.
    max_hold_days : hard time stop (finite-horizon close).
    min_hold_days : minimum holding days before stop-loss is evaluated.
    notional : $ per position (equal-weight control).
    sl : stop-loss threshold as fraction of entry price (<= 0), disabled if 0.
    """

    def __init__(
        self,
        *,
        signal=None,
        topk: int = 10,
        entry_pct: float = DEFAULT_ENTRY_PCT,
        exit_pct: float = DEFAULT_EXIT_PCT,
        max_hold_days: int = DEFAULT_MAX_HOLD_DAYS,
        min_hold_days: int = DEFAULT_MIN_HOLD_DAYS,
        notional: float = DEFAULT_NOTIONAL,
        sl: float = DEFAULT_SL,
        risk_degree: float = 0.95,
        trade_exchange=None,
        level_infra=None,
        common_infra=None,
        **kwargs,
    ):
        super().__init__(
            signal=signal,
            trade_exchange=trade_exchange,
            level_infra=level_infra,
            common_infra=common_infra,
            **kwargs,
        )
        self.topk = topk
        self.entry_pct = entry_pct
        self.exit_pct = exit_pct
        self.max_hold_days = max_hold_days
        self.min_hold_days = min_hold_days
        self.notional = notional
        self.sl = sl

    # ------------------------------------------------------------------ utils
    @staticmethod
    def _pct_rank(score: pd.Series) -> pd.Series:
        return score.rank(pct=True)

    def _entry_price(self, pos) -> float:
        # Position stores avg entry price under key "price" (see Position.position)
        price = pos.position.get("price")
        if price is None:
            price = pos.get_stock_amount("price")
        return float(price)

    def _pnl_pct(self, pos, mark: float) -> float:
        entry = self._entry_price(pos)
        if not entry or entry != entry:
            return 0.0
        return mark / entry - 1.0

    def _is_tradable(self, code, start, end, direction) -> bool:
        try:
            return self.trade_exchange.is_stock_tradable(
                stock_id=code, start_time=start, end_time=end, direction=direction
            )
        except TypeError:  # some exchanges take no direction kwarg
            return self.trade_exchange.is_stock_tradable(stock_id=code, start_time=start, end_time=end)

    # ------------------------------------------------------------ decision
    def generate_trade_decision(self, execute_result=None):
        trade_step = self.trade_calendar.get_trade_step()
        trade_start, trade_end = self.trade_calendar.get_step_time(trade_step)
        pred_start, pred_end = self.trade_calendar.get_step_time(trade_step, shift=1)
        pred_score = self.signal.get_signal(start_time=pred_start, end_time=pred_end)
        if isinstance(pred_score, pd.DataFrame):
            pred_score = pred_score.iloc[:, 0]
        if pred_score is None or len(pred_score) == 0:
            return TradeDecisionWO([], self)

        pct = self._pct_rank(pred_score)
        time_per_step = self.trade_calendar.get_freq()
        current_temp = __import__("copy").deepcopy(self.trade_position)

        holdings = {}
        for code in current_temp.get_stock_list():
            if abs(current_temp.get_stock_amount(code)) > 1e-6:
                holdings[code] = current_temp

        # ---- optimal stopping: close held positions -----------------------
        sell_orders: List[Order] = []
        closed_today = set()
        kept = {}
        for code, pos in holdings.items():
            held = current_temp.get_stock_count(code, bar=time_per_step)
            mark = self.trade_exchange.get_deal_price(
                stock_id=code, start_time=trade_start, end_time=trade_end, direction=Order.SELL
            )
            if mark is None or mark != mark:
                continue
            rank = pct.get(code, 0.0)
            stop_pnl = held >= self.min_hold_days and self.sl < 0 and self._pnl_pct(pos, mark) <= self.sl
            if held >= self.max_hold_days or rank < self.exit_pct or stop_pnl:
                amt = abs(current_temp.get_stock_amount(code))
                o = Order(stock_id=code, amount=amt, start_time=trade_start,
                          end_time=trade_end, direction=Order.SELL)
                if self.trade_exchange.check_order(o):
                    sell_orders.append(o)
                    self.trade_exchange.deal_order(o, position=current_temp)
                closed_today.add(code)
            else:
                kept[code] = mark

        # ---- equal-weight control: target notional per name -----------------
        # candidate opens: top-ranked names whose signal pct >= entry_pct
        rank_desc = pred_score.sort_values(ascending=False)
        held_codes = set(kept)
        opens = []
        for sym in rank_desc.index:
            if len(opens) >= self.topk:
                break
            if sym in held_codes:
                continue
            if pct.get(sym, 0.0) < self.entry_pct:
                continue
            if not self._is_tradable(sym, trade_start, trade_end, OrderDir.BUY):
                continue
            opens.append(sym)

        targets = held_codes | set(opens)
        if not targets:
            return TradeDecisionWO(sell_orders, self)

        # total value (cash + marked positions) -> per-target notional
        total_value = current_temp.get_cash()
        for code, mark in kept.items():
            total_value += abs(current_temp.get_stock_amount(code)) * mark

        target_notional = total_value * self.risk_degree / max(1, len(targets))

        # ---- rebalance kept positions toward target weight ------------------
        buy_orders: List[Order] = []
        for code, mark in kept.items():
            cur = abs(current_temp.get_stock_amount(code)) * mark
            diff_notional = target_notional - cur
            if abs(diff_notional) / target_notional < 0.02:
                continue  # skip tiny rebalances
            amount_delta = diff_notional / mark
            direction = Order.BUY if amount_delta > 0 else Order.SELL
            o = Order(stock_id=code, amount=abs(amount_delta), start_time=trade_start,
                      end_time=trade_end, direction=direction)
            if self.trade_exchange.check_order(o):
                (buy_orders if direction == Order.BUY else sell_orders).append(o)
                self.trade_exchange.deal_order(o, position=current_temp)

        # ---- open new positions at target weight ----------------------------
        for sym in opens:
            px = self.trade_exchange.get_deal_price(
                stock_id=sym, start_time=trade_start, end_time=trade_end, direction=OrderDir.BUY
            )
            if px is None or px != px or px <= 0:
                continue
            amount = target_notional / px
            factor = self.trade_exchange.get_factor(
                stock_id=sym, start_time=trade_start, end_time=trade_end
            )
            amount = self.trade_exchange.round_amount_by_trade_unit(amount, factor)
            o = Order(stock_id=sym, amount=amount, start_time=trade_start,
                      end_time=trade_end, direction=Order.BUY)
            if self.trade_exchange.check_order(o):
                buy_orders.append(o)

        return TradeDecisionWO(sell_orders + buy_orders, self)
