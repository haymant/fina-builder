const protocolVersion = '2025-11-25'

type JsonRpcEnvelope = {
  jsonrpc?: string
  id?: string | number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export type McpToolResult = {
  isError: boolean
  data: unknown
  raw: Record<string, unknown>
}

/** Minimal MCP Streamable HTTP client for integration tests; it has no DB access. */
export class NipMcpClient {
  private sessionId: string | undefined
  private nextRequestId = 1
  private initialized = false

  constructor(private readonly endpoint: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    const rpc = await this.post({
      jsonrpc: '2.0',
      id: this.nextRequestId++,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'fina-external-agent-e2e', version: '1.0.0' },
      },
    })
    if (rpc.error) throw new Error(`MCP initialize failed: ${rpc.error.message ?? JSON.stringify(rpc.error)}`)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.initialized = true
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    await this.initialize()
    const result = await this.request('tools/list') as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    return result.tools ?? []
  }

  async callToolRaw(name: string, arguments_: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.initialize()
    const result = await this.request('tools/call', { name, arguments: arguments_ }) as Record<string, unknown>
    const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : []
    let data: unknown = result.structuredContent
    if (data === undefined) {
      const text = content.find((item) => item.type === 'text')?.text
      if (text) {
        try { data = JSON.parse(text) } catch { data = text }
      }
    }
    return { isError: result.isError === true, data, raw: result }
  }

  async callTool<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callToolRaw(name, arguments_)
    if (result.isError) {
      throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.data ?? result.raw)}`)
    }
    return result.data as T
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const rpc = await this.post({
      jsonrpc: '2.0',
      id: this.nextRequestId++,
      method,
      ...(params ? { params } : {}),
    })
    if (rpc.error) throw new Error(`MCP ${method} failed: ${rpc.error.message ?? JSON.stringify(rpc.error)}`)
    return rpc.result
  }

  private async post(message: Record<string, unknown>): Promise<JsonRpcEnvelope> {
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'MCP-Protocol-Version': protocolVersion,
    })
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId)
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    })
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) this.sessionId = sessionId
    const body = await response.text()
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 400)}`)
    if (!body.trim()) return {}

    const trimmed = body.trim()
    if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonRpcEnvelope
    for (const line of trimmed.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      try { return JSON.parse(line.slice('data:'.length).trim()) as JsonRpcEnvelope } catch { /* try next event */ }
    }
    throw new Error(`Unsupported MCP response body: ${trimmed.slice(0, 400)}`)
  }
}
