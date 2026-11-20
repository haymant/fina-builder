# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""
TradeACExchange

A short/borrow enabled Exchange implementation built on top of qlib.backtest.exchange.Exchange.
This exchange adds simple, configurable margin logic (initial/maintenance), borrowing support for
shorts, a borrow fee, and a lightweight SMA (Special Memorandum Account) concept to emulate
behaviors similar to brokers such as IBKR and Alpaca for backtesting purposes.

Notes / limitations
- This implementation is intentionally lightweight and conservative: it implements the
  key behaviors needed for strategy/backtest experiments (allowing short selling, computing
  margin requirements, performing margin-call checks, and tracking SMA-like excess equity).
- It makes some simplifying assumptions compared to real brokers (no per-product house margins,
  simplified SMA bookkeeping, borrow availability modeled only by a per-symbol boolean/limit).
- The Position class in qlib.backtest.position was not changed. To support shorts we update the
  position.position dict directly when necessary. This keeps integration simple but bypasses some
  internal Position helpers. Use with care.

API additions
- allow_short: enable short selling (bool)
- initial_margin_long/short: fraction required to open a position
- maintenance_margin_long/short: fraction required to keep a position
- borrow_fee_rate: periodic borrow fee applied on short value (applied at trade time as additional cost)
- borrowable: dict mapping stock_id -> bool or float (max borrowable shares). Symbols missing from
  the dict follow `borrow_default` (default True = unlimited; set False for a strict whitelist)
- get_sma(position): returns SMA-like excess equity available as "buying power credit"
- check_margin_call(position): returns True if position is below maintenance requirement

"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np

from qlib.backtest.decision import Order
from qlib.backtest.exchange import Exchange
from qlib.backtest.position import BasePosition


