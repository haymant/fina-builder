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
| `src/features/local-agent/ComposerSourceMenu.tsx` | Composer `+` menu: MCP server (with hover tool list and retry) and inline skill toggles. |
| `src/features/local-agent/skills.ts` | Built-in agent skill registry (instruction blocks injected into the system prompt). |
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

The chat composer follows the assistant-ui composer convention: text field plus a toolbar row with a `+` source menu and the model picker on the left and a round send icon button that swaps to a stop (square) icon while a run is in flight. Changing the active model and opening the model manager both live in that toolbar / its popover. The `+` menu (`ComposerSourceMenu`) opens two categories: `MCP server` lists the registered server and, on hover, that server's tools; `Skills` lists the built-in skills inline as toggles. When the sidecar is unavailable the MCP category shows the error and a retry button. `New chat` and a chat-history browser are icon buttons in the panel header.

Skills (`src/features/local-agent/skills.ts`) are named instruction blocks from the agent-skills convention. They are a **static TypeScript registry** — there is no `SKILL.md` discovery or file loading; add entries to `AGENT_SKILLS` to define one. Toggling one in the `+` menu injects its `instructions` into the system prompt; skills only shape the prompt and never grant new capabilities. The active set is per-panel state passed into the adapter.

### 2. Model discovery, download, and loading

`src-tauri/src/local_agent.rs` owns a curated catalog of eight Q4_K_M GGUF models (Qwen2.5 1.5B/3B, Gemma 2 2B, Llama 3.2 3B, Phi-3.5 Mini, Phi-4 Mini 3.8B, Gemma 3n E2B, Qwen3 4B). Each entry includes an ID, exact filename, HTTPS download URL, expected byte count, SHA-256, recommended context length, chat-template note, and upstream license/terms URL. The panel renders metadata from `curated_model_catalog`; the Rust catalog is the source of truth. Add catalog entries only with a verified artifact: the size and SHA-256 must match the upstream file exactly.

All model files must live inside the Tauri app-data `models/` directory. `list_local_models` discovers `.gguf` files in that directory; unknown/manual files are listed by filename and have no curated license/context metadata. `load_model` canonicalizes the path and rejects files outside that directory or files that are not `.gguf`.

Curated download flow:

1. The UI invokes `start_model_download` with a catalog ID; duplicate in-progress downloads of the same model are rejected.
2. Rust streams the HTTPS response into `<model filename>.part`, emitting `model-download-progress` events.
3. Cancellation uses a `CancellationToken`. Cancellation or another failure removes the partial file and emits `model-download-error`.
4. On completion, Rust verifies both the exact catalogued byte count and SHA-256. Only a verified file is renamed to its final `.gguf` filename and announced by `model-download-finished`.

Downloads are not resumable. Do not weaken the size/hash/path checks when changing this flow. Update catalog metadata only after verifying the new upstream artifact and license.

`load_model` uses `spawn_blocking` to load the GGUF through `llama-cpp-2`, and replaces the loaded model only after a successful load. The process-wide `LlamaBackend` is initialized at most once and cached in the `LocalAgentRuntime` (`OnceLock<Arc<LlamaBackend>>`), so repeated load/change-model actions reuse it instead of failing with `BackendAlreadyInitialized`. Catalog models use their recommended context; other GGUFs use the model's training context capped at 4096 and floored at 1024. The preferred model path is written to app-data `config.json` as `preferredModelPath`. The path is a selection hint: startup does **not** auto-load the preferred model.

### 3. Chat turn, streaming, and tools

`LocalAgentPanel` provides assistant-ui chat primitives and creates a runtime per active chat session with `useLocalRuntime(createLocalAgentAdapter({ sessionId, initialMessages, onSaved }))`. The adapter in `piLocalRuntime.ts` creates/reuses one Pi `Agent` per session id in a module-level `Map`; the session id is the assistant-ui thread identity and the Rust session file name. Pi agent orchestration and assistant-ui run in the embedded TypeScript webview; native token generation and model storage are Rust/Tauri responsibilities.

