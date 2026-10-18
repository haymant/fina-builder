# The RIGA assistant (chat panel)

The desktop app's **Chat** button opens RIGA's `@rigai/assistant-ui` side panel. All
provider/tool/MCP/session logic lives in the vendored `riga-server`; this repo is only the
adapter that hosts it inside the Tauri shell. The webview never spawns a process.

> **History.** This file previously described a Pi/`llama-cpp-2` "local agent" with its own
> tool registry and a bundled `fina-mcp` sidecar. That subsystem was removed (its commands,
> `src/features/local-agent/` and `src-tauri/src/local_agent.rs` are gone), and the chat is
> now RIGA's assistant-ui over `riga-server`. See `docs/49-merge-fina-to-riga.md` §P5/§P6.

## Layers

```text
src/App.tsx                         @rigai/assistant-ui <AssistantUI> (lazy), theme from the app
  └─ transportFactory               createTauriTransport() in the desktop; default HTTP otherwise
src-tauri/src/riga_agent.rs         the host: IpcService + ServerState, the riga_* IPC commands
  └─ install(app)                   prepares the workspace, registers the vendored engines
src-tauri/src/mcp_commands.rs       riga_mcp_* / tac_mcp_* IPC commands + engine-binary resolution
src-tauri/src/mcp.rs                Rust-owned MCP stdio client (spawn, handshake, tools/*)
modules/riga/                       riga-kernel · riga-server · riga-shell (the agent itself)
modules/riga-flow · tac-engine      the pricing / market-data engines the chat can call
```

`riga_agent.rs` mirrors `modules/riga/demo/src-tauri/src/lib.rs`: one `IpcService` around
`ServerState` powers the commands and events the assistant-ui surface calls.
`riga_kernel::Agent` is managed for a lightweight `kernel_health` probe.

## IPC surface (`src-tauri/src/riga_agent.rs`)

| Group | Commands |
| --- | --- |
| Health / transport | `kernel_health`, `riga_health`, `riga_transport_connect`, `riga_transport_disconnect` |
| Sessions | `riga_catalog`, `riga_list_sessions`, `riga_create_session`, `riga_session_history`, `riga_rename_session` |
| Workspace / git | `riga_workspace_entries`, `riga_workspace_file`, `riga_git_status`, `riga_git_diff`, `riga_git_commit`, `riga_git_push`, `riga_git_log`, `riga_git_commit_diff` |
| Runs | `riga_list_active_runs`, `riga_start_run`, `riga_resume_run`, `riga_cancel_run`, `riga_respond_to_approval` |
| Providers / models | `riga_configure_provider`, `riga_remote_models`, `riga_provider_profiles`, `riga_save_provider_profile`, `riga_delete_provider_profile`, `riga_local_models`, `riga_local_model_action` |
| MCP registry | `riga_list_mcp_registry`, `riga_save_mcp_registry` |
| Attachments | `riga_upload_attachment` |

## The engines as chat tools

At startup, `riga_agent::install` registers the vendored engines with the embedded agent so
the chat can call their tools (`price_put`, `query_execution_net`, `vol_surface`, …). This
merges with any servers the user configured in **Connectors**. The child processes are owned
by `src-tauri/src/mcp.rs`:

- `riga_mcp_list_tools` / `riga_mcp_call_tool` (+ `list_resources` / `read_resource` /
  `list_prompts` / `get_prompt` / `get_task` / `reset`) drive `riga-mcp`.
- `tac_mcp_list_tools` / `tac_mcp_call_tool` / `tac_mcp_reset` drive `tac-engine`.
- `get_riga_mcp_path` / `get_tac_engine_path` resolve the binaries: `RIGA_MCP_BIN` /
  `TAC_ENGINE_BIN`, then `modules/<dir>/target/{release,debug}`, then a bundled sidecar.

The frontend reaches the engines through the same transports the tiles use
(`src/api/rigaTransport.ts`, `src/api/tacTransport.ts`) — Tauri IPC in the desktop, HTTP
(`/riga/mcp`, `/tac/mcp`) in the browser.

## Environment and secrets

The shell loads `.env` files (app-data, repo root, `modules/tac-engine/.env`,
`modules/riga-flow/.env`) and forwards them to the engine children. **Keys live in the host
environment or a user-owned `.env` only** — they never appear in the UI, logs or persisted
state, and the market-data tiles never fall back to fake data.

The workspace root defaults to the repository the app was launched from, so the agent browsed
worktrees match the desktop. `RIGA_WORKSPACE_ROOT` overrides it.

## Session storage

Agent transcripts are persisted under the OS app-data directory by `riga-server` (JSONL
sessions). The panel exposes history via `showSessionHistoryButton`.

## Non-goals / cautions

- The assistant is only available in the **desktop** build; the browser build has no chat.
- The chat's engine tools are a demonstrator surface. They must not be treated as
  market-calibrated prices, official valuations, risk limits, or investment advice.
- Do not expose shell spawning to the webview. Process ownership stays in `src-tauri`.
- To add another MCP server, register it in `Connectors` (or extend `riga_agent::install`);
  the frontend wrappers stay generic.
