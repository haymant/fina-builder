"""Trace tools for the tac-qlib-rd MCP server — replace the `trace.sh`/`trace_db.py`/`git_exp.sh` scripts.

The R&D lineage (`/rd/lineage`) and the round book build on the `rd_experiments`
Postgres table. This module exposes the full trace lifecycle as MCP tools so an
agent can drive tracing through the long-lived tac-qlib-rd server instead of
shelling out to bash scripts (which re-import psycopg + reconnect per call and
force the agent to parse prose output).

Because the server is long-lived, `psycopg` is imported and the DB connection
is opened once per call (not once per script invocation), and every tool returns
a single JSON object — no output parsing, fully deterministic.

Git operations (fork / commit / push on the `experiments/` clone) are performed
via `git` subprocess with the repo's mandated credential helper, exactly as the
old `git_exp.sh` did.

Env (from the repo `.env`, already loaded by rd_server): DATABASE_URL,
EMBEDDING_API_BASE_URL, EMBEDDING_API_KEY, GIT_USER, GIT_PASS, GIT_REPO_URL,
TAC_LAKE_DIR.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import psycopg
from psycopg.rows import dict_row

from tac_qlib.trace_embed import embed

EMBEDDING_DIM = 384
_MIN_SCORE = 0.5


# --------------------------------------------------------------------------- db
def _conn():
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(url, row_factory=dict_row)


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _vector_literal(vec: Optional[List[float]]) -> Optional[str]:
    if not vec:
        return None
    return "[" + ",".join(repr(float(v)) for v in vec) + "]"


def _jsonable(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_jsonable(v) for v in obj]
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return obj


def _row_json(row: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in row.items():
        if k in ("rational_embedding", "details_embedding"):
            out[k] = v.tolist() if hasattr(v, "tolist") else v
        elif k == "metrics" and isinstance(v, str):
            try:
                out[k] = json.loads(v)
            except Exception:  # noqa: BLE001
                out[k] = v
        else:
            out[k] = v
    return out


def _get_row(exp_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM rd_experiments WHERE id = %s", (exp_id,))
        return cur.fetchone()


def _all_rows(limit: int) -> List[Dict[str, Any]]:
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM rd_experiments ORDER BY id DESC LIMIT %s", (limit,))
        return cur.fetchall()


def _init_db() -> None:
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
        if not cur.fetchone():
            raise RuntimeError("pgvector extension is not installed. Run: CREATE EXTENSION IF NOT EXISTS vector;")
        cur.execute("SELECT to_regclass('public.rd_experiments')")
        exists = bool(cur.fetchone())
        if not exists:
            DDL = """
            CREATE TABLE IF NOT EXISTS rd_experiments (
                id bigserial PRIMARY KEY NOT NULL,
                experiment_name text,
                rational text NOT NULL,
                rational_embedding vector(384),
                details text,
                details_embedding vector(384),
                evaluation text,
                metrics jsonb,
                evolved_from bigint,
                start_ts timestamptz DEFAULT now() NOT NULL,
                end_ts timestamptz,
                git_branch text NOT NULL,
                experiment_ref_id text,
                session_id text,
                mlruns_dir text,
                status text DEFAULT 'starting' NOT NULL,
                created_at timestamptz DEFAULT now() NOT NULL,
                updated_at timestamptz DEFAULT now() NOT NULL
            );
            """
            for stmt in DDL.split(";"):
                stmt = stmt.strip()
                if stmt:
                    cur.execute(stmt)
        # Idempotent backfills so pre-existing tables gain new columns.
        for stmt in ["ALTER TABLE rd_experiments ADD COLUMN IF NOT EXISTS session_id text;"]:
            stmt = stmt.strip()
            if stmt:
                cur.execute(stmt)
        conn.commit()


def _search_evolved_from(text: str, limit: int = 5) -> Optional[int]:
    vec = embed(text)
    if not vec:
        return None
    lit = _vector_literal(vec)
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, 1 - LEAST(
                COALESCE(rational_embedding <=> %s::vector, 1),
                COALESCE(details_embedding   <=> %s::vector, 1)
            ) AS similarity
            FROM rd_experiments
            ORDER BY similarity DESC
            LIMIT %s
            """,
            (lit, lit, limit),
        )
        rows = cur.fetchall()
    for row in rows:
        if row["similarity"] is not None and float(row["similarity"]) >= _MIN_SCORE:
            return int(row["id"])
    return None


