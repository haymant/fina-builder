// Minimal JSON-RPC-over-stdio MCP client for recording real engine transcripts.
//
//   node scripts/lib/mcpStdio.mjs   (module)
//
// Line-delimited JSON-RPC 2.0, matching the framing both `riga-mcp` and
// `tac-engine` use. No dependencies.

import { spawn } from 'node:child_process'

const PROTOCOL = '2025-11-25'

export function createStdioClient(binary, args = [], { env = process.env, cwd, timeoutMs = 60000 } = {}) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd })
  let nextId = 1
  const pending = new Map()
  let buffer = ''
  const stderr = []

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined || message.id === null) continue
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function request(method, params = {}, timeout = timeoutMs) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  function notify(method, params = {}) {
    send({ jsonrpc: '2.0', method, params })
  }

  /** Forward a JSON-RPC message verbatim, resolving the reply with the same id. */
  function call(message, timeout = timeoutMs) {
    if (message.id === undefined || message.id === null) {
      send(message)
      return Promise.resolve(null)
    }
    const id = message.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${message.method}`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      send(message)
    })
  }

  async function initialize() {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'fina-builder-recorder', version: '0.1.0' },
    })
    notify('notifications/initialized')
    return result
  }

  return {
    child,
    request,
    notify,
    call,
    initialize,
    stderr: () => stderr.join(''),
    close() {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      child.kill()
    },
  }
}
