"""Risk-limit spec shared by backtest and live executor.

One JSON spec is consulted by BOTH ``rd_backtest`` (as a strategy filter
overlay) and ``rd_strategy_targets`` (as pre-gate + sizing caps), so a limit
that holds in backtest holds in live — the round's ``strategy_snapshot``
stores the exact spec used.

Supported keys (all optional, all pct are 0-100):
    liquidity_floor_adv  : min avg daily dollar volume (USD) per symbol.
                           Names below it are filtered out of the tradable set.
    size_cap_pct         : max notional per name as % of account equity.
    concentration_cap_pct: max total deployed as % of account equity.
    drawdown_pause_pct   : if equity drawdown from peak exceeds this, new buys
                           are paused (executor gate; not expressible in a
                           one-shot qlib backtest and therefore documented).
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd


def parse_limits(spec: Optional[str]) -> Dict[str, float]:
    """Parse a risk_limits JSON string into a flat float map (empty = no limits)."""
    if not spec or not str(spec).strip():
        return {}
    if isinstance(spec, dict):
        raw = spec
    else:
        raw = json.loads(str(spec))
    out: Dict[str, float] = {}
    for k in ("liquidity_floor_adv", "size_cap_pct", "concentration_cap_pct", "drawdown_pause_pct"):
        v = raw.get(k)
        if v is not None and str(v) != "":
            out[k] = float(v)
    return out


def dollar_adv(
    symbols: List[str],
    lake_root: str = "",
    market: str = "US",
    asof: Optional[str] = None,
    lookback: int = 20,
) -> Dict[str, float]:
    """Average daily dollar volume per symbol over the ``lookback`` sessions
    ending at ``asof`` (inclusive), read straight from lake 1d bars. Symbols
    with no lake data map to 0.0 (treated as illiquid)."""
    from tac_qlib.data.config import LakeConfig, resolve_lake_root

    cfg = LakeConfig(resolve_lake_root(lake_root or None), market)
    asof_ts = pd.Timestamp(asof) if asof else pd.Timestamp.utcnow()
    out: Dict[str, float] = {}
    for sym in sorted({str(s).upper() for s in symbols}):
        p = cfg.bar_path("1d", sym)
        if not p.exists():
            out[sym] = 0.0
            continue
        try:
            df = pd.read_parquet(p)
        except Exception:
            out[sym] = 0.0
            continue
        if not len(df):
            out[sym] = 0.0
            continue
        tcol = df["t"] if "t" in df.columns else df["date"]
        ts = pd.to_datetime(tcol)
        df = df.assign(_t=ts).sort_values("_t")
        df = df[df["_t"] <= asof_ts]
        if not len(df):
            out[sym] = 0.0
            continue
        df = df.tail(lookback)
        px = df["vw"] if "vw" in df.columns else df["c"]
        out[sym] = float((df["v"] * px).mean()) if len(df) else 0.0
    return out


def apply_to_ranking(
    ranking: pd.Series,
    adv: Dict[str, float],
    limits: Dict[str, float],
    account: float,
    risk_degree: float,
    topk: int,
) -> Tuple[pd.Series, Dict[str, Any]]:
    """Executor-side overlay on the ranked signal (``pd.Series`` symbol -> score).

    Returns (filtered_ranking, applied) where ``filtered_ranking`` has
    illiquid names removed and ``applied`` records what the limits did (audit
    trail). Per-name notional and total caps are reported but not folded into
    the ranking — the caller sizes targets and can read ``applied`` to cap.
    """
    applied: Dict[str, Any] = {"notes": [], "dropped_liquidity": []}
    filtered = ranking
    floor = limits.get("liquidity_floor_adv")
    if floor:
        dropped = [s for s in filtered.index if adv.get(str(s).upper(), 0.0) < floor]
        if dropped:
            filtered = filtered.drop(index=[s for s in dropped if s in filtered.index])
            applied["dropped_liquidity"] = [str(s) for s in dropped]
            applied["notes"].append(f"liquidity floor ${floor:,.0f} ADV dropped {len(dropped)}")
    per_name = account * risk_degree / max(topk, 1)
    size_cap = limits.get("size_cap_pct")
    if size_cap:
        cap = account * size_cap / 100.0
        applied["size_cap_notional"] = round(cap, 2)
        if per_name > cap:
            applied["per_name_capped_from"] = round(per_name, 2)
            per_name = cap
            applied["notes"].append(f"size cap {size_cap:g}% cut per-name notional to ${cap:,.2f}")
    applied["per_name_notional"] = round(per_name, 2)
    n_buys = min(topk, max(len(filtered), 0))
    conc = limits.get("concentration_cap_pct")
    if conc:
        conc_cap = account * conc / 100.0
        applied["concentration_cap_notional"] = round(conc_cap, 2)
        total = per_name * max(n_buys, 1)
        if total > conc_cap:
            applied["total_capped_from"] = round(total, 2)
            applied["notes"].append(f"concentration cap {conc:g}% cut total to ${conc_cap:,.2f}")
            per_name = conc_cap / max(n_buys, 1)
            applied["per_name_capped_from"] = applied.get("per_name_capped_from") or round(total / max(n_buys, 1), 2)
            applied["per_name_notional"] = round(per_name, 2)
        applied["total_notional"] = round(min(total, conc_cap), 2)
    else:
        applied["total_notional"] = round(per_name * n_buys, 2)
    return filtered, applied


def drawdown_pause(equity: float, peak_equity: float, limits: Dict[str, float]) -> Tuple[bool, Optional[str]]:
    """Executor gate: True when drawdown from peak exceeds drawdown_pause_pct."""
    pct = limits.get("drawdown_pause_pct")
    if not pct or not peak_equity or not equity:
        return False, None
    dd = (peak_equity - equity) / peak_equity * 100.0
    if dd >= pct:
        return True, f"drawdown {dd:.1f}% >= pause {pct:g}% (peak ${peak_equity:,.2f}, equity ${equity:,.2f})"
    return False, None
