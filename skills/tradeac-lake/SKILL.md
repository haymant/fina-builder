---
name: tradeac-lake
description: Use tac-engine named lake operations for coverage, calendar backfill, lazy bars, features, and dataset freshness. Use for TAC algorithm-trade and R&D data preparation.
---

# TradeAC lake compatibility entrypoint

This is the workspace-root compatibility entrypoint for the detailed repository skill at `modules/tac-engine/skills/tradeac-lake/SKILL.md`. Load this skill by id; do not search for the module path.

Use named tac-engine MCP tools only: `get_lake_status`, `get_lake_coverage`, `get_lake_calendar`, `backfill_lake_calendar`, `get_lake_bars`, `load_lake_symbols`, `load_lake_status`, and `validate_lake_dataset`. For persistence/backfill use `quiet=true`; for required data reads omit it. Never hand-write parquet, fabricate bars, or read secrets from `.env` files. If a named tool is unavailable, return `tool_unavailable` and stop the fast path.
