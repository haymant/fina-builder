// RigaTransport (§3.3): JSON-RPC 2.0 MCP client for `riga-mcp`.
//
// Two implementations, identical shape:
//  - `httpRigaTransport` — Streamable HTTP to `http://127.0.0.1:8788/mcp`
//    (browser mode; loopback only).
//  - `tauriRigaTransport` — the Rust-owned stdio child process via the
//    `riga_mcp_*` Tauri commands (desktop mode).
//
// Tool output arrives as MCP **structured content**; the transports unwrap
// `result.structuredContent` so callers get the domain object directly. A
// tool-level failure (`isError` with `{code,message}`) is rethrown as a
// `RigaToolError` so panels can map `code` to an error state.

import { invoke } from '@tauri-apps/api/core'
import { toCamelKeys, toSnakeKeys } from './keyCase'

export interface ToolDescriptor {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ResourceDescriptor {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface PromptDescriptor {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface PromptMessage {
  role: string
  content: unknown
}

/** A SEP-2663 client-driven task, as returned by `price_book_async`. */
export interface RigaTask {
  taskId: string
  status: string
  progress?: number
  message?: string
  result?: unknown
}

export interface RigaTransport {
  listTools(): Promise<ToolDescriptor[]>
  callTool<T>(name: string, args?: unknown): Promise<T>
  listResources(): Promise<ResourceDescriptor[]>
  readResource<T>(uri: string): Promise<T>
  listPrompts(): Promise<PromptDescriptor[]>
  getPrompt(name: string, args?: unknown): Promise<PromptMessage[]>
  getTask(taskId: string): Promise<RigaTask>
}

/** A structured tool-level error (`{code,message}`) from `riga-mcp`. */
export class RigaToolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RigaToolError'
    this.code = code
  }
}

function isToolError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const block = content.find(
    (item) => typeof item === 'object' && item !== null && (item as { type?: string }).type === 'text',
  ) as { text?: string } | undefined
  return block?.text
}

/** Normalises a tool result into the unwrapped domain payload (camelCase). */
export function unwrapToolResult(result: Record<string, unknown>, tool?: string): unknown {
  if (result.isError) {
    const structured = result.structuredContent
    if (isToolError(structured)) throw new RigaToolError(structured.code, structured.message)
    // Surface the server's own message (e.g. a parameter deserialisation error)
    // instead of a generic one, prefixed with the tool that failed.
    const text = firstText(result.content)
    const message = text?.trim() || 'The tool reported an error'
    throw new RigaToolError('tool_error', tool ? `${tool}: ${message}` : message)
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return toCamelKeys(result.structuredContent)
  }
  // Fall back to the first text block when a tool returns unstructured content.
  const text = firstText(result.content)
  if (text) {
    try {
      return toCamelKeys(JSON.parse(text)) as unknown
    } catch {
      return text
    }
  }
  return toCamelKeys(result)
}

// ---------------------------------------------------------------------------
// HTTP (Streamable) implementation
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2025-11-25'
const REQUEST_TIMEOUT_MS = 30_000

/** Parses a JSON-RPC reply that may arrive as JSON or as SSE `data:` frames. */
export function parseRpcBody(contentType: string, body: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    for (const frame of body.split('\n\n')) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice('data:'.length).trim()
      if (!payload) continue
      try {
        const parsed = JSON.parse(payload) as JsonRpcResponse
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed
      } catch {
        continue
      }
    }
    throw new RigaToolError('serialization_error', 'The MCP server returned no JSON-RPC result frame')
  }
  return JSON.parse(body) as JsonRpcResponse
}

export function createHttpMcpTransport(baseUrl: string): RigaTransport {
  let sessionId: string | null = null
  let nextId = 1
  let initialized: Promise<void> | null = null

  async function rpc(method: string, params: unknown, notify = false): Promise<Record<string, unknown> | undefined> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const id = notify ? undefined : nextId++
    // A timeout so a blocked/black-holed request (CORS, private-network-access,
    // a hung proxy) surfaces as an error instead of an infinite loader.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
      })
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? `${method} timed out after ${REQUEST_TIMEOUT_MS}ms (is the MCP server reachable at ${baseUrl}/mcp?)`
        : `could not reach MCP server at ${baseUrl}/mcp: ${(error as Error).message}`
      throw new RigaToolError('transport_error', message)
    } finally {
      clearTimeout(timer)
    }
    const returnedSession = response.headers.get('Mcp-Session-Id')
    if (returnedSession) sessionId = returnedSession
    if (notify) return undefined
    const text = await response.text()
    if (!response.ok) {
      throw new RigaToolError('http_error', `HTTP ${response.status}: ${text.slice(0, 240)}`)
    }
    const parsed = parseRpcBody(response.headers.get('Content-Type') ?? '', text)
    if (parsed.error) throw new RigaToolError('jsonrpc_error', parsed.error.message)
    return parsed.result ?? {}
  }

  function handshake(): Promise<void> {
    if (!initialized) {
      initialized = (async () => {
        await rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'fina-builder', version: '0.1.0' },
        })
        await rpc('notifications/initialized', {}, true)
      })().catch((e) => {
        initialized = null
        throw e
      })
    }
    return initialized
  }

  return {
    async listTools() {
      await handshake()
      const result = await rpc('tools/list', {})
      return ((result?.tools as ToolDescriptor[]) ?? [])
    },
    async callTool<T>(name: string, args?: unknown) {
      await handshake()
      const result = await rpc('tools/call', { name, arguments: toSnakeKeys(args ?? {}) })
      return unwrapToolResult(result ?? {}, name) as T
    },
    async listResources() {
      await handshake()
      const result = await rpc('resources/list', {})
      return toCamelKeys((result?.resources as ResourceDescriptor[]) ?? [])
    },
    async readResource<T>(uri: string) {
      await handshake()
      const result = await rpc('resources/read', { uri })
      const contents = (result?.contents as Array<{ text?: string; blob?: string }>) ?? []
      const first = contents[0]
      if (!first) throw new RigaToolError('unknown_resource', `Resource ${uri} returned no content`)
      if (first.text) {
        try {
          return toCamelKeys(JSON.parse(first.text)) as T
        } catch {
          return first.text as T
        }
      }
      return toCamelKeys(first) as T
    },
    async listPrompts() {
      await handshake()
      const result = await rpc('prompts/list', {})
      return toCamelKeys((result?.prompts as PromptDescriptor[]) ?? [])
    },
    async getPrompt(name: string, args?: unknown) {
      await handshake()
      const result = await rpc('prompts/get', { name, arguments: toSnakeKeys(args ?? {}) })
      return toCamelKeys((result?.messages as PromptMessage[]) ?? [])
    },
    async getTask(taskId: string) {
      await handshake()
      const result = await rpc('tasks/get', { taskId })
      return (result ?? { taskId, status: 'unknown' }) as unknown as RigaTask
    },
  }
}

