"""Round book MCP server (stdio transport) — the execution trail for algo rounds.

Exposes the round-book tools over MCP so the agent (tac-algo-trade skill) and
the R&D UI can read AND write the same execution trail in Postgres:

    scheduler_runs ──► ROUND ──► rd_experiments

    round_create / round_update / round_update_status / round_list / round_get   windows
    fact_record / fact_query                                      evidence
    intent_set / intent_get / intent_list                         target portfolios
    decision_record / decision_query / order_link                 gates + orders
    round_sync_fills                                              Alpaca fills
    book_reconcile / trail_query / trail_funnel / round_metrics   investigation

Run::

    .venv/bin/python -m tac_qlib.book_server     # stdio MCP server

All tools return JSON-safe dicts. Logging goes to stderr; stdout is reserved
for the MCP protocol. DB access is via tac_qlib.book_db (psycopg + DATABASE_URL);
fill sync additionally needs APCA_API_KEY_ID / APCA_API_SECRET_KEY when the
agent does not pass `orders` explicitly.
"""

from __future__ import annotations

import functools
import json
import sys
from typing import Any, Dict, List, Optional, Sequence

from mcp.server.mcpserver import MCPServer

from tac_qlib import book_db

book_db._load_repo_env()

server = MCPServer(
    name="tac-rd-book",
    title="TradeAC round book",
    instructions=(
        "Execution trail for algo trading rounds on the TradeAC stack: create "
        "round windows, record evidence facts, set versioned target intents, "
        "record placed/skipped decisions, link Alpaca orders, sync fills, and "
        "reconcile / trace the funnel. Backed by Postgres (DATABASE_URL)."
    ),
    version="0.1.0",
)


def _log(message: str) -> None:
    print(f"[tac-rd-book] {message}", file=sys.stderr)


def _as_obj(value: Any) -> Any:
    """Accept structured MCP input as JSON strings or as already-parsed dicts/lists."""
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _obj(value: Any) -> Optional[Dict[str, Any]]:
    parsed = _as_obj(value)
    return parsed if isinstance(parsed, dict) else None


def _arr(value: Any) -> Optional[List[Any]]:
    parsed = _as_obj(value)
    return parsed if isinstance(parsed, list) else None