The custom Pi `streamFn`:

1. Subscribes to `llm-token` before starting inference and filters events by a generated `generationId`.
2. Calls `run_local_inference` with transcript messages and a frontend maximum of 512 output tokens.
3. Relays cumulative text updates from native token events into Pi/assistant-ui. The native command ultimately resolves with the completed text.
4. Maps assistant-ui abort to `cancel_local_inference`; Rust checks an `AtomicBool` between generated tokens and returns the partial text accumulated so far.

Rust uses the GGUF's embedded chat template (`chat_template` plus `apply_chat_template`), tokenizes the result, and rejects a prompt if its token count plus requested output allowance exceeds the configured context. The backend clamps requested output to 1–2048 tokens. The current sampler is temperature 0.25 followed by `dist(42)`. A fresh inference context is created per request.

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

Tool planning is implemented as a constrained text protocol, not native llama function calling: the system prompt lists every active tool (drawn from the merged loadout) and asks for exactly one JSON object of the form `{"tool":"<tool-name>","arguments":{}}`.

`toolRequest` must stay tolerant of real model output. Small local models wrap the JSON in prose and markdown fences, so it scans the reply for brace-balanced `{...}` slices (`jsonObjectSlices`) instead of parsing the whole string. It also resolves requested names against the loadout: exact matches win, and a bare name such as `get_mc_diagnostics` maps to its `mcp_`-prefixed tool. That resolution is covered by unit tests in `src/features/local-agent/__tests__/piLocalRuntime.test.ts`.

Pi's sequential tool execution then runs the matched `AgentTool`, which either invokes a Tauri command or calls `mcp_call_tool`. Update the system-prompt builder and parser together with any loadout change. Do not treat model-generated JSON as trusted input.

Built-in kernel tools and MCP tools are merged by `mergeTools`: when the MCP server exposes a tool whose normalized name matches a built-in, the MCP tool wins so the model never sees two tools that do the same thing. Built-ins survive only as a fallback when the server is unavailable. When a turn completes, tool results are replayed to native inference as prefixed `user` turns (the portable choice across GGUF chat templates).

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
- Frontend sends a 512-token cap. Rust allows up to 2048 for other callers, checks context fit, and does not expose a context-trimming strategy.
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

## Extension guidance

1. **Keep ownership clear.** Put model loading, filesystem access, checksums, and native inference in `src-tauri/src/local_agent.rs`. Put presentation and Pi/assistant-ui orchestration in `src/features/local-agent/`. Keep product-domain formulas in `fina-kernel`, not in the Tauri local-agent module.
2. **When adding an agent tool,** prefer adding it to `crates/fina-mcp` so the webview picks it up automatically from `tools/list`; the chat-side wrapper in `mcpClient.ts` is generic. For a built-in tool that must not depend on the sidecar, update the `AgentTool` definition, the system-prompt builder, and `toolRequest` validation together. Validate arguments on the Rust/kernel side too. Prefer read-only tools with explicit, typed inputs.
3. **When adding a skill,** add an `AgentSkill` to `src/features/local-agent/skills.ts`. Skills are instruction-only prompt augmentations; do not use them to add capabilities or tools.
4. **When adding models,** add exact filename/URL/size/SHA-256/license/context metadata to the Rust catalog and test uniqueness and format. Keep download-to-partial, full verification, and final rename semantics.
5. **When adding session restore,** coordinate assistant-ui thread IDs, Pi Agent transcript/state, Tauri session records, and session version migration. Loading a JSONL message array alone does not currently recreate an assistant-ui thread.
6. **When changing concurrency or model settings,** account for the engine mutex, model/context memory use, the single-generation behavior, abort races, and cross-platform llama.cpp compilation.
7. **When changing privacy or tools,** update this guide and `README.md` alongside code. The chat does connect to `fina-mcp`; keep the sidecar path, capability scope, and transport description accurate.
