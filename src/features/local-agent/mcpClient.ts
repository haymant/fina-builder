import { invoke } from '@tauri-apps/api/core'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import {
  McpClient,
  parseJsonRpcMessage,
  toLlmContent,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type Tool,
} from '@earendil-works/pi-mcp'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

/**
 * MCP transport that bridges pi-mcp's JSON-RPC framing to a Tauri sidecar.
 *
 * pi-mcp's bundled `StdioTransport` spawns processes with `node:child_process`,
 * which is unavailable in the Tauri webview. This transport instead drives the
 * `@tauri-apps/plugin-shell` `Command` API, which spawns the sidecar natively
 * and streams its stdout line by line. We re-frame those lines into the same
 * newline-delimited JSON-RPC messages an MCP stdio server emits.
 */
class TauriSidecarTransport implements McpTransport {
  private child: Child | undefined
  private readonly messageListeners = new Set<McpTransportMessageListener>()
  private readonly errorListeners = new Set<McpTransportErrorListener>()
  private readonly closeListeners = new Set<McpTransportCloseListener>()
  private closeEmitted = false
  private readonly commandName: string
  private readonly args: readonly string[]

  constructor(commandName: string, args: readonly string[] = []) {
    this.commandName = commandName
    this.args = args
  }

  onMessage(listener: McpTransportMessageListener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onError(listener: McpTransportErrorListener) {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: McpTransportCloseListener) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async start() {
    const command = Command.sidecar(this.commandName, [...this.args])
    command.stderr.on('data', (line) => {
      // Diagnostics are not protocol traffic; surface them on the console only.
      if (line.trim()) console.debug(`fina-mcp: ${line}`)
    })
    command.stdout.on('data', (line) => this.handleLine(line))
    command.on('error', (message) => {
      this.emitError(new Error(message))
      this.emitClose()
    })
    command.on('close', () => this.emitClose())
    this.child = await command.spawn()
  }

  private handleLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      this.emitMessage(parseJsonRpcMessage(trimmed))
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async send(message: JsonRpcMessage) {
    if (!this.child) throw new Error('MCP transport is not started')
    await this.child.write(`${JSON.stringify(message)}\n`)
  }

  async close() {
    this.emitClose()
    if (this.child) {
      try {
        await this.child.kill()
      } catch {
        // The process may already be gone.
      }
      this.child = undefined
    }
  }

  private emitMessage(message: JsonRpcMessage) {
    for (const listener of this.messageListeners) listener(message)
  }

  private emitError(error: Error) {
    for (const listener of this.errorListeners) listener(error)
  }

  private emitClose() {
    if (this.closeEmitted) return
    this.closeEmitted = true
    for (const listener of this.closeListeners) listener()
  }
}

/** Provider-friendly tool name: `mcp_` prefix, `[A-Za-z0-9_-]` only, max 64 chars. */
function toolName(name: string): string {
  return `mcp_${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/**
 * Wrap one MCP tool as a pi-agent-core `AgentTool`. The MCP server reports tool
 * failures inside the result (`isError`), so the tool mirrors that rather than
 * throwing for expected failures.
 */
function adaptTool(client: McpClient, tool: Tool): AgentTool {
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
      const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal })
      return {
        content: toLlmContent(result) as never,
        details: result.structuredContent as never,
        isError: result.isError === true,
      }
    },
  }
}

export type McpConnection = {
  client: McpClient
  tools: AgentTool[]
  /** Raw MCP tool descriptors (name/description/inputSchema) before adaptation. */
  rawTools: McpToolInfo[]
  serverName: string | undefined
  serverVersion: string | undefined
  instructions: string | undefined
  close: () => Promise<void>
}

/** Minimal MCP tool metadata the UI needs for the composer menu. */
export type McpToolInfo = {
  name: string
  title?: string
  description?: string
}

/** Connection state for the composer's `+` menu. */
export type McpConnectionStatus = 'connecting' | 'connected' | 'unavailable'

let connection: Promise<McpConnection> | undefined

async function connect(): Promise<McpConnection> {
  // Preflight: surface a clear error on builds where the sidecar is missing,
  // rather than an opaque spawn failure. The actual spawn still goes through
  // `Command.sidecar('fina-mcp')`, which resolves the registered externalBin.
  const resolved = await invoke<string>('get_mcp_server_path').catch(() => null)
  if (!resolved) {
    throw new Error('fina-mcp sidecar is not available. Build it with `cargo build -p fina-mcp` or set FINA_MCP_BIN.')
  }
  const transport = new TauriSidecarTransport('fina-mcp')
  const client = new McpClient({
    name: 'fina-builder-local-agent',
    version: '0.1.0',
    roots: [{ uri: 'fina://workspace', name: 'fina-builder workspace' }],
  })
  await client.connect(transport)
  const tools = await client.listTools()
  return {
    client,
    tools: tools.map((tool) => adaptTool(client, tool)),
    rawTools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })),
    serverName: client.serverInfo?.name,
    serverVersion: client.serverInfo?.version,
    instructions: client.instructions,
    close: () => client.close(),
  }
}

/** Lazily connect once per app process; concurrent callers share one client. */
export function getMcpConnection(): Promise<McpConnection> {
  if (!connection) {
    connection = connect().catch((error) => {
      connection = undefined
      throw error
    })
  }
  return connection
}

/** Drop the cached connection so the next call reconnects (e.g. after a crash). */
export async function resetMcpConnection() {
  const current = connection
  connection = undefined
  if (current) {
    try {
      await (await current).close()
    } catch {
      // Already closed.
    }
  }
}