def _open_round(func):
    """Ensure the round tables exist before any round-book operation.
    Uses ``functools.wraps`` so ``inspect.signature`` follows ``__wrapped__``
    and the MCP tool schema keeps the real typed parameters."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            book_db.ensure_schema()
        except Exception as exc:  # noqa: BLE001
            _log(f"schema check failed: {exc}")
        return func(*args, **kwargs)

    return wrapper


# --------------------------------------------------------------------------- windows

@_open_round
def round_create(
    target_date: str,
    source: str = "scheduled",
    signal_date: str = "",
    scheduler_run_id: int = 0,
    rd_experiment_id: int = 0,
    experiment_name: str = "",
    run_id: str = "",
    model_path: str = "",
    strategy_snapshot: str = "{}",
    account_equity_at_sizing: float = 0.0,
) -> dict:
    """Open a round window for a target trading date. Idempotent per
    (source, target_date): an already-open round for the same window is
    returned unchanged (``reused=True``). Returns the full round row."""
    snap = _obj(strategy_snapshot) or {}
    return book_db.create_round(
        source=source,
        target_date=target_date,
        signal_date=signal_date or None,
        scheduler_run_id=scheduler_run_id or None,
        rd_experiment_id=rd_experiment_id or None,
        experiment_name=experiment_name or None,
        run_id=run_id or None,
        model_path=model_path or None,
        strategy_snapshot=snap,
        account_equity_at_sizing=account_equity_at_sizing or None,
    )


def round_update(
    round_id: int,
    source: str = "",
    target_date: str = "",
    signal_date: str = "",
    scheduler_run_id: int = 0,
    rd_experiment_id: int = 0,
    experiment_name: str = "",
    run_id: str = "",
    model_path: str = "",
    strategy_snapshot: str = "",
    account_equity_at_sizing: float = 0.0,
) -> dict:
    """Update a round window's metadata — e.g. pin the new training run
    (``run_id`` / ``model_path``) and strategy snapshot after the retrain.
    Empty / zero values leave the field unchanged."""
    return book_db.update_round(
        round_id,
        source=source or None,
        target_date=target_date or None,
        signal_date=signal_date or None,
        scheduler_run_id=scheduler_run_id or None,
        rd_experiment_id=rd_experiment_id or None,
        experiment_name=experiment_name or None,
        run_id=run_id or None,
        model_path=model_path or None,
        strategy_snapshot=_obj(strategy_snapshot) if strategy_snapshot else None,
        account_equity_at_sizing=account_equity_at_sizing or None,
    )


def round_update_status(
    round_id: int,
    status: str = "",
    locked_intent_id: int = 0,
    summary_metrics: str = "{}",
    feedback_note: str = "",
) -> dict:
    """Advance a round (open → locked → settled | aborted). ``locked_intent_id``
    pins the intent reconciliation uses. ``summary_metrics`` / ``feedback_note``
    update the round summary."""
    return book_db.update_round_status(
        round_id,
        status=status or None,
        locked_intent_id=locked_intent_id or None,
        summary_metrics=_obj(summary_metrics),
        feedback_note=feedback_note or None,
    )


def round_list(
    source: str = "",
    target_date: str = "",
    status: str = "",
    limit: int = 20,
    include_detail: bool = False,
) -> dict:
    """List round windows (newest first), optionally filtered by source /
    target_date / status. ``include_detail`` attaches each round's funnel
    counts + roll-up metrics (used by the /dashboard/rounds list)."""
    return {
        "rounds": book_db.list_rounds(
            source=source or None,
            target_date=target_date or None,
            status=status or None,
            limit=limit,
            with_detail=bool(include_detail),
        )
    }


def round_get(round_id: int) -> dict:
    """Full detail of one round: window row + intents, decisions, orders, facts,
    funnel and reconciliation — everything the UI's round detail page needs."""
    round_row = book_db.get_round(round_id)
    if round_row is None:
        return {"error": f"round {round_id} not found"}
    return {
        "round": round_row,
        "intents": book_db.list_intents(round_id),
        "decisions": book_db.query_decisions(round_id),
        "orders": book_db.list_orders(round_id),
        "facts": book_db.query_facts(round_id, limit=500),
        "funnel": book_db.funnel(round_id),
        "reconcile": book_db.reconcile(round_id),
        "metrics": book_db.metrics(round_id),
    }


# --------------------------------------------------------------------------- facts

def fact_record(round_id: int, kind: str, payload: str = "{}", symbol: str = "", source: str = "") -> dict:
    """Append an evidence event (signal_score, quote, news_sentiment,
    account_state, position_state, strategy_config, ...) to a round."""
    return book_db.record_fact(
        round_id,
        kind=kind,
        payload=_obj(payload),
        symbol=symbol or None,
        source=source or None,
    )


def fact_query(round_id: int, kind: str = "", symbol: str = "", limit: int = 200) -> dict:
    """Query a round's recorded facts (newest first), optionally filtered by kind/symbol."""
    return {"facts": book_db.query_facts(round_id, kind=kind or None, symbol=symbol or None, limit=limit)}


# --------------------------------------------------------------------------- intents

def intent_set(round_id: int, target_portfolio: str, raw_strategy_output: str = "{}", reason: str = "") -> dict:
    """Write the next target-portfolio version for a round (auto-increments and
    supersedes the previous active version). ``target_portfolio`` is a JSON
    array of {symbol, side, qty, notional, expected_price, score, rank, weight}."""
    return book_db.set_intent(
        round_id,
        target_portfolio=_arr(target_portfolio) or [],
        raw_strategy_output=_obj(raw_strategy_output),
        reason=reason or None,
    )


def intent_get(round_id: int, version: int = 0) -> dict:
    """Get a round's intent — the given version, or the active (max) version
    when ``version`` is omitted."""
    intent = book_db.get_intent(round_id, version=version or None)
    return {"intent": intent} if intent else {"intent": None, "error": f"no intent for round {round_id}"}


def intent_list(round_id: int) -> dict:
    """List every target-portfolio version for a round (oldest first)."""
    return {"intents": book_db.list_intents(round_id)}


# --------------------------------------------------------------------------- decisions / orders

