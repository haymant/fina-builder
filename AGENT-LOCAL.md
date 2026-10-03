# Local Agent — Design and Developer Guide

This document describes the **implemented** desktop local-agent feature and is intended as a code-navigation and extension guide. The Rust and TypeScript source remains authoritative if this guide and code diverge.

## Purpose and scope

The local assistant gives a user of the Fina Builder desktop app a chat interface for asking questions about the project's deterministic, synthetic payoff analytics. It runs model inference on the user's device and exposes a small, read-only set of kernel queries to the agent.

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
    │       ├── 3 allowlisted, read-only Tauri/kernel tools
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
```

The local-agent subsystem is separate from the kernel's financial/domain logic. Existing Tauri commands under `src-tauri/src/commands/` remain adapters to `fina-kernel`; local-agent commands manage desktop infrastructure and invoke the native model runtime. The standalone `crates/fina-mcp` server is a separate integration: the desktop chat **does not spawn or connect to MCP**. It currently invokes its three allowed Tauri tools directly.

## Source map and ownership

| File | Responsibility |
| --- | --- |
| `src/features/workspace/components/Workspace.tsx` | Adds the Chat launcher in the workspace header. |
| `src/App.tsx` | Opens the panel and lazy-loads its chunk only after first use. It retains the panel component after first open so its in-memory runtime survives closing/reopening the drawer during the app process. |
| `src/features/local-agent/LocalAgentPanel.tsx` | Model discovery/catalog UI, download progress and cancellation, load/change model, open model directory, chat rendering, send/stop, and user-visible errors. |
| `src/features/local-agent/piLocalRuntime.ts` | Pi Agent tools/system prompt, per-thread Agent map, custom assistant-ui adapter, Tauri token-event subscription, and native inference calls. |
| `src-tauri/src/local_agent.rs` | Catalog source of truth, local filesystem operations, model download/verification, loaded-model state, inference/cancellation, and session/config JSONL. |
| `src-tauri/src/lib.rs` | Owns `LocalAgentRuntime` as Tauri state and registers the local-agent commands alongside the app's other commands. |
| `src-tauri/capabilities/default.json` | Tauri permissions, including opening the app-managed model directory through the opener plugin. |

## Runtime and data flow

### 1. Opening the panel

The Chat button calls `onOpenLocalAgent`. `App.tsx` marks the panel as previously opened and sets it open. The component is lazy-imported through `React.lazy`; after it has first loaded, closing the visual drawer hides its DOM but keeps the component/runtime in the tree. This is why an in-process conversation can survive a drawer close/reopen, but it is **not** restored after restarting the desktop app.

The panel detects Tauri through `window.__TAURI_INTERNALS__`. In non-Tauri browser mode it displays an availability notice and does not call the native model commands.

### 2. Model discovery, download, and loading

`src-tauri/src/local_agent.rs` owns a curated catalog of five Q4_K_M GGUF models. Each entry includes an ID, exact filename, HTTPS download URL, expected byte count, SHA-256, recommended context length, chat-template note, and upstream license/terms URL. The panel renders metadata from `curated_model_catalog`; the Rust catalog is the source of truth.

All model files must live inside the Tauri app-data `models/` directory. `list_local_models` discovers `.gguf` files in that directory; unknown/manual files are listed by filename and have no curated license/context metadata. `load_model` canonicalizes the path and rejects files outside that directory or files that are not `.gguf`.

Curated download flow:

1. The UI invokes `start_model_download` with a catalog ID; duplicate in-progress downloads of the same model are rejected.
2. Rust streams the HTTPS response into `<model filename>.part`, emitting `model-download-progress` events.
3. Cancellation uses a `CancellationToken`. Cancellation or another failure removes the partial file and emits `model-download-error`.
4. On completion, Rust verifies both the exact catalogued byte count and SHA-256. Only a verified file is renamed to its final `.gguf` filename and announced by `model-download-finished`.

Downloads are not resumable. Do not weaken the size/hash/path checks when changing this flow. Update catalog metadata only after verifying the new upstream artifact and license.

`load_model` uses `spawn_blocking` to initialize `LlamaBackend`, load the GGUF through `llama-cpp-2`, and replace the loaded model only after a successful load. Catalog models use their recommended context; other GGUFs use the model's training context capped at 4096 and floored at 1024. The preferred model path is written to app-data `config.json` as `preferredModelPath`. The path is a selection hint: startup does **not** auto-load the preferred model.

### 3. Chat turn, streaming, and tools

`LocalAgentPanel` provides assistant-ui chat primitives and uses `useLocalRuntime(localAgentAdapter)`. The adapter in `piLocalRuntime.ts` creates/reuses one Pi `Agent` per assistant-ui thread in a module-level `Map`. Pi agent orchestration and assistant-ui run in the embedded TypeScript webview; native token generation and model storage are Rust/Tauri responsibilities.

The custom Pi `streamFn`:

1. Subscribes to `llm-token` before starting inference and filters events by a generated `generationId`.
2. Calls `run_local_inference` with transcript messages and a frontend maximum of 512 output tokens.
3. Relays cumulative text updates from native token events into Pi/assistant-ui. The native command ultimately resolves with the completed text.
4. Maps assistant-ui abort to `cancel_local_inference`; Rust checks an `AtomicBool` between generated tokens and returns the partial text accumulated so far.

Rust uses the GGUF's embedded chat template (`chat_template` plus `apply_chat_template`), tokenizes the result, and rejects a prompt if its token count plus requested output allowance exceeds the configured context. The backend clamps requested output to 1–2048 tokens. The current sampler is temperature 0.25 followed by `dist(42)`. A fresh inference context is created per request.

**Concurrency:** the loaded engine is held behind `Arc<Mutex<Option<LoadedModel>>>`, and inference holds its mutex guard while generating. This serializes inference on the loaded model; it is not a multi-session parallel serving runtime. Design any concurrency changes around llama context/model lifetime, memory limits, cancellation, and explicit request admission.

#### Current agent tools

The system prompt and tool allowlist currently expose only these no-argument, read-only tools:

| Tool | Tauri command | Result source |
| --- | --- | --- |
| `get_branch_stats` | `get_branch_stats` | Branch statistics from the kernel demo bundle. |
| `get_distributions` | `get_distributions` | Payoff distribution summary from the kernel demo bundle. |
| `get_mc_diagnostics` | `get_mc_diagnostics` | Kernel's illustrative MC diagnostics. |

The chat does not currently pass the UI's edited trade/market settings into these tools. It also does not register all twelve commands offered by the separate MCP server.

Tool planning is implemented as a constrained text protocol, not native llama function calling: the system prompt asks for exactly one JSON object of the form `{"tool":"<allowlisted-name>","arguments":{}}`. `toolRequest` parses the output and checks the name against `kernelTools`; Pi's sequential tool execution then runs the corresponding Tauri `invoke`. Keep the parser's allowlist, `KernelToolName`, and `AgentTool` definitions consistent. Do not treat model-generated JSON as trusted input.

### 4. App data and sessions

`get_app_paths` creates and returns paths under Tauri's OS-specific `app_data_dir()`:

```text
<app-data>/
├── models/      downloaded or manually copied GGUF files
├── sessions/    one JSONL session file per chat ID
└── config.json  preferredModelPath selection hint
```

After a successful Pi agent prompt, the webview calls `save_local_agent_session`. Rust rewrites `sessions/<sessionId>.jsonl` with a version-3 header and message records linked by a linear `parentId` chain (`m0`, `m1`, …). The title is the current user message truncated to 80 characters. The session ID is restricted to ASCII alphanumeric, `-`, and `_`, and is capped at 80 characters before it is used in a path.

Rust also exposes `list_local_agent_sessions` and `load_local_agent_session`. **The current panel does not call either command**: there is no session list, selection, or restore UI yet. The TypeScript `agentsByThread` map is process memory and is not rehydrated from these files on startup. The current save implementation rewrites the whole file and does not use an atomic temporary-file swap; account for this if improving durability or adding concurrent session writes.

## Tauri IPC contract

All commands below are registered in `src-tauri/src/lib.rs`. Rust command arguments use Tauri's JS camelCase mapping.

| Command | Purpose / relevant input |
| --- | --- |
| `get_app_paths` | Creates app-data subdirectories and returns app-data, models, sessions, and config paths. |
| `curated_model_catalog` | Returns the five curated model metadata records. |
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
| `load_local_agent_session` | `sessionId`; returns stored message objects (not wired to the panel). |
| `get_preferred_model` | Returns the saved preferred model path, if present. |

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
- The agent's three tools are read-only. Adding a mutating or external-action tool changes product behavior and needs explicit product design, validation, and user-facing affordances; do not silently expand this allowlist.
- Outputs are based on synthetic/demo data and illustrative diagnostics. Retain the system-prompt and UI disclaimers when changing the assistant.
- The embedded chat does not use `fina-mcp`. To add MCP-backed tools, design an explicit transport/client integration or a narrowly scoped adapter rather than assuming the standalone stdio process is already connected.

## Current constraints and gaps

- Tauri desktop only; browser mode cannot load local files or execute native inference.
- The panel offers five curated Q4_K_M models and local discovery only inside the app-managed models folder. There is no arbitrary filesystem picker, resume-download support, or custom model catalog UI.
- Model load/unload and context/sampler settings are not fully user-configurable. Models are not automatically loaded at startup.
- Frontend sends a 512-token cap. Rust allows up to 2048 for other callers, checks context fit, and does not expose a context-trimming strategy.
- Native kernel tools inspect demo outputs; current assistant tools do not accept the user's transient trade/market inputs.
- Session save/list/load IPC exists, but UI browsing/restoration and restart-time Pi Agent rehydration do not.
- Agent objects are retained in an in-memory `Map`; there is no explicit per-thread disposal/eviction policy.
- Rust tests cover catalog shape and session-ID path traversal, not actual multi-gigabyte downloads, model inference, or full session lifecycle. Exercise those flows manually with a supported local GGUF when changing them.

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
2. **When adding an agent tool,** update the name union, `AgentTool` definition, system prompt source/allowlist, JSON parser validation, and tests together. Validate arguments on the Rust/kernel side too. Prefer read-only tools with explicit, typed inputs.
3. **When adding models,** add exact filename/URL/size/SHA-256/license/context metadata to the Rust catalog and test uniqueness and format. Keep download-to-partial, full verification, and final rename semantics.
4. **When adding session restore,** coordinate assistant-ui thread IDs, Pi Agent transcript/state, Tauri session records, and session version migration. Loading a JSONL message array alone does not currently recreate an assistant-ui thread.
5. **When changing concurrency or model settings,** account for the engine mutex, model/context memory use, the single-generation behavior, abort races, and cross-platform llama.cpp compilation.
6. **When changing privacy or tools,** update this guide and `README.md` alongside code. Do not describe the standalone MCP server as the source of chat tools unless the chat actually connects to it.
