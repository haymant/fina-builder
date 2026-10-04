# Local Agent — Design and Developer Guide

This document describes the **implemented** desktop local-agent feature and is intended as a code-navigation and extension guide. The Rust and TypeScript source remains authoritative if this guide and code diverge.

## Purpose and scope

The local assistant gives a user of the Fina Builder desktop app a chat interface for asking questions about the project's deterministic, synthetic payoff analytics. It runs model inference on the user's device and exposes kernel queries to the agent: three built-in tools invoked directly, plus every tool advertised by the bundled `fina-mcp` stdio server.

This is a local demonstrator, not a production pricing, valuation, or risk system. Its model output can be inaccurate, and kernel outputs are synthetic/illustrative. The agent must not present them as market-calibrated numbers or trading advice.

**Current scope:** Tauri desktop only. The browser + HTTP build does not have access to the native model runtime; opening Chat there shows a desktop-only notice. Model downloads require internet, but prompt inference does not use a hosted model API.

## Architecture at a glance

```text
Workspace header: Chat
    │ onOpenLocalAgent
    ▼
App.tsx: lazy-load LocalAgentPanel on first open; keep mounted after first open
    │
    ├── assistant-ui LocalRuntime + chat primitives
    │       │ custom ChatModelAdapter (piLocalRuntime.ts)
    │       ▼
    │   Pi Agent per assistant-ui thread
    │       ├── built-in read-only Tauri/kernel tools
    │       ├── fina-mcp tools (via Rust-owned MCP process)
    │       └── custom streamFn
    │               │ Tauri invoke + `llm-token` events
    ▼               ▼
LocalAgentPanel ─── Tauri IPC ─── src-tauri/src/local_agent.rs
                                      ├── model catalog/download/verification
                                      ├── app-data models/config/session files
                                      └── llama-cpp-2 in-process inference
                                               │
                                               ▼
                                      loaded GGUF + embedded chat template

piLocalRuntime ── Tauri IPC (mcp_list_tools / mcp_call_tool)
      │
      ▼
src-tauri/src/mcp.rs ── spawns + owns fina-mcp stdio process
                                      │ JSON-RPC initialize/tools/list/tools/call
                                      ▼
                            crates/fina-mcp (stdio JSON-RPC)
                                      │ dispatch_sync
                                      ▼
                                  fina-kernel
```

The local-agent subsystem is separate from the kernel's financial/domain logic. Existing Tauri commands under `src-tauri/src/commands/` remain adapters to `fina-kernel`; local-agent commands manage desktop infrastructure and invoke the native model runtime. The `crates/fina-mcp` stdio server **is** connected: the Rust runtime (`src-tauri/src/mcp.rs`) spawns and owns the process, performs the MCP handshake, and exposes `mcp_list_tools` / `mcp_call_tool` to the frontend. The three built-in kernel tools remain as a fast path that does not depend on the server.

## Source map and ownership

| File | Responsibility |
| --- | --- |
| `src/features/workspace/components/Workspace.tsx` | Adds the Chat launcher in the workspace header. |
| `src/App.tsx` | Opens the panel and lazy-loads its chunk only after first use. It retains the panel component after first open so its in-memory runtime survives closing/reopening the drawer during the app process. |
| `src/features/local-agent/LocalAgentPanel.tsx` | Model discovery/catalog UI, download progress and cancellation, load/change model, open model directory, chat rendering, composer (icon send/stop, model picker), header new-chat and chat-history controls, and user-visible errors. |
| `src/features/local-agent/piLocalRuntime.ts` | Pi Agent tools/system prompt, MCP tool loading and merge, skills injection, robust tool-request parsing, per-session Agent map, per-session assistant-ui adapter factory, stored-message→thread-message mapping for restore, Tauri token-event subscription, and native inference calls. |
| `src/features/local-agent/mcpClient.ts` | Thin Tauri-command wrapper for `mcp_list_tools` / `mcp_call_tool`, memoized tool list, and MCP-tool→`AgentTool` adaptation. |
| `src/features/local-agent/ComposerSourceMenu.tsx` | Composer `+` menu: MCP server → tools drill-down, skills list, and `/{name}` insertion. |
| `src/features/local-agent/ToolCallDisclosure.tsx` | Assistant-ui Tool call element: collapsed tool-call row that expands to request/result. |
| `src/features/local-agent/skills.ts` | Frontend helper types and Tauri wrappers for file-based skills (`list_agent_skills`, `skills_dir`). |
| `src-tauri/src/skills.rs` | Scans `skills/*/SKILL.md`, parses YAML frontmatter, and returns skill records. |
| `skills/<name>/SKILL.md` | Skill definitions (frontmatter + instruction body). |
| `src-tauri/src/local_agent.rs` | Catalog source of truth, local filesystem operations, model download/verification, loaded-model state, inference/cancellation, session/config JSONL, and MCP server path resolution plus commands. |
| `crates/fina-mcp/src/main.rs` | Newline-delimited JSON-RPC 2.0 MCP stdio server dispatching to `fina-kernel`'s shared command dispatcher. |
| `src-tauri/src/mcp.rs` | Rust-owned `fina-mcp` process: spawn, MCP handshake, `tools/list`, `tools/call`, and reconnect. |
| `scripts/build-mcp-sidecar.sh` | Builds `fina-mcp` and stages it as a triple-suffixed Tauri sidecar under `src-tauri/binaries/`. |
| `src-tauri/src/lib.rs` | Owns `LocalAgentRuntime` as Tauri state and registers the local-agent commands alongside the app's other commands. |
| `src-tauri/capabilities/default.json` | Tauri permissions: `core:default` plus the model-directory opener. No shell permissions (Rust owns the MCP process). |

