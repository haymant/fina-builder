"""Round book — execution trail DB executor (psycopg).

The "round" is the execution projection of a scheduled/manual algo run:

    scheduler_runs ──► ROUND ──► rd_experiments

Schema owned by tac-app's Drizzle migrations (`trading_round_book`, migration
0005) and mirrored here as ``CREATE TABLE IF NOT EXISTS`` so the agent can
write the same rows before the app has ever booted against a fresh database
(the ``tac-qlib-custom`` trace_db.py precedent). Four layers:

    fact_events      append-only evidence collected during the run (signals,
                     quotes, news, account/position state) — never mutated.
    round_intents    versioned target portfolios; a newer version supersedes
                     the previous one for the round.
    round_decisions  per-symbol actions decided by the gates (placed OR
                     deliberately skipped, each with a reason).
    round_orders     execution state of placed decisions (Alpaca order + fills).

Env: DATABASE_URL (Postgres). APCA_API_KEY_ID + APCA_API_SECRET_KEY +
APCA_API_BASE_URL are needed only for the Alpaca fill sync.

Usage::

    .venv/bin/python -m tac_qlib.book_db init        # ensure round tables exist
    .venv/bin/python -m tac_qlib.book_db ls          # recent rounds
"""

from __future__ import annotations

import argparse
import datetime as _dt
import decimal
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence

import psycopg
from psycopg.rows import dict_row

ROUND_STATUSES = ("open", "locked", "settled", "aborted")
DECISION_STATUSES = (
    "intended",
    "placed",
    "accepted",
    "filled",
    "partially_filled",
    "cancelled",
    "superseded",
    "skipped",
    "rejected",
)
ORDER_STATUSES = ("accepted", "filled", "partially_filled", "cancelled", "superseded")


# --------------------------------------------------------------------------- env / connection

def _load_repo_env() -> None:
    """Load the repo-root `.env` (like rd_server.py) so DATABASE_URL + Alpaca
    creds resolve whether the module runs from the repo, a wheel, or a container.
    The repo `.env` is authoritative for any var that is currently *unset or
    empty* — opencode spawns MCP servers with ``DATABASE_URL=""`` when the
    ``{env:...}`` substitution finds nothing in its own env, and a plain
    ``load_dotenv(override=False)`` would leave that empty value in place."""
    from dotenv import dotenv_values

    here = os.path.dirname(os.path.abspath(__file__))
    for root in (here, os.getcwd()):
        candidate = os.path.join(root, ".env")
        if not os.path.isfile(candidate):
            continue
        for key, value in dotenv_values(candidate).items():
            if value is None:
                continue
            if not (os.environ.get(key) or "").strip():
                os.environ[key] = value
        return


def _db_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        # Lazy env load: lets scripts use the library directly without first
        # calling `_load_repo_env()` (the MCP server loads it at import).
        _load_repo_env()
        url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def connect() -> psycopg.Connection:
    return psycopg.connect(_db_url(), row_factory=dict_row)


def _jsonable(value: Any) -> Any:
    """Deep-convert Decimals/dates/datetimes (psycopg dict_row output) to JSON-safe types."""
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


