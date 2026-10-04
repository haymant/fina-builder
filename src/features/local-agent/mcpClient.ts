import { invoke } from '@tauri-apps/api/core'
import { toLlmContent, type CallToolResult } from '@earendil-works/pi-mcp'
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
      return {
        content: toLlmContent({
          content: result.content as CallToolResult['content'],
          structuredContent: result.structuredContent as CallToolResult['structuredContent'],
        }) as never,
        details: result.structuredContent as never,
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