## Runtime and data flow

### 1. Opening the panel

The Chat button calls `onOpenLocalAgent`. `App.tsx` marks the panel as previously opened and sets it open. The component is lazy-imported through `React.lazy`; after it has first loaded, closing the visual drawer hides its DOM but keeps the component/runtime in the tree. This is why an in-process conversation can survive a drawer close/reopen, but it is **not** restored after restarting the desktop app.

The panel detects Tauri through `window.__TAURI_INTERNALS__`. In non-Tauri browser mode it displays an availability notice and does not call the native model commands.

The chat composer follows the assistant-ui composer convention: text field plus a toolbar row with a `+` source menu and the model picker on the left and a round send icon button that swaps to a stop (square) icon while a run is in flight. Changing the active model and opening the model manager both live in that toolbar / its popover. The `+` menu (`ComposerSourceMenu`) is a click-through drill-down: `MCP server` → the registered server → its tools, and `Skills` → the discovered `SKILL.md` list. Clicking a tool or skill inserts `/{name}` into the composer; skills also have a checkbox that toggles their instructions into the system prompt. When the server is unavailable the MCP branch shows the error and a retry button. `New chat` and a chat-history browser are icon buttons in the panel header.

Skills are **file-based**: the Rust `list_agent_skills` command scans `skills/<skill-name>/SKILL.md`, parses YAML frontmatter (`name`, `description`) and treats the markdown body as the instructions. The **skill name is its directory name** — a frontmatter `name` that disagrees is ignored, so `/{name}` insertion always matches the id. The directory is rescanned when the panel opens and via the menu's `Rescan skills` action, so edits are picked up without a rebuild; there is no caching that would hide updates. In development the workspace `skills/` directory is read; a packaged build reads its app-data `skills/` copy. Toggling a skill injects only its instructions into the system prompt; skills never grant capabilities. The active set is per-panel state passed into the adapter.

### 2. Model discovery, download, and loading

`src-tauri/src/local_agent.rs` owns a curated catalog of eight Q4_K_M GGUF models (Qwen2.5 1.5B/3B, Gemma 2 2B, Llama 3.2 3B, Phi-3.5 Mini, Phi-4 Mini 3.8B, Gemma 3n E2B, Qwen3 4B). Each entry includes an ID, exact filename, HTTPS download URL, expected byte count, SHA-256, context window, chat-template note, and upstream license/terms URL. The panel renders metadata from `curated_model_catalog`; the Rust catalog is the source of truth. Add catalog entries only with a verified artifact: the size and SHA-256 must match the upstream file exactly.

The catalog's `max_context` is read from the `*.context_length` key of the exact GGUF the entry downloads, not from the model card — the two disagree (`Qwen/Qwen3-4B` ships a 40960-token `config.json` but a 32768-token GGUF) and llama.cpp reads the GGUF. Re-verify it whenever a download URL is repointed.

All model files must live inside the Tauri app-data `models/` directory. `list_local_models` discovers `.gguf` files in that directory; unknown/manual files are listed by filename and have no curated license/context metadata. `load_model` canonicalizes the path and rejects files outside that directory or files that are not `.gguf`.

Curated download flow:

