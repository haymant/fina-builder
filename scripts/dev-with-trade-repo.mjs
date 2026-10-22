#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverUrl = `http://127.0.0.1:${process.env.TRADE_REPO_HTTP_PORT ?? 8792}/health`
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

async function waitForRepository(server) {
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
  const node = process.execPath
  const repository = spawnChild('trade-repo MCP', node, ['scripts/trade-repo-mcp-http.mjs', '--seed'])
  await waitForRepository(repository)
  console.log(`[dev] trade-repo MCP ready at ${serverUrl.replace('/health', '/mcp')}`)

  const viteArgs = [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort', ...process.argv.slice(2)]
  spawnChild('Vite', node, viteArgs)
}

process.once('SIGINT', () => shutdown(130))
process.once('SIGTERM', () => shutdown(143))
main().catch((error) => {
  console.error(`[dev] ${error.message}`)
  shutdown(1)
})