# Evidence gate: locking / settling a round requires the evidence kinds that let
# the fact table answer *why the targets were chosen* and *what the market looked
# like*. Per-symbol evidence (symbol_features, decision_justification) is only
# required when the round actually has an intent targeting that symbol.
def _assert_evidence_gate(
    round_id: int,
    status: str,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> None:
    required_once = ("signal_score", "market_snapshot", "strategy_config", "account_state")
    per_target = ("symbol_features", "decision_justification")
    own = conn is None
    c = conn or connect()
    try:
        with c.cursor() as cur:
            cur.execute("SELECT kind, symbol FROM fact_events WHERE round_id = %s", (round_id,))
            rows = cur.fetchall()
            cur.execute(
                "SELECT target_portfolio FROM round_intents WHERE round_id = %s ORDER BY version DESC LIMIT 1",
                (round_id,),
            )
            active_intent = cur.fetchone()
    finally:
        if own:
            c.close()
    kinds = {r["kind"] for r in rows}
    missing = [k for k in required_once if k not in kinds]
    if active_intent:
        portfolio = active_intent["target_portfolio"]
        if isinstance(portfolio, str):
            try:
                portfolio = json.loads(portfolio)
            except ValueError:
                portfolio = []
        target_symbols = {
            t["symbol"] for t in portfolio or [] if isinstance(t, dict) and t.get("symbol")
        }
        per_sym = {s: set() for s in target_symbols}
        for r in rows:
            if r["kind"] in per_target and r["symbol"] in per_sym:
                per_sym[r["symbol"]].add(r["kind"])
        for s, got in sorted(per_sym.items()):
            for k in per_target:
                if k not in got:
                    missing.append(f"{k} for {s}")
    if missing:
        raise ValueError(
            f"cannot {status} round {round_id}: evidence gate not met — missing fact kinds: {', '.join(missing)}. "
            "Record them with fact_record (e.g. get_lake_ta/get_lake_sp persist:true + get_lake_features + rd_exp_model "
            "for symbol_features, rd_exp_model tree path for decision_justification), then retry."
        )


# --------------------------------------------------------------------------- DDL (mirrors migration 0005)

SCHEMA_DDL: List[str] = [
    """
    CREATE TABLE IF NOT EXISTS trading_rounds (
        id bigserial PRIMARY KEY NOT NULL,
        source text DEFAULT 'scheduled' NOT NULL,
        target_date date NOT NULL,
        signal_date date,
        scheduler_run_id bigint,
        rd_experiment_id bigint,
        experiment_name text,
        run_id text,
        model_path text,
        strategy_snapshot jsonb,
        account_equity_at_sizing numeric,
        status text DEFAULT 'open' NOT NULL,
        locked_intent_id bigint,
        summary_metrics jsonb,
        feedback_note text,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS fact_events (
        id bigserial PRIMARY KEY NOT NULL,
        round_id bigint NOT NULL,
        kind text NOT NULL,
        symbol text,
        payload jsonb,
        source text,
        at timestamp with time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS round_intents (
        id bigserial PRIMARY KEY NOT NULL,
        round_id bigint NOT NULL,
        version bigint NOT NULL,
        supersedes_intent_id bigint,
        target_portfolio jsonb,
        raw_strategy_output jsonb,
        reason text,
        created_at timestamp with time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS round_decisions (
        id bigserial PRIMARY KEY NOT NULL,
        round_id bigint NOT NULL,
        intent_id bigint,
        symbol text NOT NULL,
        side text NOT NULL,
        qty numeric,
        order_type text,
        expected_price numeric,
        status text DEFAULT 'intended' NOT NULL,
        reason text,
        reason_detail text,
        superseded_by_decision_id bigint,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS round_orders (
        id bigserial PRIMARY KEY NOT NULL,
        decision_id bigint NOT NULL,
        round_id bigint NOT NULL,
        alpaca_order_id text,
        client_order_id text,
        qty_intended numeric,
        qty_filled numeric DEFAULT '0' NOT NULL,
        avg_fill_price numeric,
        status text DEFAULT 'accepted' NOT NULL,
        superseded_by_order_id bigint,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
    """,
]

SCHEMA_INDEXES: List[str] = [
    "CREATE INDEX IF NOT EXISTS trading_rounds_target_date_idx ON trading_rounds (target_date)",
    "CREATE INDEX IF NOT EXISTS trading_rounds_scheduler_run_id_idx ON trading_rounds (scheduler_run_id)",
    "CREATE INDEX IF NOT EXISTS trading_rounds_rd_experiment_id_idx ON trading_rounds (rd_experiment_id)",
    "CREATE INDEX IF NOT EXISTS trading_rounds_locked_intent_id_idx ON trading_rounds (locked_intent_id)",
    "CREATE INDEX IF NOT EXISTS fact_events_round_id_idx ON fact_events (round_id)",
    "CREATE INDEX IF NOT EXISTS fact_events_round_kind_idx ON fact_events (round_id, kind)",
    "CREATE INDEX IF NOT EXISTS round_intents_round_id_idx ON round_intents (round_id)",
    "CREATE INDEX IF NOT EXISTS round_intents_round_version_idx ON round_intents (round_id, version)",
    "CREATE INDEX IF NOT EXISTS round_decisions_round_id_idx ON round_decisions (round_id)",
    "CREATE INDEX IF NOT EXISTS round_decisions_round_symbol_idx ON round_decisions (round_id, symbol)",
    "CREATE INDEX IF NOT EXISTS round_decisions_intent_id_idx ON round_decisions (intent_id)",
    "CREATE INDEX IF NOT EXISTS round_orders_round_id_idx ON round_orders (round_id)",
    "CREATE INDEX IF NOT EXISTS round_orders_decision_id_idx ON round_orders (decision_id)",
    "CREATE INDEX IF NOT EXISTS round_orders_alpaca_order_id_idx ON round_orders (alpaca_order_id)",
]


def ensure_schema(conn: Optional[psycopg.Connection] = None) -> None:
    """Create the round-book tables + indexes (idempotent). Owns its own
    connection when none is passed so the CLI / server can call it freely."""
    own = conn is None
    c = conn or connect()
    try:
        with c.cursor() as cur:
            for ddl in SCHEMA_DDL:
                cur.execute(ddl)
            for ddl in SCHEMA_INDEXES:
                cur.execute(ddl)
        c.commit()
    finally:
        if own:
            c.close()


# --------------------------------------------------------------------------- rounds

def create_round(
    source: str = "scheduled",
    target_date: Optional[str] = None,
    signal_date: Optional[str] = None,
    scheduler_run_id: Optional[int] = None,
    rd_experiment_id: Optional[int] = None,
    experiment_name: Optional[str] = None,
    run_id: Optional[str] = None,
    model_path: Optional[str] = None,
    strategy_snapshot: Optional[Dict[str, Any]] = None,
    account_equity_at_sizing: Optional[float] = None,
    *,
    reopen: bool = True,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Open a round window for a target trading date.

    ``reopen=True`` (default) makes this idempotent per (source, target_date):
    if an open round already exists for the window it is returned unchanged
    (``reused=True``) instead of creating a duplicate window. A settled window
    is never reopened — a fresh round is created.
    """
    if not target_date:
        raise ValueError("target_date is required (YYYY-MM-DD, the trading day being executed)")
    source = source or "scheduled"
    own = conn is None
    c = conn or connect()
    try:
        if reopen:
            row = c.execute(
                "SELECT * FROM trading_rounds WHERE source = %s AND target_date = %s AND status = 'open' "
                "ORDER BY id DESC LIMIT 1",
                (source, target_date),
            ).fetchone()
            if row:
                return {**_jsonable(row), "reused": True}

        with c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO trading_rounds
                    (source, target_date, signal_date, scheduler_run_id, rd_experiment_id,
                     experiment_name, run_id, model_path, strategy_snapshot, account_equity_at_sizing)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    source,
                    target_date,
                    signal_date,
                    scheduler_run_id,
                    rd_experiment_id,
                    experiment_name,
                    run_id,
                    model_path,
                    json.dumps(strategy_snapshot) if strategy_snapshot is not None else None,
                    account_equity_at_sizing,
                ),
            )
            row = cur.fetchone()
        c.commit()
        return {**_jsonable(row), "reused": False}
    finally:
        if own:
            c.close()


def update_round_status(
    round_id: int,
    status: Optional[str] = None,
    locked_intent_id: Optional[int] = None,
    summary_metrics: Optional[Dict[str, Any]] = None,
    feedback_note: Optional[str] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Advance a round (open → locked → settled | aborted). ``locked_intent_id``
    pins the intent the reconciliation should reconcile against."""
    if status is not None and status not in ROUND_STATUSES:
        raise ValueError(f"invalid round status {status!r}; expected one of {ROUND_STATUSES}")
    if status in ("locked", "settled"):
        _assert_evidence_gate(round_id, status, conn=conn)
    fields = []
    params: List[Any] = []
    if status is not None:
        fields.append("status = %s")
        params.append(status)
    if locked_intent_id is not None:
        fields.append("locked_intent_id = %s")
        params.append(locked_intent_id)
    if summary_metrics is not None:
        fields.append("summary_metrics = %s")
        params.append(json.dumps(summary_metrics))
    if feedback_note is not None:
        fields.append("feedback_note = %s")
        params.append(feedback_note)
    fields.append("updated_at = now()")
    params.append(round_id)
    own = conn is None
    c = conn or connect()
    try:
        row = c.execute(
            f"UPDATE trading_rounds SET {', '.join(fields)} WHERE id = %s RETURNING *",
            params,
        ).fetchone()
        c.commit()
        if not row:
            raise ValueError(f"round {round_id} not found")
        return _jsonable(row)
    finally:
        if own:
            c.close()


def update_round(
    round_id: int,
    *,
    source: Optional[str] = None,
    target_date: Optional[str] = None,
    signal_date: Optional[str] = None,
    scheduler_run_id: Optional[int] = None,
    rd_experiment_id: Optional[int] = None,
    experiment_name: Optional[str] = None,
    run_id: Optional[str] = None,
    model_path: Optional[str] = None,
    strategy_snapshot: Optional[Dict[str, Any]] = None,
    account_equity_at_sizing: Optional[float] = None,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Update metadata fields of a round window (e.g. fill in the new training
    run / model path after the retrain completes)."""
    fields, params = [], []
    if source is not None:
        fields.append("source = %s")
        params.append(source)
    if target_date is not None:
        fields.append("target_date = %s")
        params.append(target_date)
    if signal_date is not None:
        fields.append("signal_date = %s")
        params.append(signal_date)
    if scheduler_run_id is not None:
        fields.append("scheduler_run_id = %s")
        params.append(scheduler_run_id)
    if rd_experiment_id is not None:
        fields.append("rd_experiment_id = %s")
        params.append(rd_experiment_id)
    if experiment_name is not None:
        fields.append("experiment_name = %s")
        params.append(experiment_name)
    if run_id is not None:
        fields.append("run_id = %s")
        params.append(run_id)
    if model_path is not None:
        fields.append("model_path = %s")
        params.append(model_path)
    if strategy_snapshot is not None:
        fields.append("strategy_snapshot = %s")
        params.append(json.dumps(strategy_snapshot))
    if account_equity_at_sizing is not None:
        fields.append("account_equity_at_sizing = %s")
        params.append(account_equity_at_sizing)
    if not fields:
        return get_round(round_id, conn=conn) or {}
    fields.append("updated_at = now()")
    params.append(round_id)
    own = conn is None
    c = conn or connect()
    try:
        row = c.execute(
            f"UPDATE trading_rounds SET {', '.join(fields)} WHERE id = %s RETURNING *",
            params,
        ).fetchone()
        c.commit()
        if not row:
            raise ValueError(f"round {round_id} not found")
        return _jsonable(row)
    finally:
        if own:
            c.close()


def get_round(round_id: int, *, conn: Optional[psycopg.Connection] = None) -> Optional[Dict[str, Any]]:
    c = conn or connect()
    try:
        row = c.execute("SELECT * FROM trading_rounds WHERE id = %s", (round_id,)).fetchone()
        return _jsonable(row) if row else None
    finally:
        if conn is None:
            c.close()


def list_rounds(
    source: Optional[str] = None,
    target_date: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 20,
    *,
    with_detail: bool = False,
    conn: Optional[psycopg.Connection] = None,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []
    if source:
        clauses.append("source = %s")
        params.append(source)
    if target_date:
        clauses.append("target_date = %s")
        params.append(target_date)
    if status:
        clauses.append("status = %s")
        params.append(status)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(max(1, min(int(limit), 200)))
    own = conn is None
    c = conn or connect()
    try:
        rows = c.execute(
            f"SELECT * FROM trading_rounds {where} ORDER BY target_date DESC, id DESC LIMIT %s",
            params,
        ).fetchall()
        rounds = [_jsonable(r) for r in rows]
        if with_detail:
            for r in rounds:
                try:
                    r["funnel"] = funnel(r["id"], conn=c)
                    r["metrics"] = metrics(r["id"], conn=c)
                except Exception:  # noqa: BLE001 - keep the window even if a roll-up fails
                    pass
        return rounds
    finally:
        if own:
            c.close()


# --------------------------------------------------------------------------- fact_events

def record_fact(
    round_id: int,
    kind: str,
    payload: Optional[Dict[str, Any]] = None,
    symbol: Optional[str] = None,
    source: Optional[str] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Append an evidence event to the round (never mutated, only appended)."""
    if not kind:
        raise ValueError("kind is required (signal_score | quote | news_sentiment | account_state | position_state | strategy_config | ...)")
    own = conn is None
    c = conn or connect()
    try:
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO fact_events (round_id, kind, symbol, payload, source) VALUES (%s, %s, %s, %s, %s) RETURNING *",
                (round_id, kind, symbol, json.dumps(payload) if payload is not None else None, source),
            )
            row = cur.fetchone()
        c.commit()
        return _jsonable(row)
    finally:
        if own:
            c.close()


def query_facts(
    round_id: int,
    kind: Optional[str] = None,
    symbol: Optional[str] = None,
    limit: int = 200,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> List[Dict[str, Any]]:
    clauses = ["round_id = %s"]
    params: List[Any] = [round_id]
    if kind:
        clauses.append("kind = %s")
        params.append(kind)
    if symbol:
        clauses.append("symbol = %s")
        params.append(symbol)
    params.append(max(1, min(int(limit), 1000)))
    c = conn or connect()
    try:
        rows = c.execute(
            f"SELECT * FROM fact_events WHERE {' AND '.join(clauses)} ORDER BY id DESC LIMIT %s",
            params,
        ).fetchall()
        return [_jsonable(r) for r in rows]
    finally:
        if conn is None:
            c.close()


# --------------------------------------------------------------------------- round_intents

def set_intent(
    round_id: int,
    target_portfolio: Sequence[Dict[str, Any]],
    raw_strategy_output: Optional[Dict[str, Any]] = None,
    reason: Optional[str] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Write the next target-portfolio version for a round. Version numbers
    increment per round; a new version supersedes the previous active one
    (``supersedes_intent_id``), and the round's ``updated_at`` bumps so list
    ordering reflects the latest intent."""
    if not isinstance(target_portfolio, (list, tuple)) or not target_portfolio:
        raise ValueError("target_portfolio must be a non-empty list of {symbol, side, ...} rows")
    own = conn is None
    c = conn or connect()
    try:
        prev = c.execute(
            "SELECT id, version FROM round_intents WHERE round_id = %s ORDER BY version DESC LIMIT 1",
            (round_id,),
        ).fetchone()
        version = int((prev or {}).get("version", 0)) + 1
        with c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO round_intents
                    (round_id, version, supersedes_intent_id, target_portfolio, raw_strategy_output, reason)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
                """,
                (
                    round_id,
                    version,
                    prev["id"] if prev else None,
                    json.dumps(list(target_portfolio)),
                    json.dumps(raw_strategy_output) if raw_strategy_output is not None else None,
                    reason,
                ),
            )
            row = cur.fetchone()
            cur.execute("UPDATE trading_rounds SET updated_at = now() WHERE id = %s", (round_id,))
        c.commit()
        return _jsonable(row)
    finally:
        if own:
            c.close()


def get_intent(round_id: int, version: Optional[int] = None, *, conn: Optional[psycopg.Connection] = None) -> Optional[Dict[str, Any]]:
    c = conn or connect()
    try:
        if version is not None:
            row = c.execute(
                "SELECT * FROM round_intents WHERE round_id = %s AND version = %s", (round_id, version)
            ).fetchone()
        else:
            row = c.execute(
                "SELECT * FROM round_intents WHERE round_id = %s ORDER BY version DESC LIMIT 1", (round_id,)
            ).fetchone()
        return _jsonable(row) if row else None
    finally:
        if conn is None:
            c.close()


def list_intents(round_id: int, *, conn: Optional[psycopg.Connection] = None) -> List[Dict[str, Any]]:
    c = conn or connect()
    try:
        rows = c.execute(
            "SELECT * FROM round_intents WHERE round_id = %s ORDER BY version ASC", (round_id,)
        ).fetchall()
        return [_jsonable(r) for r in rows]
    finally:
        if conn is None:
            c.close()


# --------------------------------------------------------------------------- round_decisions / round_orders

def record_decision(
    round_id: int,
    symbol: str,
    side: str,
    qty: Optional[float] = None,
    order_type: Optional[str] = None,
    expected_price: Optional[float] = None,
    status: str = "intended",
    reason: Optional[str] = None,
    reason_detail: Optional[str] = None,
    intent_id: Optional[int] = None,
    supersedes_decision_id: Optional[int] = None,
    alpaca_order_id: Optional[str] = None,
    client_order_id: Optional[str] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Record one per-symbol decision by the gates — either a placed order
    (status ``placed``/``accepted``/...) or a deliberate skip (status
    ``skipped``/``rejected`` with a ``reason``). When ``alpaca_order_id`` is
    given and the decision is not a skip, a ``round_orders`` execution row is
    created alongside."""
    if status not in DECISION_STATUSES:
        raise ValueError(f"invalid decision status {status!r}; expected one of {DECISION_STATUSES}")
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")
    own = conn is None
    c = conn or connect()
    try:
        with c.cursor() as cur:
            if supersedes_decision_id is not None:
                cur.execute(
                    "UPDATE round_decisions SET status = 'superseded', superseded_by_decision_id = %s, "
                    "updated_at = now() WHERE id = %s",
                    (supersedes_decision_id, supersedes_decision_id),
                )
            cur.execute(
                """
                INSERT INTO round_decisions
                    (round_id, intent_id, symbol, side, qty, order_type, expected_price, status,
                     reason, reason_detail, superseded_by_decision_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    round_id,
                    intent_id,
                    symbol,
                    side,
                    qty,
                    order_type,
                    expected_price,
                    status,
                    reason,
                    reason_detail,
                    supersedes_decision_id,
                ),
            )
            decision = cur.fetchone()
            decision_id = decision["id"]
            order = None
            if alpaca_order_id is not None and status not in ("skipped", "rejected", "superseded"):
                cur.execute(
                    """
                    INSERT INTO round_orders
                        (decision_id, round_id, alpaca_order_id, client_order_id, qty_intended, status)
                    VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
                    """,
                    (decision_id, round_id, alpaca_order_id, client_order_id, qty, "accepted"),
                )
                order = cur.fetchone()
            cur.execute("UPDATE trading_rounds SET updated_at = now() WHERE id = %s", (round_id,))
        c.commit()
        result = _jsonable(decision)
        result["order"] = _jsonable(order) if order else None
        return result
    finally:
        if own:
            c.close()


def link_order(
    round_id: int,
    decision_id: int,
    alpaca_order_id: Optional[str] = None,
    client_order_id: Optional[str] = None,
    qty_filled: Optional[float] = None,
    avg_fill_price: Optional[float] = None,
    status: Optional[str] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Create or update the execution row for a placed decision (idempotent per
    alpaca_order_id / client_order_id / decision_id)."""
    own = conn is None
    c = conn or connect()
    try:
        existing = c.execute(
            "SELECT * FROM round_orders WHERE decision_id = %s AND round_id = %s ORDER BY id DESC LIMIT 1",
            (decision_id, round_id),
        ).fetchone()
        with c.cursor() as cur:
            if existing is not None:
                fields, params = [], []
                if alpaca_order_id is not None:
                    fields.append("alpaca_order_id = %s")
                    params.append(alpaca_order_id)
                if client_order_id is not None:
                    fields.append("client_order_id = %s")
                    params.append(client_order_id)
                if qty_filled is not None:
                    fields.append("qty_filled = %s")
                    params.append(qty_filled)
                if avg_fill_price is not None:
                    fields.append("avg_fill_price = %s")
                    params.append(avg_fill_price)
                if status is not None:
                    if status not in ORDER_STATUSES:
                        raise ValueError(f"invalid order status {status!r}; expected one of {ORDER_STATUSES}")
                    fields.append("status = %s")
                    params.append(status)
                fields.append("updated_at = now()")
                params.extend([decision_id, round_id])
                cur.execute(
                    f"UPDATE round_orders SET {', '.join(fields)} WHERE decision_id = %s AND round_id = %s RETURNING *",
                    params,
                )
                row = cur.fetchone()
            else:
                if status is not None and status not in ORDER_STATUSES:
                    raise ValueError(f"invalid order status {status!r}; expected one of {ORDER_STATUSES}")
                cur.execute(
                    """
                    INSERT INTO round_orders
                        (decision_id, round_id, alpaca_order_id, client_order_id, qty_intended,
                         qty_filled, avg_fill_price, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *
                    """,
                    (
                        decision_id,
                        round_id,
                        alpaca_order_id,
                        client_order_id,
                        None,
                        qty_filled if qty_filled is not None else 0,
                        avg_fill_price,
                        status or "accepted",
                    ),
                )
                row = cur.fetchone()
            cur.execute("UPDATE trading_rounds SET updated_at = now() WHERE id = %s", (round_id,))
        c.commit()
        return _jsonable(row)
    finally:
        if own:
            c.close()


def query_decisions(
    round_id: int,
    symbol: Optional[str] = None,
    include_superseded: bool = True,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> List[Dict[str, Any]]:
    clauses = ["round_id = %s"]
    params: List[Any] = [round_id]
    if symbol:
        clauses.append("symbol = %s")
        params.append(symbol)
    if not include_superseded:
        clauses.append("status <> 'superseded'")
    c = conn or connect()
    try:
        rows = c.execute(
            f"SELECT * FROM round_decisions WHERE {' AND '.join(clauses)} ORDER BY id ASC",
            params,
        ).fetchall()
        return [_jsonable(r) for r in rows]
    finally:
        if conn is None:
            c.close()


def list_orders(
    round_id: int,
    decision_id: Optional[int] = None,
    *,
    conn: Optional[psycopg.Connection] = None,
) -> List[Dict[str, Any]]:
    """Execution rows for a round (optionally one decision)."""
    clauses = ["round_id = %s"]
    params: List[Any] = [round_id]
    if decision_id is not None:
        clauses.append("decision_id = %s")
        params.append(decision_id)
    c = conn or connect()
    try:
        rows = c.execute(
            f"SELECT * FROM round_orders WHERE {' AND '.join(clauses)} ORDER BY id ASC",
            params,
        ).fetchall()
        return [_jsonable(r) for r in rows]
    finally:
        if conn is None:
            c.close()


def _orders_for_round(round_id: int, conn: psycopg.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM round_orders WHERE round_id = %s ORDER BY id ASC", (round_id,)
    ).fetchall()
    return [_jsonable(r) for r in rows]


# --------------------------------------------------------------------------- Alpaca fill sync

_ALPACA_STATUS_MAP = {
    "filled": "filled",
    "partially_filled": "partially_filled",
    "canceled": "cancelled",
    "cancelled": "cancelled",
    "expired": "cancelled",
    "replaced": "superseded",
    "superseded": "superseded",
}


def _alpaca_orders_from_api(*, feed: str = "iex") -> List[Dict[str, Any]]:
    """Fetch recent closed+open orders from the Alpaca REST API (paper by
    default). Returns raw order dicts (already JSON-safe)."""
    import httpx

    key_id = (os.environ.get("APCA_API_KEY_ID") or "").strip()
    secret = (os.environ.get("APCA_API_SECRET_KEY") or "").strip()
    base = (os.environ.get("APCA_API_BASE_URL") or "https://paper-api.alpaca.markets").strip()
    if not key_id or not secret:
        raise RuntimeError(
            "APCA_API_KEY_ID / APCA_API_SECRET_KEY not set — pass `orders` explicitly instead of fetching from Alpaca"
        )
    headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
    url = f"{base.rstrip('/')}/v2/orders"
    resp = httpx.get(
        url,
        params={"status": "all", "limit": 500, "sort": "desc", "nested": "true", "feed": feed},
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _normalize_orders(orders: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize Alpaca order dicts (from the API or passed via the `orders`
    param, e.g. the tac-engine list_orders output) to a single shape."""
    out = []
    for o in orders:
        out.append(
            {
                "alpaca_order_id": o.get("id") or o.get("alpaca_order_id"),
                "client_order_id": o.get("client_order_id"),
                "symbol": o.get("symbol"),
                "side": o.get("side"),
                "qty": o.get("qty") or o.get("qty_intended"),
                "filled_qty": o.get("filled_qty"),
                "filled_avg_price": o.get("filled_avg_price"),
                "status": o.get("status"),
            }
        )
    return out


def sync_fills(
    round_id: int,
    orders: Optional[Sequence[Dict[str, Any]]] = None,
    feed: str = "iex",
    *,
    conn: Optional[psycopg.Connection] = None,
) -> Dict[str, Any]:
    """Pull Alpaca order state into the round's execution rows and compute the
    supersession delta against the effective (locked or latest) intent.

    - ``orders``: list of Alpaca order dicts (tac-engine ``list_orders`` output
      or the REST shape). When omitted, fetched from Alpaca directly using
      APCA_API_* env vars.
    - Orders match a ``round_orders`` row by alpaca_order_id, then
      client_order_id. Orders that match nothing are returned as ``unmatched``
      (they may belong to another round or predate the round book).
    - A placed order whose symbol+side is no longer in the effective intent is
      marked ``superseded`` (unless already filled); its decision is superseded
      too.
    """
    own = conn is None
    c = conn or connect()
    try:
        if orders is None:
            orders = _normalize_orders(_alpaca_orders_from_api(feed=feed))
        else:
            orders = _normalize_orders(orders)

        existing = {r["alpaca_order_id"]: r for r in _orders_for_round(round_id, c) if r["alpaca_order_id"]}
        existing_client = {
            r["client_order_id"]: r for r in _orders_for_round(round_id, c) if r["client_order_id"] and r["client_order_id"] not in existing
        }

        intent = get_intent(round_id, conn=c)
        target_set = set()
        if intent and intent.get("target_portfolio"):
            target_set = {(t.get("symbol"), t.get("side")) for t in intent["target_portfolio"] if t.get("symbol")}

        updated, unmatched, superseded = [], [], []
        with c.cursor() as cur:
            for o in orders:
                row = existing.get(o["alpaca_order_id"]) or existing_client.get(o["client_order_id"])
                if row is None:
                    unmatched.append(o)
                    continue
                status = _ALPACA_STATUS_MAP.get((o.get("status") or "").lower(), "accepted")
                filled_qty = o.get("filled_qty")
                avg_price = o.get("filled_avg_price")
                cur.execute(
                    """
                    UPDATE round_orders SET status = %s, qty_filled = %s, avg_fill_price = %s, updated_at = now()
                    WHERE id = %s RETURNING *
                    """,
                    (status, filled_qty if filled_qty is not None else row.get("qty_filled", 0), avg_price, row["id"]),
                )
                ord_row = cur.fetchone()
                updated.append(_jsonable(ord_row))

                # Supersession: the effective intent no longer wants this symbol+side.
                key = (o.get("symbol"), o.get("side"))
                if target_set and key not in target_set and status in ("accepted", "partially_filled"):
                    cur.execute(
                        "UPDATE round_orders SET status = 'superseded', updated_at = now() WHERE id = %s RETURNING *",
                        (row["id"],),
                    )
                    cur.execute(
                        "UPDATE round_decisions SET status = 'superseded', updated_at = now() WHERE id = %s",
                        (row["decision_id"],),
                    )
                    superseded.append(_jsonable(cur.fetchone()))

            cur.execute("UPDATE trading_rounds SET updated_at = now() WHERE id = %s", (round_id,))
        c.commit()
        return {
            "round_id": round_id,
            "matched": len(updated),
            "updated": updated,
            "superseded": superseded,
            "unmatched": unmatched,
        }
    finally:
        if own:
            c.close()


# --------------------------------------------------------------------------- reconciliation / trail / metrics

def _effective_intent(round_id: int, conn: psycopg.Connection) -> Optional[Dict[str, Any]]:
    round_row = get_round(round_id, conn=conn)
    if not round_row:
        raise ValueError(f"round {round_id} not found")
    locked = round_row.get("locked_intent_id")
    if locked is not None:
        row = conn.execute("SELECT * FROM round_intents WHERE id = %s", (locked,)).fetchone()
        if row:
            return _jsonable(row)
    return get_intent(round_id, conn=conn)


def funnel(round_id: int, *, conn: Optional[psycopg.Connection] = None) -> Dict[str, Any]:
    """Count the decision funnel: intended targets → decided → placed → filled.

    Order-derived counts (placed/filled/partial/live/cancelled) come from the
    ``round_orders`` execution rows; decision-derived counts (decided/skipped/
    superseded) come from ``round_decisions``."""
    own = conn is None
    c = conn or connect()
    try:
        intent = _effective_intent(round_id, c)
        target_symbols = set()
        if intent and intent.get("target_portfolio"):
            target_symbols = {(t.get("symbol"), t.get("side")) for t in intent["target_portfolio"] if t.get("symbol")}
        decisions = query_decisions(round_id, conn=c)
        orders = _orders_for_round(round_id, c)

        decided = [d for d in decisions if d["status"] != "superseded"]
        skipped = [d for d in decisions if d["status"] in ("skipped", "rejected")]
        superseded = [d for d in decisions if d["status"] == "superseded"]

        order_status = {"filled": 0, "partially_filled": 0, "accepted": 0, "cancelled": 0, "superseded": 0}
        for o in orders:
            order_status[o["status"]] = order_status.get(o["status"], 0) + 1

        skipped_reasons: Dict[str, int] = {}
        for d in skipped:
            skipped_reasons[d.get("reason") or "no_reason"] = skipped_reasons.get(d.get("reason") or "no_reason", 0) + 1

        return _jsonable(
            {
                "round_id": round_id,
                "intent_version": intent.get("version") if intent else None,
                "target_symbols": len(target_symbols),
                "decided": len(decided),
                "placed": len(orders),
                "filled": order_status["filled"],
                "partially_filled": order_status["partially_filled"],
                "live": order_status["accepted"] + order_status["partially_filled"],
                "cancelled": order_status["cancelled"],
                "skipped": len(skipped),
                "skipped_reasons": skipped_reasons,
                "superseded": len(superseded),
                "superseded_orders": order_status["superseded"],
                "no_decision_targets": len(target_symbols - {(d.get("symbol"), d.get("side")) for d in decided}),
            }
        )
    finally:
        if conn is None:
            c.close()


def reconcile(round_id: int, *, conn: Optional[psycopg.Connection] = None) -> Dict[str, Any]:
    """Reconcile the effective intent against decisions + fills.

    Returns a per-symbol residual table (target qty minus filled qty, with the
    reason the target did not fill), plus roll-ups for cash/BP impact, slippage
    and estimated cost.
    """
    own = conn is None
    c = conn or connect()
    try:
        round_row = get_round(round_id, conn=c)
        if not round_row:
            raise ValueError(f"round {round_id} not found")
        intent = _effective_intent(round_id, c)
        decisions = query_decisions(round_id, conn=c)
        orders = _orders_for_round(round_id, c)
        decision_by = {}
        for d in decisions:
            decision_by.setdefault((d.get("symbol"), d.get("side")), []).append(d)
        order_by_decision = {}
        for o in orders:
            order_by_decision.setdefault(o.get("decision_id"), []).append(o)

        equity = float(round_row.get("account_equity_at_sizing") or 0) or None
        rows = []
        gross_traded = 0.0
        cash_impact = 0.0
        slippage_bps = 0.0
        slippage_w = 0.0
        cost_est = 0.0
        open_cost = float((round_row.get("strategy_snapshot") or {}).get("open_cost") or 0.0005)
        close_cost = float((round_row.get("strategy_snapshot") or {}).get("close_cost") or 0.0015)
        min_cost = float((round_row.get("strategy_snapshot") or {}).get("min_cost") or 5)

        for target in intent.get("target_portfolio") or []:
            symbol = target.get("symbol")
            side = target.get("side")
            if not symbol:
                continue
            qty_target = float(target.get("qty") or 0) or None
            cands = decision_by.get((symbol, side), [])
            cand = next((d for d in cands if d["status"] != "superseded"), cands[-1] if cands else None)
            if cand is None:
                rows.append(
                    {
                        "symbol": symbol,
                        "side": side,
                        "target_qty": qty_target,
                        "filled_qty": 0,
                        "residual_qty": qty_target,
                        "status": "no_decision",
                        "reason": None,
                    }
                )
                continue
            order = None
            for o in order_by_decision.get(cand["id"], []):
                if o["status"] != "superseded":
                    order = o
                    break
            if order is None:
                order = (order_by_decision.get(cand["id"]) or [None])[0]
            filled_qty = float(order.get("qty_filled") or 0) if order else 0.0
            residual = (qty_target - filled_qty) if qty_target is not None else None
            rows.append(
                {
                    "symbol": symbol,
                    "side": side,
                    "target_qty": qty_target,
                    "filled_qty": filled_qty,
                    "residual_qty": residual,
                    "status": (order.get("status") if order else cand.get("status")),
                    "reason": cand.get("reason"),
                    "expected_price": target.get("expected_price") or cand.get("expected_price"),
                    "avg_fill_price": order.get("avg_fill_price") if order else None,
                }
            )
            notional = filled_qty * float(order.get("avg_fill_price") or 0) if order and order.get("avg_fill_price") else 0.0
            gross_traded += notional
            cash_impact += notional if side == "sell" else -notional
            expected = target.get("expected_price") or cand.get("expected_price")
            if order and order.get("avg_fill_price") and expected:
                px = float(order["avg_fill_price"])
                ref = float(expected)
                if ref:
                    bp = (px - ref) / ref * 1e4
                    slippage_bps += abs(bp) * notional
                    slippage_w += notional
            if order:
                q = float(order.get("qty_filled") or 0)
                px = float(order.get("avg_fill_price") or 0)
                val = q * px
                rate = close_cost if side == "sell" else open_cost
                cost_est += max(val * rate, min_cost if q else 0)

        inv = round_row.get("summary_metrics") or {}
        return _jsonable(
            {
                "round_id": round_id,
                "intent_version": intent.get("version") if intent else None,
                "account_equity_at_sizing": equity,
                "target_symbols": len(intent.get("target_portfolio") or []),
                "rows": rows,
                "rollup": {
                    "gross_traded_notional": round(gross_traded, 2),
                    "net_cash_impact": round(cash_impact, 2),
                    "slippage_bps": round(slippage_bps / slippage_w, 2) if slippage_w else None,
                    "estimated_cost": round(cost_est, 2),
                    "residual_symbols": sum(1 for r in rows if (r.get("residual_qty") or 0) > 0),
                },
                "summary_metrics": inv,
            }
        )
    finally:
        if conn is None:
            c.close()


def trail(round_id: int, symbol: Optional[str] = None, *, conn: Optional[psycopg.Connection] = None) -> List[Dict[str, Any]]:
    """Waterfall per symbol: intent target → decision → order → fill.

    The target row is resolved from the decision's own intent (via
    ``intent_id``) so superseded symbols keep their original target context
    even after a newer intent dropped them; the effective (locked/latest)
    intent is the fallback."""
    own = conn is None
    c = conn or connect()
    try:
        intents = list_intents(round_id, conn=c)
        active_intent = _effective_intent(round_id, c)
        by_intent = {}
        intent_version = {}
        for iv in intents:
            index = {}
            for t in iv.get("target_portfolio") or []:
                if t.get("symbol"):
                    index.setdefault(t["symbol"], t)
            by_intent[iv["id"]] = index
            intent_version[iv["id"]] = iv.get("version")
        active_index = {}
        if active_intent:
            for t in active_intent.get("target_portfolio") or []:
                if t.get("symbol"):
                    active_index[t["symbol"]] = t
        decisions = query_decisions(round_id, symbol=symbol, conn=c)
        orders = _orders_for_round(round_id, c)
        order_by_decision = {}
        for o in orders:
            order_by_decision.setdefault(o.get("decision_id"), []).append(o)

        rows = []
        for d in decisions:
            sym = d.get("symbol")
            if symbol and sym != symbol:
                continue
            target = (by_intent.get(d.get("intent_id")) or {}).get(sym) or active_index.get(sym) or {}
            rows.append(
                {
                    "symbol": sym,
                    "side": d.get("side"),
                    "decision_id": d.get("id"),
                    "decision_status": d.get("status"),
                    "reason": d.get("reason"),
                    "reason_detail": d.get("reason_detail"),
                    "target_qty": target.get("qty"),
                    "target_score": target.get("score"),
                    "target_rank": target.get("rank"),
                    "intent_version": intent_version.get(d.get("intent_id")),
                    "decided_qty": d.get("qty"),
                    "expected_price": d.get("expected_price"),
                    "order_status": None,
                    "qty_filled": None,
                    "avg_fill_price": None,
                }
            )
            for o in order_by_decision.get(d.get("id"), []):
                rows[-1].update(
                    {
                        "order_status": o.get("status"),
                        "qty_filled": o.get("qty_filled"),
                        "avg_fill_price": o.get("avg_fill_price"),
                    }
                )
        return _jsonable(rows)
    finally:
        if conn is None:
            c.close()


def metrics(round_id: int, *, conn: Optional[psycopg.Connection] = None) -> Dict[str, Any]:
    """Roll-up metrics for the round: invested notional, turnover, slippage bps,
    estimated cost and filled count. Safe to call before any fills.

    Cost model mirrors ``reconcile``: per filled share, ``open_cost`` on buys
    and ``close_cost`` on sells (floored at ``min_cost`` per order), slippage
    measured vs the expected price recorded on the linked decision. The
    ``cost_pct_of_gross`` figure is the "is the edge eaten?" number — the ratio
    of total estimated cost to gross traded notional.
    """
    own = conn is None
    c = conn or connect()
    try:
        round_row = get_round(round_id, conn=c)
        if not round_row:
            raise ValueError(f"round {round_id} not found")
        orders = _orders_for_round(round_id, c)
        filled = [o for o in orders if o["status"] in ("filled", "partially_filled")]
        invested = sum(float(o.get("qty_filled") or 0) * float(o.get("avg_fill_price") or 0) for o in filled)
        equity = float(round_row.get("account_equity_at_sizing") or 0) or 0
        snap = round_row.get("strategy_snapshot") or {}
        open_cost = float(snap.get("open_cost") or 0.0005)
        close_cost = float(snap.get("close_cost") or 0.0015)
        min_cost = float(snap.get("min_cost") or 5)

        decision_by_id = {d["id"]: d for d in query_decisions(round_id, conn=c)}
        gross_traded = 0.0
        slippage_bps = 0.0
        slippage_w = 0.0
        cost_est = 0.0
        for o in orders:
            q = float(o.get("qty_filled") or 0)
            px = float(o.get("avg_fill_price") or 0)
            if not q or not px:
                continue
            val = q * px
            gross_traded += val
            dec = decision_by_id.get(o.get("decision_id")) or {}
            expected = dec.get("expected_price")
            if expected:
                ref = float(expected)
                if ref:
                    bp = (px - ref) / ref * 1e4
                    slippage_bps += abs(bp) * val
                    slippage_w += val
            side = (dec.get("side") or "buy").lower()
            rate = close_cost if side == "sell" else open_cost
            cost_est += max(val * rate, min_cost if q else 0)

        return _jsonable(
            {
                "round_id": round_id,
                "placed_orders": len(orders),
                "filled_orders": len([o for o in orders if o["status"] == "filled"]),
                "partially_filled_orders": len([o for o in orders if o["status"] == "partially_filled"]),
                "invested_notional": round(invested, 2),
                "turnover": round(invested / equity, 4) if equity else None,
                "gross_traded_notional": round(gross_traded, 2),
                "slippage_bps": round(slippage_bps / slippage_w, 2) if slippage_w else None,
                "estimated_cost": round(cost_est, 2),
                "cost_pct_of_gross": round(cost_est / gross_traded * 1e4, 2) if gross_traded else None,
                "status": round_row.get("status"),
            }
        )
    finally:
        if conn is None:
            c.close()


# --------------------------------------------------------------------------- CLI

def _cli() -> None:
    parser = argparse.ArgumentParser(description="Round book DB utilities")
    parser.add_argument("cmd", choices=("init", "ls"))
    parser.add_argument("--source", default=None)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    if args.cmd == "init":
        ensure_schema()
        print("round-book schema ready")
        return
    for r in list_rounds(source=args.source, limit=args.limit):
        print(f"#{r['id']} {r['target_date']} {r['source']} {r['status']} {r.get('experiment_name')} run {str(r.get('run_id'))[:8]}")


if __name__ == "__main__":
    _load_repo_env()
    _cli()