def _search(query: str, limit: int = 10, min_score: float = _MIN_SCORE) -> List[Dict[str, Any]]:
    vec = embed(query)
    if not vec:
        needle = f"%{query.replace('%', ' ').strip()}%"
        with _conn() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, rational, details, git_branch, experiment_ref_id, status,
                       start_ts, end_ts, evaluation, session_id
                FROM rd_experiments
                WHERE rational ILIKE %s OR details ILIKE %s
                ORDER BY id DESC LIMIT %s
                """,
                (needle, needle, limit),
            )
            return [_row_json(r) for r in cur.fetchall()]
    lit = _vector_literal(vec)
    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, rational, details, git_branch, experiment_ref_id, status,
                   start_ts, end_ts, evaluation, session_id,
                   1 - LEAST(
                       COALESCE(rational_embedding <=> %s::vector, 1),
                       COALESCE(details_embedding   <=> %s::vector, 1)
                   ) AS similarity
            FROM rd_experiments
            ORDER BY similarity DESC
            LIMIT %s
            """,
            (lit, lit, limit),
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        sim = float(r.get("similarity") or 0)
        if sim < min_score:
            continue
        r = dict(r)
        r["similarity"] = sim
        out.append(_row_json(r))
    return out


def _start(
    rational: str,
    details: str = "",
    evolved_from: str = "none",
    experiment_name: str = "",
    branch: str = "",
    session_id: str = "",
) -> Dict[str, Any]:
    rational = rational.strip()
    details = (details or "").strip()
    if not rational:
        raise ValueError("--rational is required")

    rational_vec = _vector_literal(embed(rational))
    details_vec = _vector_literal(embed(details)) if details else None

    evo: Optional[int] = None
    if evolved_from == "auto":
        evo = _search_evolved_from(f"{rational}\n{details}") if rational_vec or details_vec else None
    elif evolved_from and evolved_from.isdigit():
        evo = int(evolved_from)

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO rd_experiments
                (experiment_name, rational, rational_embedding, details, details_embedding,
                 evolved_from, start_ts, git_branch, status, session_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'starting', %s)
            RETURNING id
            """,
            (
                experiment_name or None,
                rational,
                rational_vec,
                details,
                details_vec,
                evo,
                _now_iso(),
                branch or "",
                session_id.strip() or None,
            ),
        )
        row = cur.fetchone()
        exp_id = int(row["id"])
        conn.commit()

    branch = branch or f"exp/{exp_id}"
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE rd_experiments SET git_branch = %s WHERE id = %s", (branch, exp_id))
        conn.commit()
    return _row_json(_get_row(exp_id) or {})


def _finish(
    exp_id: int,
    ref_id: str = "",
    evaluation: Optional[str] = None,
    metrics: Optional[str] = None,
    mlruns_dir: str = "",
    experiment_name: str = "",
    rational: Optional[str] = None,
    details: Optional[str] = None,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    row = _get_row(exp_id)
    if not row:
        raise ValueError(f"experiment {exp_id} not found")

    fields: List[str] = []
    params: List[Any] = []
    status = status or "done"
    if status is None and row.get("status") in ("starting", "running"):
        status = "done"

    rational = (rational or row.get("rational") or "").strip()
    details = (details if details is not None else row.get("details") or "").strip()

    fields.append("rational = %s"); params.append(rational)
    fields.append("rational_embedding = %s"); params.append(_vector_literal(embed(rational)))
    fields.append("details = %s"); params.append(details)
    fields.append("details_embedding = %s"); params.append(_vector_literal(embed(details)) if details else None)
    if evaluation is not None:
        fields.append("evaluation = %s"); params.append(evaluation.strip())
    if metrics is not None:
        fields.append("metrics = %s"); params.append(json.dumps(json.loads(metrics)))
    if ref_id:
        fields.append("experiment_ref_id = %s"); params.append(ref_id.strip())
    if mlruns_dir:
        fields.append("mlruns_dir = %s"); params.append(mlruns_dir.strip())
    if experiment_name:
        fields.append("experiment_name = %s"); params.append(experiment_name.strip())
    fields.append("status = %s"); params.append(status)
    fields.append("end_ts = %s"); params.append(_now_iso())
    fields.append("updated_at = %s"); params.append(_now_iso())
    params.append(exp_id)

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE rd_experiments SET {', '.join(fields)} WHERE id = %s", params)
        conn.commit()
    return _row_json(_get_row(exp_id) or {})


def _mlruns_dir(exp_name: str) -> str:
    uri = (os.environ.get("DATABASE_URL") or "").strip()
    if uri.startswith("postgres://"):
        uri = "postgresql+psycopg://" + uri[len("postgres://") :]
    if uri.startswith("postgresql://") or uri.startswith("postgresql+psycopg://"):
        with _conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT artifact_location FROM experiments WHERE name = %s", (exp_name,))
            row = cur.fetchone()
        if not row:
            raise RuntimeError(f"mlflow experiment {exp_name!r} not found")
        return row["artifact_location"]

    lake = (os.environ.get("TAC_LAKE_DIR") or "").strip()
    if not lake:
        raise RuntimeError("TAC_LAKE_DIR not set")
    db_path = Path(lake) / "mlruns.db"
    if not db_path.exists():
        raise RuntimeError(f"mlruns.db not found at {db_path}")
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT artifact_location FROM experiments WHERE name = ?", (exp_name,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError(f"mlflow experiment {exp_name!r} not found in {db_path}")
    return row[0]


# --------------------------------------------------------------------------- git
def _parent_root() -> Path:
    start = Path.cwd()
    dir = start
    while dir != Path(dir.anchor):
        if (dir / "pnpm-workspace.yaml").exists() or (dir / "Cargo.toml").exists() or (dir / "opencode.json").exists():
            return dir
        dir = dir.parent
    raise RuntimeError("not inside a tradeac workspace")


def _gitc(*args: str) -> subprocess.CompletedProcess:
    root = _parent_root()
    exp = root / "experiments"
    user = (os.environ.get("GIT_USER") or "").strip()
    password = (os.environ.get("GIT_PASS") or "").strip()
    helper = f'!f() {{ echo "username={user}"; echo "password={password}"; }}; f'
    cmd = ["git", "-C", str(exp), "-c", f"credential.helper={helper}"] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True)


def _git_ok(proc: subprocess.CompletedProcess) -> bool:
    return proc.returncode == 0


def _git_out(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout or "").strip() or (proc.stderr or "").strip()


def _require_auth() -> None:
    if not (os.environ.get("GIT_REPO_URL") or "").strip() or not (os.environ.get("GIT_USER") or "").strip():
        raise RuntimeError("GIT_REPO_URL / GIT_USER not set")


def _ensure_repo() -> None:
    root = _parent_root()
    exp = root / "experiments"
    if (exp / ".git").exists():
        _gitc("remote", "set-url", "origin", os.environ["GIT_REPO_URL"])
    else:
        _require_auth()
        (root / "experiments").mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", "-q", os.environ["GIT_REPO_URL"], str(exp)],
            check=True, capture_output=True, text=True,
        )
    _gitc("config", "user.email", f"{os.environ.get('GIT_USER', '')}@tradeac.local")
    _gitc("config", "user.name", os.environ.get("GIT_USER", "tradeac-agent"))


def _ensure_base(base: str = "main") -> str:
    _require_auth()
    _gitc("fetch", "origin", base)
    if _git_ok(_gitc("rev-parse", "--verify", f"origin/{base}")):
        return f"origin/{base}"
    if _git_ok(_gitc("rev-parse", "--verify", base)):
        return base
    return base


def _fork_branch(base_ref: str, branch: str) -> str:
    if _git_ok(_gitc("rev-parse", "--verify", f"origin/{branch}")):
        _gitc("checkout", "-q", "-B", branch, f"origin/{branch}")
        _gitc("reset", "-q", "--hard", f"origin/{branch}")
        return "reused existing branch"
    _gitc("fetch", "-q", "origin")
    if _git_ok(_gitc("rev-parse", "--verify", f"origin/{branch}")):
        _gitc("checkout", "-q", "-B", branch, f"origin/{branch}")
        return "reused existing branch"
    base_commit = ""
    if _git_ok(_gitc("rev-parse", "--verify", f"{base_ref}^{{commit}}")):
        base_commit = base_ref
    elif not base_ref.startswith("origin/"):
        base_commit = f"origin/{base_ref}"
    if not base_commit:
        raise RuntimeError(f"base '{base_ref}' not found locally or on origin")
    _gitc("checkout", "-q", "-B", branch, base_commit)
    return f"forked from {base_ref}"


def _snapshot_code(paths: Optional[List[str]] = None) -> str:
    root = _parent_root()
    exp = root / "experiments"
    paths = paths or ["tac-qlib/tac_qlib/contrib", "tac-qlib/tac_qlib/data"]
    parent_head = _git_out(_gitc("rev-parse", "HEAD")) or "unknown"
    import shutil

    shutil.rmtree(exp / "code", ignore_errors=True)
    (exp / "code").mkdir(parents=True, exist_ok=True)
    manifest = [f"# TradeAC custom-qlib-code snapshot (auto-generated)", f"# parent repo HEAD : {parent_head}"]
    for p in paths:
        manifest.append(f"#   {p}")
    manifest.append("# per-file hashes (git hash-object):")
    for p in paths:
        src = root / p
        if not src.exists():
            continue
        dst = exp / "code" / p
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
            for f in sorted(src.rglob("*")):
                if f.is_file():
                    rel = str(f.relative_to(root))
                    h = _git_out(_gitc("hash-object", str(f)))
                    manifest.append(f"  {h}  {rel}")
        else:
            shutil.copy2(src, dst)
            h = _git_out(_gitc("hash-object", str(src)))
            manifest.append(f"  {h}  {p}")
    (exp / "code" / "MANIFEST.txt").write_text("\n".join(manifest) + "\n")
    return f"code snapshotted -> experiments/code (parent @ {parent_head[:12]})"


def _commit(message: str) -> str:
    _gitc("add", "-A")
    if _git_ok(_gitc("diff", "--cached", "--quiet")):
        return "nothing to commit"
    _gitc("commit", "-q", "-m", message)
    return "committed"


def _commit_push(message: str) -> str:
    result = _commit(message)
    if result == "nothing to commit":
        return result
    branch = _git_out(_gitc("branch", "--show-current"))
    _require_auth()
    proc = _gitc("push", "-u", "origin", branch)
    if not _git_ok(proc):
        raise RuntimeError(f"push failed: {_git_out(proc)}")
    return f"pushed {branch}"


def _parent_changes() -> str:
    root = _parent_root()
    proc = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], capture_output=True, text=True)
    out = (proc.stdout or "").strip()
    if not out:
        return "parent repo clean (no changes)"
    lines = out.splitlines()
    filtered = [
        l for l in lines
        if not l.startswith(".. experiments/")
        and not l.startswith("?? experiments/")
        and not l.startswith(".. tac-qlib/tac_qlib/contrib/")
        and not l.startswith(".. tac-qlib/tac_qlib/data/")
        and not l.startswith("?? tac-qlib/tac_qlib/contrib/")
        and not l.startswith("?? tac-qlib/tac_qlib/data/")
    ]
    expected = [l for l in lines if l.startswith(".. tac-qlib/tac_qlib/contrib/") or l.startswith(".. tac-qlib/tac_qlib/data/")]
    note = ""
    if expected:
        note = "note: custom qlib code changed in the parent repo (contrib/data) — snapshotted to the experiment branch via trace snapshot:\n" + "\n".join(expected)
    if not filtered:
        return "parent repo changes limited to experiments/ and snapshotted custom qlib code (ok)" + (f"\n{note}" if note else "")
    return "WARNING: unexpected parent-repo changes outside the experiments/ clone:\n" + "\n".join(filtered) + "\n→ review and revert before finishing" + (f"\n{note}" if note else "")


def slugify(text: str) -> str:
    s = "".join(c for c in text.lower() if c.isalnum() or c in " -").replace(" ", "-")
    return s[:40].strip("-")


def get_experiment_branch(exp_id: int) -> str:
    row = _get_row(exp_id)
    if not row:
        raise ValueError(f"experiment {exp_id} not found")
    return row["git_branch"] or f"exp/{exp_id}"


# --------------------------------------------------------------------------- MCP tools
def rd_trace_init() -> dict:
    """Ensure the traceability store + experiments git repo are ready (rd_experiments table, base main)."""
    _init_db()
    _ensure_repo()
    base = _ensure_base("main")
    return {"status": "ready", "base": base}


def rd_trace_start(
    rational: str,
    details: str = "",
    experiment_name: str = "",
    evolved_from: str = "none",
    session_id: str = "",
) -> dict:
    """Open a traced experiment: insert the rd_experiments row, resolve evolved_from, fork + push the experiment branch. Pass `session_id` (the opencode chat id) so the lineage keeps a stable chat link. Returns experiment_id / branch / evolved_from / base_branch as one JSON object."""
    _init_db()
    _ensure_repo()

    evo_id = evolved_from
    if evolved_from == "auto":
        evo_id = str(_search_evolved_from(rational) or "")

    row = _start(rational, details, evolved_from=evo_id or "none", experiment_name=experiment_name, session_id=session_id)
    exp_id = int(row["id"])
    branch = f"exp/{exp_id}-{slugify(rational)}"
    _gitc("checkout", "-q", "-B", branch, "main") if False else None

    # fork from the predecessor branch (or main)
    base_branch = "main"
    if evo_id and evo_id.isdigit():
        base_branch = get_experiment_branch(int(evo_id))
    base_ref = _ensure_base(base_branch)
    _fork_branch(base_ref, branch)
    _snapshot_code()
    _gitc("checkout", "-q", "-B", branch, branch) if False else None

    # persist branch on the row
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE rd_experiments SET git_branch = %s WHERE id = %s", (branch, exp_id))
        conn.commit()

    _commit_push(f"start experiment {exp_id} ({branch})")
    return {"experiment_id": exp_id, "branch": branch, "evolved_from": evo_id or "none", "base_branch": base_branch}


def rd_trace_finish(
    experiment_id: int,
    ref_id: str = "",
    evaluation: str = "",
    metrics: str = "",
    mlruns_dir: str = "",
    experiment_name: str = "",
) -> dict:
    """Close a traced experiment: update the row (link the mlflow run, metrics/evaluation/end_ts), snapshot code, commit + push the branch. Returns the updated row."""
    _finish(experiment_id, ref_id=ref_id, evaluation=evaluation or None, metrics=metrics or None, mlruns_dir=mlruns_dir, experiment_name=experiment_name)
    branch = get_experiment_branch(experiment_id)
    _gitc("checkout", "-q", "-B", branch, branch)
    _snapshot_code()
    _commit_push(f"finish experiment {experiment_id} ({branch})")
    return {"experiment_id": experiment_id, "branch": branch, "row": _row_json(_get_row(experiment_id) or {})}


def rd_trace_commit(experiment_id: int, message: str = "wip") -> dict:
    """Commit the current experiment branch state (no push)."""
    branch = get_experiment_branch(experiment_id)
    _gitc("checkout", "-q", "-B", branch, branch)
    result = _commit(f"exp {experiment_id}: {message}")
    return {"experiment_id": experiment_id, "branch": branch, "result": result}


def rd_trace_snapshot(experiment_id: int, paths: str = "") -> dict:
    """Snapshot custom qlib contrib/data code onto the experiment branch (default contrib+data)."""
    branch = get_experiment_branch(experiment_id)
    _gitc("checkout", "-q", "-B", branch, branch)
    path_list = [p.strip() for p in paths.split(",") if p.strip()] if paths else None
    msg = _snapshot_code(path_list)
    _commit_push(f"exp {experiment_id}: snapshot custom qlib code")
    return {"experiment_id": experiment_id, "branch": branch, "result": msg}


def rd_trace_guard() -> dict:
    """Check the parent repo for unexpected changes outside the experiments clone."""
    return {"parent_changes": _parent_changes()}


def rd_trace_search(query: str, limit: int = 10, min_score: float = _MIN_SCORE) -> dict:
    """Semantic search over experiment rationals/details (pgvector, falls back to ILIKE)."""
    return {"results": _search(query, limit=limit, min_score=min_score)}


def rd_trace_get(experiment_id: int) -> dict:
    """Return one traced experiment row."""
    row = _get_row(experiment_id)
    if not row:
        raise ValueError(f"experiment {experiment_id} not found")
    return _row_json(row)


def rd_trace_list(limit: int = 20) -> dict:
    """List traced experiments (newest first)."""
    return {"experiments": [_row_json(r) for r in _all_rows(limit)]}


def rd_trace_mlruns_dir(experiment_name: str) -> dict:
    """Resolve the mlflow artifact location for an experiment name."""
    return {"mlruns_dir": _mlruns_dir(experiment_name)}


def register_trace_tools(server) -> None:
    """Attach all rd_trace_* tools to an MCPServer instance (called by rd_server.main())."""
    for fn in (
        rd_trace_init,
        rd_trace_start,
        rd_trace_finish,
        rd_trace_commit,
        rd_trace_snapshot,
        rd_trace_guard,
        rd_trace_search,
        rd_trace_get,
        rd_trace_list,
        rd_trace_mlruns_dir,
    ):
        server.tool(structured_output=False)(fn)
