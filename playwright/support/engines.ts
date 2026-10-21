import type { APIRequestContext } from '@playwright/test'

/** True when the riga-flow MCP server answers an MCP initialize request. */
export async function isRigaEngineReady(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.post('http://127.0.0.1:8788/mcp', {
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'playwright-probe', version: '1' },
        },
      },
      timeout: 3_000,
    })
    return response.ok()
  } catch {
    return false
  }
}
