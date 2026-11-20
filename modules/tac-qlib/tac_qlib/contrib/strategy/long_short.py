"""Long-short Top-K strategy for cross-sectional signals.

Each day the strategy ranks the cross-section by prediction score and rebalances
to an equal-weight two-sided book: the ``topk`` highest-ranked names go long and
the ``k_short`` lowest-ranked names go short. Net-new shorts are opened by
selling beyond current holdings, which requires a short-aware exchange such as
``tac_qlib.contrib.backtest.tradeac_exchange.TradeACExchange`` with
``allow_short=True`` (borrow limits, margin requirements and borrow fees are
enforced there, not here).

Sizing deploys ``equity * risk_degree`` as gross notional split evenly across
all long and short legs, so the book is approximately market neutral.
``allow_short=False`` disables the short side entirely (long-only ``topk``).

Short eligibility can be restricted further, with static or dynamic gates:
``short_whitelist`` limits shorts to an explicit symbol set; ``short_vol_top_pct``
requires a candidate's trailing realized volatility to rank in the top fraction
of that day's cross-section; ``short_max_mom`` (falling-knife filter) only
allows shorting names whose own trailing momentum is at/below a threshold;
``short_regime_sma`` disables shorts entirely while the benchmark trades above
its moving average (risk-on). Borrow availability itself is enforced by the
exchange (``borrowable`` whitelist / per-symbol caps via ``TradeACExchange``).

Wired into qrun workflows like any ``BaseStrategy`` (see ``PortAnaRecord``
config). Mirrors the API usage of qlib's ``TopkDropoutStrategy``: ``Order`` /
``OrderDir`` from ``qlib.backtest.decision``, ``trade_calendar`` /
``trade_exchange`` / ``trade_position`` injected by the backtest executor.
"""

from __future__ import annotations

import copy
from typing import Dict, List, Optional

import pandas as pd

from qlib.backtest import Order
from qlib.backtest.decision import OrderDir, TradeDecisionWO
from qlib.contrib.strategy.signal_strategy import BaseSignalStrategy
from qlib.log import get_module_logger

__all__ = ["LongShortTopkStrategy"]


