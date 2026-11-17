import { invoke } from '@tauri-apps/api/core'
import { createHttpMcpTransport, unwrapToolResult } from './rigaTransport'
import { toSnakeKeys } from './keyCase'

export interface NipTransport {
  callTool<T>(name: string, args?: unknown): Promise<T>
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function nipBaseUrl(): string {
  return (import.meta.env.VITE_NIP_MCP_URL as string | undefined) ?? '/nip'
}

const tauriNipTransport: NipTransport = {
  async callTool<T>(name: string, args?: unknown) {
    const result = await invoke<Record<string, unknown>>('nip_mcp_call_tool', {
      name,
      arguments: toSnakeKeys(args ?? {}),
    })
    return unwrapToolResult(result, name) as T
  },
}

function httpNipTransport(): NipTransport {
  const client = createHttpMcpTransport(nipBaseUrl())
  return {
    async callTool<T>(name: string, args?: unknown) {
      return client.callTool<T>(name, args)
    },
  }
}

let active: NipTransport | null = null
let mode: 'tauri' | 'http' = 'http'

export function getNipTransport(): NipTransport {
  if (!active) {
    if (inTauri()) {
      active = tauriNipTransport
      mode = 'tauri'
    } else {
      active = httpNipTransport()
      mode = 'http'
    }
  }
  return active
}

export function nipTransportMode(): 'tauri' | 'http' {
  getNipTransport()
  return mode
}

export function setNipTransport(transport: NipTransport | null): void {
  active = transport
}

export const nip = {
  callTool: <T>(name: string, args?: unknown) => getNipTransport().callTool<T>(name, args),
}