def decision_record(
    round_id: int,
    symbol: str,
    side: str,
    qty: float = 0.0,
    order_type: str = "",
    expected_price: float = 0.0,
    status: str = "intended",
    reason: str = "",
    reason_detail: str = "",
    intent_id: int = 0,
    supersedes_decision_id: int = 0,
    alpaca_order_id: str = "",
    client_order_id: str = "",
) -> dict:
    """Record one per-symbol decision by the gates. Use status ``skipped`` /
    ``rejected`` with a ``reason`` for deliberate skips; placed orders carry
    ``alpaca_order_id`` / ``client_order_id`` (an execution row is created).
    Passing ``supersedes_decision_id`` marks the previous decision superseded."""
    return book_db.record_decision(
        round_id,
        symbol=symbol,
        side=side,
        qty=qty or None,
        order_type=order_type or None,
        expected_price=expected_price or None,
        status=status,
        reason=reason or None,
        reason_detail=reason_detail or None,
        intent_id=intent_id or None,
        supersedes_decision_id=supersedes_decision_id or None,
        alpaca_order_id=alpaca_order_id or None,
        client_order_id=client_order_id or None,
    )


def decision_query(round_id: int, symbol: str = "", include_superseded: bool = True) -> dict:
    """List a round's decisions, optionally filtered by symbol."""
    return {"decisions": book_db.query_decisions(round_id, symbol=symbol or None, include_superseded=include_superseded)}


def order_link(
    round_id: int,
    decision_id: int,
    alpaca_order_id: str = "",
    client_order_id: str = "",
    qty_filled: float = -1.0,
    avg_fill_price: float = -1.0,
    status: str = "",
) -> dict:
    """Create or update the execution row for a placed decision (idempotent per
    decision). Use ``qty_filled=-1`` to leave the value unchanged."""
    return book_db.link_order(
        round_id,
        decision_id=decision_id,
        alpaca_order_id=alpaca_order_id or None,
        client_order_id=client_order_id or None,
        qty_filled=qty_filled if qty_filled >= 0 else None,
        avg_fill_price=avg_fill_price if avg_fill_price >= 0 else None,
        status=status or None,
    )


def round_sync_fills(round_id: int, orders: str = "", feed: str = "iex") -> dict:
    """Pull Alpaca order state into the round. Pass ``orders`` as a JSON array
    (tac-engine ``list_orders`` output) or omit it to fetch from Alpaca with
    APCA_API_* env vars. Marks orders superseded when the effective intent no
    longer targets their symbol+side. Returns updated / superseded / unmatched."""
    parsed = _arr(orders) if isinstance(orders, str) else orders
    return book_db.sync_fills(round_id, orders=parsed if isinstance(parsed, list) else None, feed=feed or "iex")


# --------------------------------------------------------------------------- investigation

def book_reconcile(round_id: int) -> dict:
    """Reconcile the round: effective intent targets vs decisions vs fills, with
    per-symbol residuals and roll-ups (cash/BP impact, slippage bps, cost)."""
    return book_db.reconcile(round_id)


def trail_query(round_id: int, symbol: str = "") -> dict:
    """Per-symbol waterfall: intent target → decision → order → fill."""
    return {"trail": book_db.trail(round_id, symbol=symbol or None)}


def trail_funnel(round_id: int) -> dict:
    """Decision funnel counts for a round: targets → decided → placed → filled,
    plus skipped-reason breakdown and superseded count."""
    return book_db.funnel(round_id)


def round_metrics(round_id: int) -> dict:
    """Roll-up metrics: placed/filled order counts, invested notional, turnover."""
    return book_db.metrics(round_id)


def register_tools(mcp_server: MCPServer) -> None:
    """Attach all round-book tools to an ``MCPServer`` instance."""
    for fn in (
        round_create,
        round_update,
        round_update_status,
        round_list,
        round_get,
        fact_record,
        fact_query,
        intent_set,
        intent_get,
        intent_list,
        decision_record,
        decision_query,
        order_link,
        round_sync_fills,
        book_reconcile,
        trail_query,
        trail_funnel,
        round_metrics,
    ):
        mcp_server.tool(structured_output=False)(fn)


def main() -> None:
    register_tools(server)
    server.run()


if __name__ == "__main__":
    main()