class LongShortTopkStrategy(BaseSignalStrategy):
    """Equal-weight long-short Top-K strategy over a cross-sectional signal.

    Parameters
    ----------
    topk : number of long legs (highest-ranked names).
    k_short : number of short legs (lowest-ranked names).
    hold_thresh : minimum holding days before a leg may be closed/reduced.
    only_tradable : only select candidates tradable on the trade date.
    rebalance_tol : skip rebalances smaller than this fraction of a leg's
        target notional (turnover control).
    allow_short : enable/disable the short side. With ``False`` the bottom-ranked
        legs are dropped and the book is long-only ``topk``; pair with
        ``allow_short=False`` on the exchange for a fully borrow-free run.
        Legacy alias ``enable_short`` is accepted.
    short_whitelist : optional list of symbols eligible for shorting; candidates
        outside the list are skipped (``None`` = all names eligible).
    short_vol_window : trailing window (trading days) for realized-vol estimation.
    short_vol_top_pct : if set, a short candidate's trailing realized volatility
        must rank at or above this percentile of that day's cross-section
        (e.g. ``0.5`` = only the more volatile half may be shorted). Candidates
        without measurable vol are never shorted.
    short_mom_window : trailing window (trading days) for the candidate momentum
        used by the falling-knife gate.
    short_max_mom : if set, a candidate's trailing ``short_mom_window``-day return
        must be <= this value to be shortable (e.g. ``0.0`` = only short names
        that are actually falling). Candidates without measurable momentum are
        never shorted.
    short_regime_symbol : benchmark symbol for the regime gate (default SPY).
    short_regime_sma : if set, shorts are only allowed on days where the regime
        symbol's last close (strictly before the execution bar) is BELOW its
        ``short_regime_sma``-day moving average — i.e. shorts are disabled in
        risk-on regimes and enabled in drawdowns.
    """

    def __init__(
        self,
        *,
        signal=None,
        topk: int = 4,
        k_short: int = 2,
        hold_thresh: int = 1,
        only_tradable: bool = True,
        rebalance_tol: float = 0.05,
        allow_short: Optional[bool] = None,
        enable_short: Optional[bool] = None,
        short_whitelist: Optional[List[str]] = None,
        short_vol_window: int = 20,
        short_vol_top_pct: Optional[float] = None,
        short_mom_window: int = 20,
        short_max_mom: Optional[float] = None,
        short_regime_symbol: str = "SPY",
        short_regime_sma: Optional[int] = None,
        risk_degree: float = 0.95,
        trade_exchange=None,
        level_infra=None,
        common_infra=None,
        **kwargs,
    ):
        super().__init__(
            signal=signal,
            risk_degree=risk_degree,
            trade_exchange=trade_exchange,
            level_infra=level_infra,
            common_infra=common_infra,
            **kwargs,
        )
        if allow_short is None:
            allow_short = True if enable_short is None else bool(enable_short)
        self.allow_short = bool(allow_short)
        self.topk = topk
        self.k_short = k_short
        self.hold_thresh = hold_thresh
        self.only_tradable = only_tradable
        self.rebalance_tol = rebalance_tol
        self.short_whitelist = set(short_whitelist) if short_whitelist is not None else None
        if not 0 < float(short_vol_window) <= 1000:
            raise ValueError(f"short_vol_window must be in (0, 1000], got {short_vol_window}")
        self.short_vol_window = int(short_vol_window)
        if short_vol_top_pct is not None and not 0.0 < float(short_vol_top_pct) <= 1.0:
            raise ValueError(f"short_vol_top_pct must be in (0, 1], got {short_vol_top_pct}")
        self.short_vol_top_pct = None if short_vol_top_pct is None else float(short_vol_top_pct)
        if not 0 < float(short_mom_window) <= 1000:
            raise ValueError(f"short_mom_window must be in (0, 1000], got {short_mom_window}")
        self.short_mom_window = int(short_mom_window)
        self.short_max_mom = None if short_max_mom is None else float(short_max_mom)
        self.short_regime_symbol = str(short_regime_symbol)
        if short_regime_sma is not None and not 1 < int(short_regime_sma) <= 1000:
            raise ValueError(f"short_regime_sma must be in (1, 1000], got {short_regime_sma}")
        self.short_regime_sma = None if short_regime_sma is None else int(short_regime_sma)
        # per-day caches (keyed by trade date)
        self._vol_cache_key: Optional[str] = None
        self._vol_cache_val: Dict[str, Dict[str, float]] = {}
        self._regime_cache: Dict[str, bool] = {}

    # ------------------------------------------------------------------ utils
    def _is_tradable(self, code, start, end) -> bool:
        if not self.only_tradable:
            return True
        try:
            return self.trade_exchange.is_stock_tradable(stock_id=code, start_time=start, end_time=end)
        except TypeError:
            return True

    def _mark_price(self, code, start, end) -> Optional[float]:
        try:
            px = self.trade_exchange.get_deal_price(
                stock_id=code, start_time=start, end_time=end, direction=OrderDir.BUY
            )
        except (KeyError, ValueError):
            return None
        if px is None or px != px or px <= 0:
            return None
        return float(px)

    def _day_stats(self, codes: List[str], trade_start) -> Dict[str, Dict[str, float]]:
        """Per-day cross-sectional stats used by the dynamic short gates.

        For each code, returns ``{"vol_rank": r}`` (percentile of trailing
        realized vol over ``short_vol_window`` bars across that day's
        cross-section) when the vol gate is on, and ``{"mom": m}`` (trailing
        ``short_mom_window``-bar return) when the falling-knife gate is on.
        All series end on the last bar strictly BEFORE the execution bar (no
        lookahead). Codes without measurable data are simply absent — such
        candidates are never shorted (fail-closed).
        """
        if self.short_vol_top_pct is None and self.short_max_mom is None:
            return {}
        key = str(pd.Timestamp(trade_start))
        if self._vol_cache_key == key:
            return self._vol_cache_val
        out: Dict[str, Dict[str, float]] = {}
        try:
            from qlib.data import D

            end = pd.Timestamp(trade_start)
            buf = max(self.short_vol_window, self.short_mom_window) * 3 + 30
            df = D.features(
                sorted(codes),
                ["$close"],
                start_time=end - pd.Timedelta(days=buf),
                end_time=end - pd.Timedelta(days=1),
            )
            close = df["$close"].unstack(level="instrument") if isinstance(df.index, pd.MultiIndex) else df["$close"]
            if self.short_vol_top_pct is not None:
                vol = close.pct_change().rolling(self.short_vol_window).std().iloc[-1]
                for code, rank in vol.rank(pct=True).dropna().items():
                    out.setdefault(str(code), {})["vol_rank"] = float(rank)
            if self.short_max_mom is not None:
                w = min(self.short_mom_window, len(close) - 1)
                mom = close.iloc[-1] / close.iloc[-(w + 1)] - 1
                for code, m in mom.items():
                    if m == m:
                        out.setdefault(str(code), {})["mom"] = float(m)
        except Exception as e:  # noqa: BLE001 - degrade to fail-closed (no shorts)
            get_module_logger(self.__class__.__name__).warning(
                f"short gates unavailable ({type(e).__name__}: {e}); no shorts this step"
            )
        self._vol_cache_key, self._vol_cache_val = key, out
        return out

    def _regime_ok(self, trade_start) -> bool:
        """True when shorting is allowed by the benchmark-regime gate.

        With ``short_regime_sma`` set, shorts are permitted only while the
        regime symbol's last close strictly before the execution bar sits below
        its moving average (risk-off). Data failure fails closed (no shorts).
        """
        if self.short_regime_sma is None:
            return True
        key = str(pd.Timestamp(trade_start))
        cached = self._regime_cache.get(key)
        if cached is not None:
            return cached
        ok = False
        try:
            from qlib.data import D

            end = pd.Timestamp(trade_start)
            df = D.features(
                [self.short_regime_symbol],
                ["$close"],
                start_time=end - pd.Timedelta(days=int(self.short_regime_sma * 3 + 30)),
                end_time=end - pd.Timedelta(days=1),
            )
            s = df["$close"]
            if isinstance(s.index, pd.MultiIndex):
                s = s.droplevel("instrument")
            sma = s.rolling(self.short_regime_sma).mean().iloc[-1]
            px = s.iloc[-1]
            ok = bool(px < sma)
        except Exception as e:  # noqa: BLE001 - degrade to fail-closed (no shorts)
            get_module_logger(self.__class__.__name__).warning(
                f"regime gate unavailable ({type(e).__name__}: {e}); no shorts this step"
            )
        self._regime_cache[key] = ok
        return ok

    # ------------------------------------------------------------- decision
    def generate_trade_decision(self, execute_result=None):
        trade_step = self.trade_calendar.get_trade_step()
        trade_start, trade_end = self.trade_calendar.get_step_time(trade_step)
        pred_start, pred_end = self.trade_calendar.get_step_time(trade_step, shift=1)
        pred_score = self.signal.get_signal(start_time=pred_start, end_time=pred_end)
        if isinstance(pred_score, pd.DataFrame):
            pred_score = pred_score.iloc[:, 0]
        if pred_score is None or len(pred_score) == 0:
            return TradeDecisionWO([], self)
        pred_score = pred_score.dropna()
        if pred_score.empty:
            return TradeDecisionWO([], self)

        time_per_step = self.trade_calendar.get_freq()
        current_temp = copy.deepcopy(self.trade_position)

        # ---- signed current holdings ---------------------------------------
        cur_amount: Dict[str, float] = {}
        for code in current_temp.get_stock_list():
            amt = float(current_temp.get_stock_amount(code))
            if abs(amt) > 1e-6:
                cur_amount[code] = amt

        # ---- targets: top-k long, bottom-k_short short ----------------------
        ranked = list(pred_score.sort_values(ascending=False).index)
        longs: List[str] = []
        for code in ranked:
            if len(longs) >= self.topk:
                break
            if self._is_tradable(code, trade_start, trade_end):
                longs.append(code)
        shorts: List[str] = []
        if self.allow_short and self._regime_ok(trade_start):
            stats = self._day_stats(list(ranked), trade_start)
            for code in reversed(ranked):
                if len(shorts) >= self.k_short:
                    break
                if code in longs:
                    continue
                if not self._is_tradable(code, trade_start, trade_end):
                    continue
                if self.short_whitelist is not None and code not in self.short_whitelist:
                    continue
                st = stats.get(code)
                if self.short_vol_top_pct is not None:
                    rank = None if st is None else st.get("vol_rank")
                    if rank is None or rank < self.short_vol_top_pct:
                        continue
                if self.short_max_mom is not None:
                    mom = None if st is None else st.get("mom")
                    if mom is None or mom > self.short_max_mom:
                        continue
                shorts.append(code)

        # ---- marks & equity --------------------------------------------------
        marks: Dict[str, float] = {}
        for code in set(cur_amount) | set(longs) | set(shorts):
            px = self._mark_price(code, trade_start, trade_end)
            if px is not None:
                marks[code] = px

        equity = current_temp.get_cash()
        for code, amt in cur_amount.items():
            if code in marks:
                equity += amt * marks[code]
        if equity <= 0:
            return TradeDecisionWO([], self)

        n_legs = len([c for c in longs if c in marks]) + len([c for c in shorts if c in marks])
        if n_legs == 0:
            return TradeDecisionWO([], self)
        per_leg = equity * self.risk_degree / n_legs

        target_signed: Dict[str, float] = {}
        for code in longs:
            if code in marks:
                target_signed[code] = per_leg / marks[code]
        for code in shorts:
            if code in marks:
                target_signed[code] = -(per_leg / marks[code])

        # ---- order generation -------------------------------------------------
        sell_orders: List[Order] = []
        buy_orders: List[Order] = []

        def submit(code: str, amount: float, direction: int) -> None:
            factor = self.trade_exchange.get_factor(stock_id=code, start_time=trade_start, end_time=trade_end)
            amount = self.trade_exchange.round_amount_by_trade_unit(amount, factor)
            if amount <= 1e-6:
                return
            o = Order(stock_id=code, amount=amount, start_time=trade_start, end_time=trade_end, direction=direction)
            if self.trade_exchange.check_order(o):
                (buy_orders if direction == Order.BUY else sell_orders).append(o)

        # close holdings that are no longer targeted (frees cash / unwinds shorts)
        for code, amt in cur_amount.items():
            if code in target_signed:
                continue
            if marks.get(code) is None:
                continue
            if current_temp.get_stock_count(code, bar=time_per_step) < self.hold_thresh:
                continue
            submit(code, abs(amt), Order.SELL if amt > 0 else Order.BUY)

        # rebalance targeted legs toward their signed target quantity
        for code, tgt in target_signed.items():
            cur = cur_amount.get(code, 0.0)
            delta = tgt - cur
            if abs(delta * marks[code]) < max(self.rebalance_tol * per_leg, 1.0):
                continue
            if delta > 0:
                submit(code, delta, Order.BUY)
            else:
                if cur > 0 and current_temp.get_stock_count(code, bar=time_per_step) < self.hold_thresh:
                    continue
                submit(code, -delta, Order.SELL)

        return TradeDecisionWO(sell_orders + buy_orders, self)
