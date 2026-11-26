import { createHttpMcpTransport } from './rigaTransport'

/**
 * Transport for the fina-scraper MCP sidecar (revamp F1/F3).
 *
 * The sidecar speaks Streamable HTTP on loopback (default
 * http://127.0.0.1:8798/mcp, `npm run mcp:http:fina-scraper`). In the Vite
 * dev server the `/fina-scraper` path is proxied to it (see vite.config.ts),
 * which keeps the request same-origin — the webview cannot call the sidecar
 * directly (no CORS / private-network headers), exactly as with `/nip`.
 *
 * There is no Tauri `fina_scraper_mcp_call_tool` invoke yet, so this
 * transport is HTTP in both modes; a desktop build needs either the same
 * proxy or a future invoke (F1 follow-up). Every call is best-effort from
 * the UI's point of view: callers treat a failed call as "sidecar
 * unavailable" and render the NIP-side data they already have.
 */
export interface ScraperTransport {
  callTool<T>(name: string, args?: unknown): Promise<T>
}

export function scraperBaseUrl(): string {
  return (import.meta.env.VITE_FINA_SCRAPER_MCP_URL as string | undefined) ?? '/fina-scraper'
}

function httpScraperTransport(): ScraperTransport {
  const client = createHttpMcpTransport(scraperBaseUrl())
  return {
    async callTool<T>(name: string, args?: unknown) {
      return client.callTool<T>(name, args)
    },
  }
}

let active: ScraperTransport | null = null

export function getScraperTransport(): ScraperTransport {
  if (!active) active = httpScraperTransport()
  return active
}

/** Test seam, mirroring `setNipTransport`. */
export function setScraperTransport(transport: ScraperTransport | null): void {
  active = transport
}