class TradeACExchange(Exchange):
    """An exchange that supports short selling / borrowing and basic margin rules.

    The implementation aims to be compatible with the Exchange API used by Account and
    Position classes in qlib.backtest. It overrides only the minimum methods required to
    enable short/borrow behavior and margin calculations.
    """

    def __init__(
        self,
        *args: Any,
        allow_short: bool = True,
        initial_margin_long: float = 0.5,
        initial_margin_short: float = 0.5,
        maintenance_margin_long: float = 0.25,
        maintenance_margin_short: float = 0.3,
        borrow_fee_rate: float = 0.0,
        borrowable: Optional[Dict[str, float]] = None,
        borrow_default: bool = True,
        sma_enabled: bool = True,
        **kwargs: Any,
    ) -> None:
        """Create TradeACExchange.

        Parameters mirror Exchange with additional tradeac-specific options.
        """
        super().__init__(*args, **kwargs)
        self.allow_short = allow_short
        self.initial_margin_long = initial_margin_long
        self.initial_margin_short = initial_margin_short
        self.maintenance_margin_long = maintenance_margin_long
        self.maintenance_margin_short = maintenance_margin_short
        self.borrow_fee_rate = borrow_fee_rate
        # borrowable can be a dict with per-symbol max borrowable amount, or None (unlimited)
        self.borrowable = borrowable or {}
        # borrow_default: policy for symbols absent from `borrowable`.
        #   True  -> unlisted symbols are unlimited-borrowable (legacy behavior)
        #   False -> unlisted symbols are NOT borrowable; only listed ones can be shorted
        self.borrow_default = bool(borrow_default)
        # sma_enabled: whether to expose lightweight SMA calculation
        self.sma_enabled = sma_enabled

    # --------------------------- Helper calculations ---------------------------
    def _initial_margin_requirement(self, position: BasePosition) -> float:
        """Compute the initial margin requirement (money) for the given position.

        We treat longs and shorts separately and sum their required initial margins.
        """
        im_req = 0.0
        for sid in position.get_stock_list():
            amt = position.get_stock_amount(sid)
            price = position.get_stock_price(sid)
            val = amt * price
            if val > 0:
                im_req += abs(val) * self.initial_margin_long
            elif val < 0:
                im_req += abs(val) * self.initial_margin_short
        return im_req

    def _maintenance_margin_requirement(self, position: BasePosition) -> float:
        """Compute the maintenance margin requirement (money) for the given position."""
        mm_req = 0.0
        for sid in position.get_stock_list():
            amt = position.get_stock_amount(sid)
            price = position.get_stock_price(sid)
            val = amt * price
            if val > 0:
                mm_req += abs(val) * self.maintenance_margin_long
            elif val < 0:
                mm_req += abs(val) * self.maintenance_margin_short
        return mm_req

    def get_equity(self, position: BasePosition) -> float:
        """Return account equity (position value + cash)."""
        return position.calculate_value()

    def get_sma(self, position: BasePosition) -> float:
        """Return a simplified SMA: excess equity above initial margin requirement.

        Note: This is a synthetic/Simplified SMA used for strategy/backtest logic. Real-broker
        SMA accounting (e.g. credits/debits across days) can be more complex.
        """
        if not self.sma_enabled:
            return 0.0
        equity = self.get_equity(position)
        im_req = self._initial_margin_requirement(position)
        return max(0.0, equity - im_req)

    def check_margin_call(self, position: BasePosition) -> bool:
        """Return True when the account is under maintenance margin (margin call).

        Margin call condition here is simple: equity < maintenance requirement.
        """
        equity = self.get_equity(position)
        mm_req = self._maintenance_margin_requirement(position)
        return equity < mm_req

    def get_buying_power(self, position: BasePosition) -> float:
        """Estimate buying power for new long positions assuming opening margin requirement.

        Simplified: the maximum notional long value = equity / initial_margin_long.
        """
        equity = self.get_equity(position)
        if self.initial_margin_long <= 0:
            return 0.0
        return equity / self.initial_margin_long

    # --------------------------- Order / execution overrides ---------------------------
    def _borrow_headroom(self, stock_id: str, current_short: float) -> float:
        """Remaining borrowable shares for `stock_id` given an already-open short of `current_short` shares.

        borrowable values: bool (True=unlimited, False=not borrowable) or numeric max shares.
        Missing symbols follow `borrow_default` (True = unlimited when allow_short is enabled).
        """
        if not self.allow_short:
            return 0.0
        v = self.borrowable.get(stock_id, self.borrow_default)
        if isinstance(v, bool):
            return float("inf") if v else 0.0
        try:
            limit = float(v)
        except (TypeError, ValueError):
            return float("inf")
        return max(0.0, limit - max(current_short, 0.0))

    def _calc_trade_info_by_order(
        self,
        order: Order,
        position: Optional[BasePosition],
        dealt_order_amount: Dict[str, float],
    ) -> Tuple[float, float, float]:
        """Override to allow (optionally) short selling and to apply borrow fees.

        The original Exchange implementation forbids selling more than you own. Here we allow
        sell orders to create/expand short positions when allow_short is True. We still rely on
        most base logic (price discovery, impact, cost calculation) by calling super(), but we
        adjust the sell-side clipping behavior before delegating to the base implementation.
        """
        # When selling and shorts are allowed, temporarily relax the clipping logic in the base
        # implementation by monkey-patching current position check. Simpler: replicate minimal
        # parts of logic from Exchange._calc_trade_info_by_order with the key change.

        # Get basic trade price & volume info using Exchange helpers
        trade_price = float(self.get_deal_price(order.stock_id, order.start_time, order.end_time, direction=order.direction))
        total_trade_val = float(self.get_volume(order.stock_id, order.start_time, order.end_time) or 0.0) * trade_price

        order.factor = self.get_factor(order.stock_id, order.start_time, order.end_time)
        order.deal_amount = order.amount  # attempt full

        # volume clipping (same as base)
        self._clip_amount_by_volume(order, dealt_order_amount)

        # approximate adjusted cost ratio based on liquidity
        if not total_trade_val or np.isnan(total_trade_val) or total_trade_val <= 0:
            adj_cost_ratio = self.impact_cost
        else:
            trade_val_tmp = order.deal_amount * trade_price
            adj_cost_ratio = self.impact_cost * (trade_val_tmp / total_trade_val) ** 2

        # Differentiate buy / sell
        if order.direction == Order.SELL:
            cost_ratio = self.close_cost + adj_cost_ratio
            current_amount = (
                position.get_stock_amount(order.stock_id) if (position is not None and position.check_stock(order.stock_id)) else 0.0
            )
            long_held = max(current_amount, 0.0)
            short_open = max(-current_amount, 0.0)

            if position is not None:
                if not self.allow_short:
                    # clip by current holdings only
                    if not np.isclose(order.deal_amount, current_amount):
                        order.deal_amount = self.round_amount_by_trade_unit(
                            min(long_held, order.deal_amount), order.factor
                        )
                else:
                    # allow selling beyond holdings up to the remaining borrow limit;
                    # later when updating the position we create/expand a short if necessary.
                    max_sell = long_held + self._borrow_headroom(order.stock_id, short_open)
                    if order.deal_amount > max_sell and not np.isclose(order.deal_amount, max_sell):
                        order.deal_amount = self.round_amount_by_trade_unit(max_sell, order.factor)

        elif order.direction == Order.BUY:
            cost_ratio = self.open_cost + adj_cost_ratio
            if position is not None:
                cash = position.get_cash()
                trade_val = order.deal_amount * trade_price
                if cash < max(trade_val * cost_ratio, self.min_cost):
                    order.deal_amount = 0
                    self.logger.debug(f"Order clipped due to cost higher than cash: {order}")
                elif cash < trade_val + max(trade_val * cost_ratio, self.min_cost):
                    max_buy_amount = self._get_buy_amount_by_cash_limit(trade_price, cash, cost_ratio)
                    order.deal_amount = self.round_amount_by_trade_unit(min(max_buy_amount, order.deal_amount), order.factor)
                    self.logger.debug(f"Order clipped due to cash limitation: {order}")
                else:
                    order.deal_amount = self.round_amount_by_trade_unit(order.deal_amount, order.factor)
            else:
                order.deal_amount = self.round_amount_by_trade_unit(order.deal_amount, order.factor)
        else:
            raise NotImplementedError("order direction {} error".format(order.direction))

        # compute final trade_val & trade_cost
        trade_val = order.deal_amount * trade_price
        # base trade_cost
        trade_cost = max(trade_val * cost_ratio, self.min_cost)
        # apply borrow fee only on the net-new short portion of the sell
        if order.direction == Order.SELL and self.allow_short:
            new_short = max(0.0, order.deal_amount - long_held)
            trade_cost += new_short * trade_price * self.borrow_fee_rate

        if trade_val <= 1e-5:
            trade_cost = 0

        return trade_price, trade_val, trade_cost

    def deal_order(
        self,
        order: Order,
        trade_account: Optional[Any] = None,
        position: Optional[BasePosition] = None,
        dealt_order_amount: Dict[str, float] = None,
    ) -> Tuple[float, float, float]:
        """Deal order and handle short position bookkeeping.

        This method mirrors Exchange.deal_order but when a position is provided and shorts are
        allowed it will update the Position.position dict directly to support negative amounts.
        """
        if dealt_order_amount is None:
            dealt_order_amount = {}

        if not self.check_order(order):
            order.deal_amount = 0.0
            self.logger.debug(f"Order failed due to trading limitation: {order}")
            return 0.0, 0.0, np.nan

        if trade_account is not None and position is not None:
            raise ValueError("trade_account and position can only choose one")

        pos = position or (trade_account.current_position if trade_account is not None else None)
        trade_price, trade_val, trade_cost = self._calc_trade_info_by_order(order, pos, dealt_order_amount)

        if trade_val > 1e-5:
            if trade_account is not None:
                cp = trade_account.current_position
                if not cp.skip_update():
                    held = cp.check_stock(order.stock_id)
                    # Account-level bookkeeping (turnover/cost/returns). Mirrors
                    # Account._update_state_from_order except for fresh short sales,
                    # where no prior price exists to compute order profit from.
                    if order.direction == Order.SELL and not held:
                        trade_account.accum_info.add_turnover(trade_val)
                        trade_account.accum_info.add_cost(trade_cost)
                        trade_account.accum_info.add_return_value(0.0)
                    if order.direction == Order.SELL:
                        # sell: update account state first (stock entry may be deleted)
                        if held:
                            trade_account._update_state_from_order(order, trade_val, trade_cost, trade_price)
                        self._position_sell(cp, order, trade_val, trade_cost, trade_price)
                    else:
                        # buy: update position first (entry may be created), then account state
                        # A buy that covers a short to exactly flat deletes the entry inside
                        # _position_buy; re-seed a transient zero-amount stub so the
                        # account's order-profit lookup still finds the trade price,
                        # then drop it (_update_state_from_order never mutates entries).
                        sid = order.stock_id
                        had_entry = isinstance(cp.position.get(sid), dict)
                        self._position_buy(cp, order, trade_val, trade_cost, trade_price)
                        covered_to_flat = had_entry and not isinstance(cp.position.get(sid), dict)
                        if covered_to_flat:
                            cp.position[sid] = {"amount": 0.0, "price": trade_price, "weight": 0}
                        trade_account._update_state_from_order(order, trade_val, trade_cost, trade_price)
                        if covered_to_flat:
                            cp.position.pop(sid, None)
            elif position is not None:
                if order.direction == Order.BUY:
                    self._position_buy(position, order, trade_val, trade_cost, trade_price)
                else:
                    self._position_sell(position, order, trade_val, trade_cost, trade_price)
        return trade_val, trade_cost, trade_price

    # --------------------------- Position mutation helpers ---------------------------
    def _position_buy(self, position: BasePosition, order: Order, trade_val: float, cost: float, trade_price: float) -> None:
        """Handle buy order bookkeeping against a BasePosition while supporting shorts.

        Rules implemented (simplified):
        - If there is an existing short (amount < 0), the buy will first cover the short.
        - If covering closes the short completely, the remaining buy becomes a long
        - Cash updates mimic Position._buy_stock/_sell_stock (cash decreases by trade_val+cost for buys)
        """
        trade_amount = trade_val / trade_price
        sid = order.stock_id
        current_amount = position.get_stock_amount(sid) if position.check_stock(sid) else 0.0

        # covering existing short
        if current_amount < -1e-12:
            # amount is negative -> we are short. Buying reduces the short.
            new_amount = current_amount + trade_amount
            if abs(new_amount) <= 1e-8:
                # short fully covered exactly -> remove entry
                if sid in position.position:
                    del position.position[sid]
            elif new_amount > 0:
                # short fully covered with leftover buy amount -> leftover becomes a long position
                position.position[sid] = {"amount": new_amount, "price": trade_price, "weight": 0}
            else:
                # partially cover
                position.position[sid]["amount"] = new_amount
                position.position[sid]["price"] = trade_price
        else:
            # normal or increasing long
            if sid not in position.position or not isinstance(position.position[sid], dict):
                # initialize stock
                position.position[sid] = {"amount": trade_amount, "price": trade_price, "weight": 0}
            else:
                position.position[sid]["amount"] = position.position[sid].get("amount", 0.0) + trade_amount
                position.position[sid]["price"] = trade_price

        # cash effect same as Position._buy_stock
        position.position["cash"] -= trade_val + cost

    def _position_sell(self, position: BasePosition, order: Order, trade_val: float, cost: float, trade_price: float) -> None:
        """Handle sell order bookkeeping against a BasePosition while supporting shorts.

        Rules implemented (simplified):
        - If holding enough long shares, sell will reduce/close the long position normally.
        - If not holding enough long shares and shorts are allowed, the remaining sold amount will create/expand a short position.
        - Cash update for sells follows Position._sell_stock logic (cash increases by trade_val - cost)
        """
        trade_amount = trade_val / trade_price
        sid = order.stock_id
        current_amount = position.get_stock_amount(sid) if position.check_stock(sid) else 0.0

        if current_amount > 1e-12:
            # we have long shares; sell from them first
            if trade_amount >= current_amount - 1e-8:
                # selling all or more than holdings
                # remove long position
                if sid in position.position:
                    del position.position[sid]
                # remaining sold amount becomes short if allowed
                remain = trade_amount - current_amount
                if remain > 1e-8:
                    if not self.allow_short:
                        # should not happen due to clipping earlier, but guard anyway
                        raise ValueError(f"Attempt to short {sid} while shorting disabled")
                    # create short entry
                    position.position[sid] = {"amount": -remain, "price": trade_price, "weight": 0}
            else:
                # partial sell
                position.position[sid]["amount"] = current_amount - trade_amount
                position.position[sid]["price"] = trade_price
        else:
            # currently flat or already short
            if not self.allow_short:
                raise ValueError(f"Attempt to short {sid} while shorting disabled")
            # expand short
            new_amount = current_amount - trade_amount
            if sid not in position.position or not isinstance(position.position[sid], dict):
                position.position[sid] = {"amount": new_amount, "price": trade_price, "weight": 0}
            else:
                position.position[sid]["amount"] = new_amount
                position.position[sid]["price"] = trade_price

        # cash effect same as Position._sell_stock
        new_cash = trade_val - cost
        if getattr(position, "_settle_type", None) == position.ST_CASH:
            position.position["cash_delay"] = position.position.get("cash_delay", 0.0) + new_cash
        else:
            position.position["cash"] = position.position.get("cash", 0.0) + new_cash

    # --------------------------- Borrow availability helpers ---------------------------
    def is_borrowable(self, stock_id: str, amount: float) -> bool:
        """Check whether the requested amount is borrowable for the given stock.

        If a borrowable dict is provided, it may contain either booleans or numeric limits (maximum borrowable shares).
        Symbols absent from the dict follow `borrow_default`.
        """
        if not self.allow_short:
            return False
        if stock_id not in self.borrowable:
            return self.borrow_default
        v = self.borrowable[stock_id]
        if isinstance(v, bool):
            return v
        try:
            limit = float(v)
            return amount <= limit
        except Exception:
            return True