1. The UI invokes `start_model_download` with a catalog ID; duplicate in-progress downloads of the same model are rejected.
2. Rust streams the HTTPS response into `<model filename>.part`, emitting `model-download-progress` events.
3. Cancellation uses a `CancellationToken`. Cancellation or another failure removes the partial file and emits `model-download-error`.
4. On completion, Rust verifies both the exact catalogued byte count and SHA-256. Only a verified file is renamed to its final `.gguf` filename and announced by `model-download-finished`.

Downloads are not resumable. Do not weaken the size/hash/path checks when changing this flow. Update catalog metadata only after verifying the new upstream artifact and license.

`load_model` uses `spawn_blocking` to load the GGUF through `llama-cpp-2`, and replaces the loaded model only after a successful load. The process-wide `LlamaBackend` is initialized at most once and cached in the `LocalAgentRuntime` (`OnceLock<Arc<LlamaBackend>>`), so repeated load/change-model actions reuse it instead of failing with `BackendAlreadyInitialized`. Catalog models run at their own window; other GGUFs start from `DEFAULT_CONTEXT`. Either way `resolve_context` clamps against the GGUF's own `n_ctx_train()` (authoritative — it comes from the file on disk), caps at `MAX_CONTEXT` 32768, and floors at `MIN_CONTEXT` 1024. `MAX_CONTEXT` exists because a 128k window on a 3B model needs roughly 15 GB of KV cache: llama.cpp would silently spill the cache to system RAM and every token would crawl. The preferred model path is written to app-data `config.json` as `preferredModelPath`. The path is a selection hint: startup does **not** auto-load the preferred model.

### 3. Chat turn, streaming, and tools

`LocalAgentPanel` provides assistant-ui chat primitives and creates a runtime per active chat session with `useLocalRuntime(createLocalAgentAdapter({ sessionId, initialMessages, onSaved }))`. The adapter in `piLocalRuntime.ts` creates/reuses one Pi `Agent` per session id in a module-level `Map`; the session id is the assistant-ui thread identity and the Rust session file name. Pi agent orchestration and assistant-ui run in the embedded TypeScript webview; native token generation and model storage are Rust/Tauri responsibilities.

The custom Pi `streamFn`:

1. Subscribes to `llm-token` before starting inference and filters events by a generated `generationId`.
2. Calls `run_local_inference` with transcript messages and a frontend maximum of 512 output tokens.
3. Relays cumulative text updates from native token events into Pi/assistant-ui. The native command ultimately resolves with the completed text.
4. Maps assistant-ui abort to `cancel_local_inference`; Rust checks an `AtomicBool` between generated tokens and returns the partial text accumulated so far.

Rust uses the GGUF's embedded chat template (`chat_template` plus `apply_chat_template`) and tokenizes the result. `resolve_max_tokens` clamps the requested output to the room the prompt leaves in the context, shrinking a long-prompt request instead of rejecting it; only a prompt that fills the context outright is refused, with `The prompt already fills the N-token context`. The sampler is temperature 0.25 followed by `dist(42)`. A fresh inference context is created per request.

**Decode batch is decoupled from the context.** `n_batch`/`n_ubatch` are `min(context_size, MAX_DECODE_BATCH)`, never the context itself, because llama.cpp sizes its compute buffers from `n_ubatch` — tying them to `n_ctx` turns a 32k window into a multi-gigabyte activation buffer. They still have to cover the largest single `llama_decode` call, or llama.cpp trips a GGML_ASSERT and aborts the whole process rather than returning an error, so the prompt is evaluated in `chunks(batch_size)` with logits requested only on its final token. That breaks the old sampler index: after a chunked evaluation `batch.n_tokens()` is the last chunk's length, not the prompt's, so the row to sample from is tracked explicitly in `sample_row`.

**Concurrency:** the loaded engine is held behind `Arc<Mutex<Option<LoadedModel>>>`, and inference holds its mutex guard while generating. This serializes inference on the loaded model; it is not a multi-session parallel serving runtime. Design any concurrency changes around llama context/model lifetime, memory limits, cancellation, and explicit request admission.

#### Agent tools

The agent loadout has two sources, resolved on the first prompt of each adapter:

**Built-in tools** (no MCP dependency), invoked directly through Tauri:

| Tool | Tauri command | Result source |
| --- | --- | --- |
| `get_branch_stats` | `get_branch_stats` | Branch statistics from the kernel demo bundle. |
| `get_distributions` | `get_distributions` | Payoff distribution summary from the kernel demo bundle. |
| `get_mc_diagnostics` | `get_mc_diagnostics` | Kernel's illustrative MC diagnostics. |

