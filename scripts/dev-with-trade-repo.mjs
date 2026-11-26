#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyRuntimeEnvironment } from './lib/runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const children = []
let stopping = false

function spawnChild(label, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
  children.push({ label, child })
  child.once('error', (error) => {
    console.error(`[dev] ${label} failed to start: ${error.message}`)
    shutdown(1)
  })
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${label} exited (${signal ?? `code ${code}`}); stopping the other services.`)
      shutdown(code === 0 ? 1 : (code ?? 1))
    }
  })
  return child
}

function spawnOptional(label, command, args) {
  // Optional sidecar (revamp F1: fina-scraper): a missing binary or unset
  // NIP_LAKE_DIR must not kill `dev` — log it and keep going, exactly like
  // the optional bridges in dev-http.mjs. `doctor` reports the same gap.
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
  children.push({ label, child })
  child.once('error', (error) => {
    console.error(`[dev] ${label} unavailable: ${error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (!stopping) console.error(`[dev] ${label} unavailable (${signal ?? `code ${code}`}); continuing without it.`)
  })
  return child
}

async function waitForOptionalPort(label, port, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopping || child.exitCode !== null) return false
    try {
      await new Promise((resolvePromise, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        socket.setTimeout(500)
        socket.once('connect', () => { socket.destroy(); resolvePromise() })
        socket.once('error', reject)
        socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout')) })
      })
      return true
    } catch {
      // The sidecar may need a moment to bind its port.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  console.error(`[dev] ${label} did not start listening on port ${port} within ${timeoutMs / 1000} seconds; continuing without it.`)
  return false
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  const active = children.filter(({ child }) => child.exitCode === null && child.signalCode === null)
  if (active.length === 0) {
    process.exit(code)
    return
  }
  const closed = active.map(({ child }) => new Promise((done) => child.once('exit', done)))
  for (const { child } of active) child.kill('SIGTERM')
  const forceStop = setTimeout(() => {
    for (const { child } of active) child.kill('SIGKILL')
    process.exit(code)
  }, 5000)
  forceStop.unref()
  Promise.all(closed).then(() => {
    clearTimeout(forceStop)
    process.exit(code)
  })
}

async function waitForRepository(server, serverUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (stopping || server.exitCode !== null) throw new Error('Trade repository exited before becoming ready.')
    try {
      const response = await fetch(serverUrl, { signal: AbortSignal.timeout(750) })
      if (response.ok) return
    } catch {
      // The MCP process may need a moment to initialize SQLite and bind its port.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Trade repository did not become healthy at ${serverUrl} within 30 seconds.`)
}

async function main() {
  // `tauri dev` can be launched directly (or by the Tauri CLI), so apply the
  // control-plane defaults here too: `.env` first, then profile paths such as
  // NIP_LAKE_DIR for the optional fina-scraper sidecar.
  const { loaded } = applyRuntimeEnvironment(root)
  if (loaded.length > 0) console.log(`[dev] Loaded local environment from ${loaded.join(', ')}.`)

  const node = process.execPath
  const serverUrl = `http://127.0.0.1:${process.env.TRADE_REPO_HTTP_PORT ?? 8792}/health`
  const repository = spawnChild('trade-repo MCP', node, ['scripts/trade-repo-mcp-http.mjs', '--seed'])
  await waitForRepository(repository, serverUrl)
  console.log(`[dev] trade-repo MCP ready at ${serverUrl.replace('/health', '/mcp')}`)

  // Revamp F1: fina-scraper sidecar (Streamable HTTP on 127.0.0.1:8798),
  // started alongside the trade-repo sidecar. Optional: the launcher
  // exits 1 when the binary is missing or NIP_LAKE_DIR is unset, and `dev`
  // keeps going without it — `node scripts/fina.mjs doctor` reports the gap.
  const scraperPort = Number(process.env.FINA_SCRAPER_HTTP_PORT ?? 8798)
  const scraper = spawnOptional('fina-scraper MCP', node, ['scripts/fina-scraper-mcp-http.mjs'])
  const scraperReady = await waitForOptionalPort('fina-scraper MCP', scraperPort, scraper)
  console.log(scraperReady
    ? `[dev] fina-scraper MCP ready at http://127.0.0.1:${scraperPort}/mcp`
    : '[dev] fina-scraper MCP unavailable; continuing without the narrative sidecar.')

  const viteArgs = [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort', ...process.argv.slice(2)]
  spawnChild('Vite', node, viteArgs)
}

process.once('SIGINT', () => shutdown(130))
process.once('SIGTERM', () => shutdown(143))
main().catch((error) => {
  console.error(`[dev] ${error.message}`)
  shutdown(1)
})
