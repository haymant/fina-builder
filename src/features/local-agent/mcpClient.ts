import { invoke } from '@tauri-apps/api/core'
import { toLlmContent, type CallToolResult, type LlmContent } from '@earendil-works/pi-mcp'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

/**
 * MCP access for the local agent.
 *
 * The `fina-mcp` stdio server is spawned and owned by the Rust runtime
 * (`src-tauri/src/mcp.rs`), which performs the MCP handshake and exposes
 * `mcp_list_tools` / `mcp_call_tool`. The webview never spawns a process, so
 * there is no shell-plugin sidecar scope to configure. Only the browser-safe
 * content-conversion helper from `@earendil-works/pi-mcp` is used here.
 */

/** One tool as advertised by `mcp_list_tools`. */
export type McpToolInfo = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
}

type McpListResponse = {
  server: string
  version: string
  tools: McpToolInfo[]
}

type McpCallResponse = {
  content: unknown
  structuredContent?: unknown
  isError: boolean
}

export type McpConnection = {
  tools: AgentTool[]
  /** Raw MCP tool descriptors (name/description/inputSchema) for the UI. */
  rawTools: McpToolInfo[]
  serverName: string | undefined
  serverVersion: string | undefined
}

/** Provider-friendly tool name: `mcp_` prefix, `[A-Za-z0-9_-]` only, max 64 chars. */
function toolName(name: string): string {
  return `mcp_${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResponse> {
  if (signal?.aborted) throw new Error('aborted')
  return invoke<McpCallResponse>('mcp_call_tool', { name, arguments: args })
}

/**
 * Cap what a tool result hands back. `get_path` returns a whole payoff path —
 * ~50k characters, ~13k tokens. Passing that through untrimmed exhausts the
 * model's 4096-token context on the *next* turn, writes a 50k string into every
 * saved session, and makes the webview re-render a 50k string per message on
 * every render. Truncating here keeps the first turn succeeding and later turns
 * working; `fina-mcp` still returns the full payload to any other consumer.
 */
export const MAX_TOOL_RESULT_CHARS = 4000

function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more characters truncated; call the tool again with a narrower request for the rest)`
}

/**
 * Truncate text blocks in order against one shared budget, leaving images
 * alone (they cost context but not characters). A block that crosses the
 * budget keeps whatever budget is left; once the budget is spent, later text
 * blocks collapse to their truncation marker so the model still sees that more
 * content existed.
 */
export function capLlmContent(blocks: LlmContent[]): LlmContent[] {
  let remaining = MAX_TOOL_RESULT_CHARS
  return blocks.map((block) => {
    if (block.type === 'image') return block
    if (block.text.length <= remaining) {
      remaining -= block.text.length
      return block
    }
    const capped = truncate(block.text, Math.max(remaining, 0))
    remaining = 0
    return { type: 'text', text: capped }
  })
}

/** Cap a tool payload for the UI, without mangling the shape of small results. */
export function capToolDetails(details: unknown): unknown {
  if (details === undefined || details === null) return details
  if (typeof details === 'string') return truncate(details)
  try {
    const json = JSON.stringify(details)
    if (json === undefined || json.length <= MAX_TOOL_RESULT_CHARS) return details
    // Large enough that the raw object is not worth carrying through the IPC
    // bridge: the disclosure shows the head, and the model sees the same text.
    return truncate(json)
  } catch {
    return '[unserializable tool result]'
  }
}

function adaptTool(tool: McpToolInfo): AgentTool {
  return {
    name: toolName(tool.name),
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: 'object',
      properties: tool.inputSchema.properties ?? {},
    }) as never,
    execute: async (_toolCallId, params, signal) => {
      const result = await callTool(tool.name, params as Record<string, unknown>, signal)
      const content = capLlmContent(
        toLlmContent({
          content: result.content as CallToolResult['content'],
          structuredContent: result.structuredContent as CallToolResult['structuredContent'],
        }),
      )
      return {
        content: content as never,
        details: capToolDetails(result.structuredContent) as never,
        isError: result.isError === true,
      }
    },
  }
}

async function fetchTools(): Promise<McpConnection> {
  const response = await invoke<McpListResponse>('mcp_list_tools')
  return {
    tools: response.tools.map(adaptTool),
    rawTools: response.tools,
    serverName: response.server || undefined,
    serverVersion: response.version || undefined,
  }
}

let connection: Promise<McpConnection> | undefined

/** Lazily load the tool list once per app process; concurrent callers share it. */
export function getMcpConnection(): Promise<McpConnection> {
  if (!connection) {
    connection = fetchTools().catch((error) => {
      connection = undefined
      throw error
    })
  }
  return connection
}

/** Drop the cached tool list and Rust-side process so the next call reconnects. */
export async function resetMcpConnection() {
  connection = undefined
  try {
    await invoke('mcp_reset')
  } catch {
    // The runtime may already be gone.
  }
}