**MCP tools**, every tool `fina-mcp` advertises via `tools/list` (currently all twelve kernel commands: `generate_paths`, `get_path`, `get_branch_stats`, `get_distributions`, `compute_trade_analytics`, `compute_risk`, `get_mc_diagnostics`, `build_cashflows`, `valuation_explain`, `explain_ledger`, `execution_events`, `health`). `piLocalRuntime.loadMcpTools` calls `mcp_list_tools` and wraps each tool as a pi-agent-core `AgentTool` named `mcp_<tool>` (providers cap tool names at 64 chars of `[A-Za-z0-9_-]`). If the server cannot start, the chat logs a warning and continues with only the built-in tools.

The chat does not yet pass the UI's edited trade/market settings into these tools; MCP calls that take `trade`/`market` arguments must supply them in the tool arguments.

#### Payload limits

A single `get_path` call returns a whole payoff path: ~50k characters, roughly 13k tokens — far more than a single tool result should ever contribute to the turn. Carrying that untrimmed had two consequences: the next turn's prompt overflowed the context and every later tool call in the same chat failed, and the webview held and re-rendered a 50k string per tool call. Three caps keep a long chat working:

| Cap | Value | Where | Why |
| --- | --- | --- | --- |
| `MAX_TOOL_RESULT_CHARS` | 4000 | `mcpClient.capLlmContent` / `capToolDetails` | The webview and the model never see more than 4k characters of a tool result. Blocks share one budget; images pass through. |
| `MAX_NATIVE_MESSAGE_CHARS` | 2400 | `piLocalRuntime.toNativeMessages` | Last line of defence per message, with an explicit truncation marker the model can see. |
| `MAX_NATIVE_TOTAL_CHARS` | 12000 | `piLocalRuntime.toNativeMessages` | Whole-transcript window: system messages are kept, older turns are dropped newest-first so a long chat stays inside the context instead of failing every turn. |
| `MAX_TOOL_RESULT_DISPLAY_CHARS` | 4000 | `LocalAgentPanel.toolResultText` | Rendered disclosure text is stringified once per `toolCallId` and cached, so re-rendering a long chat does not re-stringify every result. |

A prompt that fills the whole context is refused by Rust with `The prompt already fills the N-token context`, which the thread surfaces through `MessagePrimitive.Error` even when the assistant turn produced no text. Before that, the rejected turn saved as an assistant message with `content: []` and `stopReason: "error"`, so it rendered as an empty bubble and looked like the app had silently stopped working — inspect `~/.local/share/com.fina.payoff-explorer/sessions/*.jsonl` to see those.

Sessions written **before** these caps still hold the raw payload (a real `get_path` record was 28 kB of `content` plus 17 kB of `details`). `normalizeStoredMessages` clamps those on load, so an old chat becomes usable and is rewritten in capped form on the next save. `resetLocalAgentSession(sessionId)` drops the cached Pi agent when switching or starting a chat — without it, reopening a session reused the previous in-memory agent and kept the old transcript instead of the one just read from disk.

Tool planning is implemented as a constrained text protocol, not native llama function calling: the system prompt lists every active tool (drawn from the merged loadout) and asks for exactly one JSON object of the form `{"tool":"<tool-name>","arguments":{"<parameter>":<value>}}`.

The tool list must carry **parameter schemas**, not just names and descriptions. Each entry renders as `- <name>: <description>` plus an `arguments:` line of `name (type, required): doc` fields, and a tool that takes nothing says `arguments: none`. Two bugs came from omitting this. `describeTools` dropped `tool.parameters` even though `adaptTool` fills it from the MCP `inputSchema`, so the model had no way to learn that `get_path` needs `pathIndex` and every call arrived as `{}` — the server correctly rejected it with `must have required properties pathIndex`. The prompt's own example then compounded it by literally showing `"arguments":{}`, which the model copied verbatim. Both are pinned by tests.

That schema list makes the system prompt ~3.1k characters with the full 12-tool catalog, and the call-format block sits at the very end, so the system message must **not** share the 2400-char per-message clamp used for tool results (`MAX_NATIVE_SYSTEM_CHARS`, 6000, covers appended skills). Truncating it removes the call-format instructions and silently breaks tool calling while leaving the tool names visible. Nested request objects (`trade`, `market`) render as `(object, required)` without their inner fields; expanding them would flood the prompt with schema the small curated models cannot use well, so those tools stay the model's problem.

Tool results reach the UI through `toolResultDisplayText`. Pi hands back the whole MCP envelope — `{content:[{type,text}], details}` — and stringifying that verbatim filled the Result box with protocol JSON instead of the answer. Prefer the text blocks, then `structuredContent`/`details`, and return nothing rather than echo an empty envelope. `JSON.stringify` is wrapped because a circular or BigInt-bearing payload used to throw and render an empty box. The live path flattens at `tool_execution_end` so the thread carries display text, matching what the restored-transcript path already produced.