/** Back-compat alias for the generic HTTP MCP transport. */
export const createHttpRigaTransport = createHttpMcpTransport

// ---------------------------------------------------------------------------
// Tauri (stdio) implementation
// ---------------------------------------------------------------------------
interface TauriRigaList {
  server: string
  version: string
  tools: ToolDescriptor[]
}

export const tauriRigaTransport: RigaTransport = {
  async listTools() {
    const response = await invoke<TauriRigaList>('riga_mcp_list_tools')
    return response.tools
  },
  async callTool<T>(name: string, args?: unknown) {
    const result = await invoke<Record<string, unknown>>('riga_mcp_call_tool', {
      name,
      arguments: toSnakeKeys(args ?? {}),
    })
    return unwrapToolResult(result, name) as T
  },
  async listResources() {
    return invoke<ResourceDescriptor[]>('riga_mcp_list_resources')
  },
  async readResource<T>(uri: string) {
    const result = await invoke<{ contents?: Array<{ text?: string; blob?: string }> }>(
      'riga_mcp_read_resource',
      { uri },
    )
    const first = result.contents?.[0]
    if (!first) throw new RigaToolError('unknown_resource', `Resource ${uri} returned no content`)
    if (first.text) {
      try {
        return toCamelKeys(JSON.parse(first.text)) as T
      } catch {
        return first.text as T
      }
    }
    return toCamelKeys(first) as T
  },
  async listPrompts() {
    return toCamelKeys(await invoke<PromptDescriptor[]>('riga_mcp_list_prompts'))
  },
  async getPrompt(name: string, args?: unknown) {
    const result = await invoke<{ messages: PromptMessage[] }>('riga_mcp_get_prompt', {
      name,
      arguments: toSnakeKeys(args ?? {}),
    })
    return toCamelKeys(result.messages)
  },
  async getTask(taskId: string) {
    return invoke<RigaTask>('riga_mcp_get_task', { taskId })
  },
}

// ---------------------------------------------------------------------------
// Selection + test injection
// ---------------------------------------------------------------------------

function detect(): RigaTransport {
  const override = import.meta.env.VITE_RIGA_TRANSPORT as string | undefined
  if (override === 'http') return createHttpRigaTransport(rigaBaseUrl())
  if (override === 'tauri') return tauriRigaTransport
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return inTauri ? tauriRigaTransport : createHttpRigaTransport(rigaBaseUrl())
}

export function rigaBaseUrl(): string {
  // Browser/dev default is a same-origin path proxied by Vite to the local
  // riga-mcp HTTP server (`server.proxy`). Calling `127.0.0.1:8788` directly
  // from a `localhost:5173` page is blocked by CORS / private-network-access,
  // which leaves the request pending. Override with an absolute URL if the
  // server is reached another way.
  return (import.meta.env.VITE_RIGA_BASE_URL as string | undefined) ?? '/riga'
}

let active: RigaTransport | null = null

/** The active transport (lazy, so tests can inject before first use). */
export function getRigaTransport(): RigaTransport {
  if (!active) active = detect()
  return active
}

/** Test seam: replace the active transport (pass null to restore detection). */
export function setRigaTransport(transport: RigaTransport | null): void {
  active = transport
}

/** Convenience client used by hooks. */
export const riga = {
  callTool: <T>(name: string, args?: unknown) => getRigaTransport().callTool<T>(name, args),
  listTools: () => getRigaTransport().listTools(),
  listResources: () => getRigaTransport().listResources(),
  readResource: <T>(uri: string) => getRigaTransport().readResource<T>(uri),
  listPrompts: () => getRigaTransport().listPrompts(),
  getPrompt: (name: string, args?: unknown) => getRigaTransport().getPrompt(name, args),
  getTask: (taskId: string) => getRigaTransport().getTask(taskId),
}
