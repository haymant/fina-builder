// TacTransport: MCP client for `tac-engine` (the market-data server).
//
// `tac-engine` is **stdio-only** (`rmcp`; no HTTP transport, T-EXT-3), so the
// browser path always goes through the Rust sidecar (`tac_mcp_*` Tauri
// commands). Outside Tauri there is no transport: rather than fall back to fake
// data the client throws `TacUnavailableError`, and the market-data tiles show
// their "market source not configured" empty state.

import { invoke } from '@tauri-apps/api/core'
import { createHttpMcpTransport, unwrapToolResult } from './rigaTransport'
import { toSnakeKeys } from './keyCase'

export class TacUnavailableError extends Error {
  constructor(message = 'tac-engine is not reachable') {
    super(message)
    this.name = 'TacUnavailableError'
  }
}

export interface TacTransport {
  callTool<T>(name: string, args?: unknown): Promise<T>
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** The Streamable-HTTP bridge endpoint for tac-engine (browser/dev mode). */
export function tacBaseUrl(): string {
  // Same-origin path proxied by Vite to the tac-engine stdio→HTTP bridge
  // (`npm run mcp:http:tac`). Override with an absolute URL if needed.
  return (import.meta.env.VITE_TAC_MCP_URL as string | undefined) ?? '/tac'
}

const tauriTacTransport: TacTransport = {
  async callTool<T>(name: string, args?: unknown) {
    const result = await invoke<Record<string, unknown>>('tac_mcp_call_tool', {
      name,
      arguments: toSnakeKeys(args ?? {}),
    })
    return unwrapToolResult(result, name) as T
  },
}

/** HTTP bridge transport (`scripts/tac-mcp-http.mjs`): the browser path. */
function httpTacTransport(): TacTransport {
  const client = createHttpMcpTransport(tacBaseUrl())
  return {
    async callTool<T>(name: string, args?: unknown) {
      try {
        return await client.callTool<T>(name, args)
      } catch (error) {
        if (error instanceof TacUnavailableError) throw error
        // A connection refusal means the bridge is not running.
        if (error instanceof TypeError) {
          throw new TacUnavailableError(
            `tac-engine bridge not reachable at ${tacBaseUrl()}. Run \`npm run mcp:http:tac\` (dev) or use the desktop app.`,
          )
        }
        throw error
      }
    },
  }
}

let active: TacTransport | null = null
let mode: 'tauri' | 'http' = 'http'

export function getTacTransport(): TacTransport {
  if (!active) {
    if (inTauri()) {
      active = tauriTacTransport
      mode = 'tauri'
    } else {
      active = httpTacTransport()
      mode = 'http'
    }
  }
  return active
}

/** How tac-engine is currently reached (for the UI status banner). */
export function tacTransportMode(): 'tauri' | 'http' {
  getTacTransport()
  return mode
}

/** Test seam: replace the active transport (pass null to restore detection). */
export function setTacTransport(transport: TacTransport | null): void {
  active = transport
}

export const tac = {
  callTool: <T>(name: string, args?: unknown) => getTacTransport().callTool<T>(name, args),
}
