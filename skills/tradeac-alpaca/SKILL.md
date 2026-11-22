---
name: tradeac-alpaca
description: Use tac-engine named MCP tools for paper-account equity, positions, orders, quotes, snapshots, and news with conservative execution guardrails. Use for TAC algorithm-trade.
---

# TradeAC Alpaca compatibility entrypoint

This is the workspace-root compatibility entrypoint for the detailed repository skill at `modules/tac-engine/skills/tradeac-alpaca/SKILL.md`. Load this skill by id; do not search for the module path.

Use `get_account`, `list_positions`, `list_orders`, `get_stock_snapshot`/quote tools, `get_news`, and `place_order` through the tac-engine MCP server. Use paper mode only. Never call raw Alpaca REST or print `APCA_*` values. Missing/stale/illiquid/ halted quotes are skips. News conflicts cancel BUY at sentiment <= -2 and SELL at sentiment >= +2; record the exact reason and never infer missing sentiment.