`toolRequest` must stay tolerant of real model output. Small local models wrap the JSON in prose and markdown fences, so it scans the reply for brace-balanced `{...}` slices (`jsonObjectSlices`) instead of parsing the whole string. It also resolves requested names against the loadout: exact matches win, and a bare name such as `get_mc_diagnostics` maps to its `mcp_`-prefixed tool. That resolution is covered by unit tests in `src/features/local-agent/__tests__/piLocalRuntime.test.ts`.

Pi's sequential tool execution then runs the matched `AgentTool`, which either invokes a Tauri command or calls `mcp_call_tool`. Update the system-prompt builder and parser together with any loadout change. Do not treat model-generated JSON as trusted input.

Built-in kernel tools and MCP tools are merged by `mergeTools`: when the MCP server exposes a tool whose normalized name matches a built-in, the MCP tool wins so the model never sees two tools that do the same thing. Built-ins survive only as a fallback when the server is unavailable. When a turn completes, tool results are replayed to native inference as prefixed `user` turns (the portable choice across GGUF chat templates).

The adapter surfaces tool calls to assistant-ui as real `tool-call` message parts: the adapter subscribes to Pi's `tool_execution_start` / `tool_execution_end` events and yields `{type:'tool-call', toolCallId, toolName, args, argsText, result, isError}` alongside the streamed text. `LocalAgentPanel` renders those parts with `ToolCallDisclosure` (the assistant-ui Tool call element: a collapsed chevron/label/query-chip/checkmark row that expands to the raw request and result). The assistant's pre-tool protocol JSON is stripped from the text stream so the thread never shows the raw `{"tool":...}` payload. `toolRequest` also tolerates the model echoing a rendered `{"toolCall":{...}}` object.

### MCP integration

`crates/fina-mcp` is a newline-delimited JSON-RPC 2.0 MCP server over stdio. The desktop app ships it as a Tauri sidecar and the **Rust runtime owns the process**:

- `scripts/build-mcp-sidecar.sh` runs `cargo build -p fina-mcp` and stages `target/debug/fina-mcp` at `src-tauri/binaries/fina-mcp-<target-triple>` (the path Tauri's `bundle.externalBin` requires). It runs from `beforeDevCommand` and `beforeBuildCommand`, and standalone via `npm run mcp:sidecar`.
- `get_mcp_server_path` resolves the binary (env override → resource dir → next to the exe → workspace `target/`).
- `src-tauri/src/mcp.rs` spawns the resolved binary, performs `initialize` + `notifications/initialized`, and serves requests on a background reader thread with per-id response routing. It exposes `mcp_list_tools`, `mcp_call_tool`, and `mcp_reset`. The process is held in `LocalAgentRuntime` for the app lifetime.

`src/features/local-agent/mcpClient.ts` is a thin wrapper: it calls `mcp_list_tools`, adapts each tool to a pi-agent-core `AgentTool` named `mcp_<tool>` (using `toLlmContent` for result content), and memoizes the list per app process. Tool execution goes through `mcp_call_tool`. `resetMcpConnection` clears the cache and calls `mcp_reset` so the next call respawns the server.

**Why not the webview shell plugin:** an earlier revision spawned the sidecar from the webview via `@tauri-apps/plugin-shell`, which required a `shell:allow-spawn` capability scoped to the exact `externalBin` string. That scope check proved fragile and the process was never spawned in practice, so the connection now lives entirely in Rust. The webview no longer needs any shell permission; `capabilities/default.json` grants only `core:default` and the opener.

### 4. App data and sessions

`get_app_paths` creates and returns paths under Tauri's OS-specific `app_data_dir()`:

```text
<app-data>/
├── models/      downloaded or manually copied GGUF files
├── sessions/    one JSONL session file per chat ID
└── config.json  preferredModelPath selection hint
```

After a successful Pi agent prompt, the webview calls `save_local_agent_session`. Rust rewrites `sessions/<sessionId>.jsonl` with a version-3 header and message records linked by a linear `parentId` chain (`m0`, `m1`, …). The title is the current user message truncated to 80 characters. The session ID is restricted to ASCII alphanumeric, `-`, and `_`, and is capped at 80 characters before it is used in a path.

Rust also exposes `list_local_agent_sessions` and `load_local_agent_session`. The panel uses both: the header history button lists saved chats (title, relative time, message count) and selecting one loads its messages. The loaded chat's id is the assistant-ui session id, its text turns seed the runtime through `useLocalRuntime(..., { initialMessages })`, and its raw Pi messages are replayed into a freshly created Pi `Agent` so the model keeps prior tool context. Selecting a chat remounts the chat subtree (keyed by session id + a counter), so runtime and adapter state never leak across chats. Starting a `New chat` allocates a fresh id and clears the display/seed state. The TypeScript `agentsBySession` map is still process memory; Rust session files are the durable store, and the current save implementation rewrites the whole file rather than using an atomic temporary-file swap. Account for this if improving durability or adding concurrent session writes.

## Tauri IPC contract

All commands below are registered in `src-tauri/src/lib.rs`. Rust command arguments use Tauri's JS camelCase mapping.

| Command | Purpose / relevant input |
| --- | --- |
| `get_app_paths` | Creates app-data subdirectories and returns app-data, models, sessions, and config paths. |
| `curated_model_catalog` | Returns the curated model metadata records. |
| `list_local_models` | Lists `.gguf` files in the app-managed models directory. |
| `open_models_folder` | Opens that directory using `tauri-plugin-opener`. |
| `start_model_download` | `modelId`; streams, verifies, and installs a curated file. |
| `cancel_model_download` | `modelId`; cancels an active download. |
| `load_model` | `path`; validates the managed-directory boundary and loads a GGUF. |
| `unload_model` | Drops the currently loaded model. It is registered but has no panel control. |
| `get_loaded_model` | Returns the loaded model's filename, or `null`. |
| `run_local_inference` | `request: { generationId, messages: [{ role, content }], maxTokens? }`; resolves to generated text and emits token events. |
| `cancel_local_inference` | `generationId`; signals active generation to stop between tokens. |
| `save_local_agent_session` | `sessionId`, `title`, `messages`; writes the session JSONL file. |
| `list_local_agent_sessions` | Returns session IDs, titles, modified time, and message count. |
| `load_local_agent_session` | `sessionId`; returns stored Pi message objects used to restore a chat. |
| `get_preferred_model` | Returns the saved preferred model path, if present. |
| `get_mcp_server_path` | Resolves the `fina-mcp` sidecar binary for the Rust MCP client. |
| `mcp_list_tools` | Starts (if needed) the `fina-mcp` process and returns server info plus `tools/list`. |
| `mcp_call_tool` | `name`, `arguments`; calls one MCP tool and returns its content. |
| `mcp_reset` | Drops the MCP connection so the next call respawns the server. |
| `list_agent_skills` | Scans `skills/*/SKILL.md` and returns skill records. |
| `skills_dir` | Returns the managed skills directory (app-data `skills/`). |
| `report_frontend_error` | `context`, `message`; appends a webview error to `frontend-errors.log` in app data and mirrors it to stderr. Called from the global `window` handlers in `main.tsx` and from the panel error boundary. |

### Events

| Event | Payload | Consumer |
| --- | --- | --- |
| `model-download-progress` | `{ modelId, downloadedBytes, totalBytes, percent }` | Progress display in `LocalAgentPanel`. |
| `model-download-finished` | `{ modelId, path }` | Clears progress and refreshes model discovery. |
| `model-download-error` | `{ modelId, message }` | Clears progress and displays non-cancellation errors. |
| `llm-token` | `{ generationId, delta, text }` | Pi provider filters by generation ID and streams cumulative text. |
| `llm-turn-end` | `{ generationId, cancelled }` | Emitted by Rust; the current frontend does not subscribe to this event. |

## Privacy, security, and licensing boundaries

- After an optional model download, prompts and inference stay local; this code does not send prompts to a hosted inference API.
- Curated model artifacts come from third-party HTTPS hosts. Their licenses/terms are upstream, linked in the model selector; local availability does not change those terms.
- Local path validation is rooted at the app-managed models directory. Session IDs are validated before constructing session paths.
- The agent exposes the built-in read-only kernel tools plus every tool `fina-mcp` advertises. Expanding this to mutating or external-action tools changes product behavior and needs explicit product design, validation, and user-facing affordances. The MCP process is owned by Rust and is not reachable from the webview.
- Outputs are based on synthetic/demo data and illustrative diagnostics. Retain the system-prompt and UI disclaimers when changing the assistant.
- The embedded chat runs `fina-mcp` over stdio as a child process owned by the Rust runtime (in-process, no network). To add other MCP servers, extend `src-tauri/src/mcp.rs` and the `mcp_*` commands; do not expose shell spawning to the webview.

## Current constraints and gaps

- Tauri desktop only; browser mode cannot load local files or execute native inference.
- The panel offers eight curated Q4_K_M models and local discovery only inside the app-managed models folder. There is no arbitrary filesystem picker, resume-download support, or custom model catalog UI.
- Model load/unload and context/sampler settings are not fully user-configurable. Models are not automatically loaded at startup. `unload_model` exists but has no panel control.
- Frontend sends a 512-token cap; Rust treats it as a request, not a limit, and clamps to the room the prompt leaves. Context size is derived per model (capped at `MAX_CONTEXT`), not user-configurable, and there is no context-trimming strategy in Rust. The frontend applies the trimming itself (`MAX_NATIVE_MESSAGE_CHARS` / `MAX_NATIVE_TOTAL_CHARS`); if a caller bypasses those caps, Rust shrinks the completion, and only refuses when the prompt alone exceeds the context.
- Tool results are truncated to `MAX_TOOL_RESULT_CHARS` for both the model and the UI, so a model cannot see the tail of a large payoff path. The full payload stays available through the Rust commands.
- Native kernel tools inspect demo outputs; current assistant tools do not accept the user's transient trade/market inputs (MCP tools that need `trade`/`market` arguments must be given them in the call).
- The MCP tool loadout is resolved once per adapter at first prompt. A tool-list change on a running server is not observed until a new chat/adapter is created.
- Session browsing/restoration is in-process only: chats are restored from the Rust JSONL store when opened, but there is no automatic re-selection of the most recent chat on app restart.
- Agent objects are retained in an in-memory `Map`; there is no explicit per-session disposal/eviction policy.
- Rust tests cover catalog shape and session-ID path traversal, not actual multi-gigabyte downloads, model inference, backend reuse across reloads, or full session lifecycle. The MCP stdio server has protocol unit tests; the webview transport is verified manually. Exercise the inference and sidecar flows with a supported local GGUF when changing them.

## Developer workflow

### Build and run

From the repository root:

```bash
npm ci
# For local inference, install platform-specific Tauri prerequisites first:
./scripts/ci/install-tauri-linux-deps.sh  # Debian/Ubuntu only
npm run tauri:dev
```

The Tauri app uses IPC and does not need `fina-server`. `npm run dev:all` is browser + HTTP mode and therefore does **not** provide local inference. The Linux prerequisite script includes CMake and libclang for the bundled llama.cpp build. Rust toolchain requirements are in `rust-toolchain.toml`; frontend requirements are documented in `README.md`.

### Validation

```bash
npm run build
npm run lint
npm run test:run
cargo fmt --all -- --check
cargo test -p payoff-explorer -p fina-mcp
```

The local-agent Rust unit tests are in `src-tauri/src/local_agent.rs`. Add automated tests for new command validation, session serialization/versioning, cancellation/error behavior, and tool allowlisting; add UI/adapter tests for model states and thread restoration rather than relying only on compilation.

### Troubleshooting the panel

**The app "stops" (window up, nothing responds) after a tool-heavy turn.** This was not a crash, and no crash signature exists to find: `frontend-errors.log` is empty, `dmesg` has no segfault / OOM-kill / `Killed process` line, and GDB shows the app alive and idle in `ppoll` → `gtk_main_iteration_do`. That is correct — the main thread was never the problem.

The cause is `runLoop` in `@earendil-works/pi-agent-core`. It is `while (true)`: it continues whenever the last assistant message carried a tool call, and it only exits early on `error`/`aborted` or when *every* result in a batch sets `terminate`, which none of our read-only tools do. A model that keeps requesting the same tool therefore never returns.

It used to stop by accident. The transcript grew until it overflowed the 4096-token context, the request failed, and `stopReason: "error"` is a hard exit in the loop. **Capping the prompt removed that circuit breaker**, so the loop now spins against a permanently valid prompt instead of erroring out.

Two things follow, both of which match the reported symptom:

- **The UI wedges rather than errors.** The loop is a microtask chain that never yields to the macrotask queue, so the webview stops servicing anything. Measured in `agentLoopBound.test.ts`: 201 rounds with a `setTimeout(…, 0)` scheduled beforehand still unfired (`timerFired=false`). That is "the whole app stopped" with a healthy OS main thread.
- **The turn is lost.** `save_local_agent_session` runs after the generator finishes, so an unbounded run never persists. Symptom: no session file newer than the last good turn.

`createTurnGuard` bounds the loop via the agent's `finishTurn` hook, with two independent stops because either alone is easy to defeat — a round budget (`MAX_TOOL_ROUNDS_PER_TURN`) for loops that vary the call, and repeat detection for the common verbatim repeat, which trips after one wasted round. A turn with no tool results returns `undefined` so normal scheduling and plain answers are untouched. The reason is surfaced in the thread, since the turn would otherwise end on a bare tool disclosure. The guard is rebuilt per `run()` because the `Agent` is cached across turns.

If this ever recurs, check whether the guard is actually attached to the run (`createLoopConfig` reads `finishTurn` at run start) before suspecting WebKit.

**Blank / vanished window on Linux.** The Tauri process stays alive — the *web content process* is a separate binary, so attaching GDB to the app shows a healthy idle `ppoll` event loop even while the UI is gone. An idle backtrace that ends in `gtk_main_iteration_do` → `fina_tauri::run` is therefore **not** a crash trace; the tell is that GDB reaches `[Inferior detached]` instead of printing `Program received signal`.

Ruled out for this symptom, so do not re-investigate them:

| Check | Result |
| --- | --- |
| `frontend-errors.log` | Empty — no JS exception, uncaught rejection, or error-boundary trip. |
| `dmesg \| grep -iE 'oom\|segfault\|killed process'` | Nothing. Not a fault and not an OOM kill. |
| `free -h` | 42 Gi available of 61 Gi. Not memory pressure. |
| `dmesg` `__vm_enough_memory … comm: java` | A JVM *virtual address space* reservation refused by overcommit, not a kill. |
| GDB backtrace | Main thread idle in the GTK event loop. Never the problem. |

`scripts/watch-renderer.sh` (or `npm run watch:renderer`) still samples the app and its WebKit helpers if a *genuine* renderer death is ever suspected: `WebKitWebProcess` near 100% CPU before vanishing means it was killed for hanging, 0% means something else killed it.

Two WebKit-side mitigations are in place, neither of which was the cause here:

- `createFramePublisher` coalesces token updates to one publish per animation frame. Rust emits `llm-token` per token, up to 512 per turn, and each publish re-rendered the entire thread.
- `npm run tauri:dev:stable-webview` sets `WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`, and `LIBGL_ALWAYS_SOFTWARE` before `tauri dev`, for GPU-path faults on VMs and remote desktops. Narrow with `-- --no-dmabuf`, `-- --no-compositing`, `-- --no-softwaregl`.

**React errors in the panel.** `PanelErrorBoundary` in `App.tsx` catches a render failure and shows the stack instead of blanking the app; the same message goes to `<app-data>/frontend-errors.log` via `report_frontend_error`, together with any uncaught `window` error or unhandled rejection. Note that assistant-ui client hooks (`useAui`, `useThreadRuntime`, `unstable_useComposerInputHistory`, …) must be called in a component rendered *below* `AssistantRuntimeProvider`, not in the component that returns it.

## Extension guidance

1. **Keep ownership clear.** Put model loading, filesystem access, checksums, and native inference in `src-tauri/src/local_agent.rs`. Put presentation and Pi/assistant-ui orchestration in `src/features/local-agent/`. Keep product-domain formulas in `fina-kernel`, not in the Tauri local-agent module.
2. **When adding an agent tool,** prefer adding it to `crates/fina-mcp` so the webview picks it up automatically from `tools/list`; the chat-side wrapper in `mcpClient.ts` is generic. For a built-in tool that must not depend on the sidecar, update the `AgentTool` definition, the system-prompt builder, and `toolRequest` validation together. Validate arguments on the Rust/kernel side too. Prefer read-only tools with explicit, typed inputs.
3. **When adding a skill,** create `skills/<skill-name>/SKILL.md` with `name`/`description` frontmatter and an instruction body. The directory name is the skill id and the inserted `/{name}`; keep it kebab-case. Skills are instruction-only prompt augmentations; do not use them to add capabilities or tools.
4. **When adding models,** add exact filename/URL/size/SHA-256/license/context metadata to the Rust catalog and test uniqueness and format. Keep download-to-partial, full verification, and final rename semantics.
5. **When adding session restore,** coordinate assistant-ui thread IDs, Pi Agent transcript/state, Tauri session records, and session version migration. Loading a JSONL message array alone does not currently recreate an assistant-ui thread.
6. **When changing concurrency or model settings,** account for the engine mutex, model/context memory use, the single-generation behavior, abort races, and cross-platform llama.cpp compilation.
7. **When changing privacy or tools,** update this guide and `README.md` alongside code. The chat does connect to `fina-mcp`; keep the sidecar path, capability scope, and transport description accurate.
