#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const children = []
let stopping = false

function usage() {
  console.log(`Usage: npm run dev:http [-- --cpu|--cuda] [--public]

Builds riga-mcp and tac-engine, then starts the HTTP engines, the trade-repo MCP server,
the qlib book/R&D bridges, the RiskCube bridge, the fina-scraper MCP server
(Streamable HTTP on 127.0.0.1:8798, when its binary is built and NIP_LAKE_DIR
is set), and Vite.
  --cpu      Build the portable CPU backend (default)
  --cuda     Build riga-mcp with its CUDA GPU feature; requires CUDA 13+ and an NVIDIA GPU
  --public   Bind Vite to 0.0.0.0 for a forwarded/public preview; backends stay on loopback
  --help     Show this help`)
}

// Mirror the desktop host's engine environment: local, ignored `.env` files are
// read so browser mode sees the same Alpaca/lake/database configuration as the
// Tauri sidecar. Explicit shell values win; earlier files win over later ones.
// Only the launcher-injected profile default may be replaced by a local .env.
export function loadLocalEnv(projectRoot = root, env = process.env) {
  const candidates = [
    resolve(projectRoot, '.env'),
    resolve(projectRoot, 'modules/tac-engine/.env'),
    resolve(projectRoot, 'modules/riga-flow/.env'),
  ]
  const loaded = []
  const seen = new Set()
  for (const file of candidates) {
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const entry = line.startsWith('export ') ? line.slice('export '.length) : line
      const equals = entry.indexOf('=')
      if (equals <= 0) continue
      const key = entry.slice(0, equals).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key)) continue
      seen.add(key)
      let value = entry.slice(equals + 1).trim()
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      const profileLake = key === 'TAC_LAKE_DIR'
        ? env.FINA_PROFILE_TAC_LAKE_DIR !== undefined
          ? env.FINA_PROFILE_TAC_LAKE_DIR || null
          : env.FINA_DATA_ROOT ? resolve(env.FINA_DATA_ROOT, 'lake') : null
        : null
      if (env[key] !== undefined && env[key] !== profileLake) continue
      env[key] = value
    }
    loaded.push(file.slice(projectRoot.length + 1))
  }
  return loaded
}

function parseArgs(values) {
  let cuda = false
  let publicHost = false
  let modeWasSet = false
  for (const value of values) {
    if (value === '--help' || value === '-h') return { help: true }
    if (value === '--cpu' || value === '--cuda') {
      if (modeWasSet && (value === '--cuda') !== cuda) {
        throw new Error('Choose only one of --cpu and --cuda.')
      }
      cuda = value === '--cuda'
      modeWasSet = true
      continue
    }
    if (value === '--public') {
      publicHost = true
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }
  return { cuda, publicHost }
}

function run(command, commandArgs, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`\n[dev:http] ${label}`)
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
    child.once('error', (error) => rejectPromise(new Error(`${label}: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${label} failed (${signal ?? `exit ${code}`}).`))
    })
  })
}

function cudaPreflight() {
  const nvcc = spawnSync('nvcc', ['--version'], { encoding: 'utf8' })
  if (nvcc.error || nvcc.status !== 0) {
    throw new Error('CUDA mode needs nvcc from CUDA Toolkit 13 or newer. Use the default CPU mode on Manus, or install CUDA before passing --cuda.')
  }
  const release = `${nvcc.stdout ?? ''}\n${nvcc.stderr ?? ''}`.match(/release\s+(\d+)\.(\d+)/i)
  if (!release || Number(release[1]) < 13) {
    throw new Error('CUDA mode needs CUDA Toolkit 13.0 or newer (the riga-mcp GPU feature is built against CUDA 13).')
  }
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' })
  if (gpu.error || gpu.status !== 0 || !gpu.stdout.trim()) {
    throw new Error('CUDA mode was requested, but no NVIDIA GPU is visible to nvidia-smi. Use the default CPU mode on Manus.')
  }
  console.log(`[dev:http] CUDA ${release[1]}.${release[2]} detected; GPU: ${gpu.stdout.trim().split('\n')[0]}`)
}

function tacEnvValue(name) {
  const fromProcess = process.env[name]?.trim()
  if (fromProcess) return fromProcess
  const envFile = resolve(root, 'modules/tac-engine/.env')
  if (!existsSync(envFile)) return ''
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) =>
    new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(entry),
  )
  if (!line) return ''
  let value = line.slice(line.indexOf('=') + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  } else {
    value = value.replace(/\s+#.*$/, '').trim()
  }
  return value
}

function tacConfigPreflight() {
  const missing = []
  const apiKeyId = tacEnvValue('APCA_API_KEY_ID')
  const apiSecretKey = tacEnvValue('APCA_API_SECRET_KEY')
  const hasApiKeyId = Boolean(apiKeyId && !/^your-/i.test(apiKeyId))
  const hasApiSecretKey = Boolean(apiSecretKey && !/^your-/i.test(apiSecretKey))
  if (hasApiKeyId !== hasApiSecretKey) {
    throw new Error('Set both APCA_API_KEY_ID and APCA_API_SECRET_KEY, or leave both unset for Yahoo fallback mode. Values are not printed.')
  }
  if (!hasApiKeyId) {
    console.log('[dev:http] Alpaca credentials not configured; TAC will use Yahoo daily stock history and free daily-FX sources. Trading and Alpaca-only endpoints will be unavailable.')
  }
  let lakeDir = tacEnvValue('TAC_LAKE_DIR')
  if (!lakeDir) {
    lakeDir = resolve(root, '.lake')
    process.env.TAC_LAKE_DIR = lakeDir
    console.log(`[dev:http] TAC_LAKE_DIR not configured; using workspace lake: ${lakeDir}`)
  }
  if (/\/absolute\/path\/to\/lake/i.test(lakeDir) || !isAbsolute(lakeDir)) {
    missing.push('TAC_LAKE_DIR (absolute path)')
  }
  if (missing.length > 0) {
    throw new Error(
      `Tac-engine configuration is required before starting HTTP mode: ${missing.join(', ')}. Set these in the environment, the checkout .env, or modules/tac-engine/.env (see modules/tac-engine/.env.example). Values are not printed.`,
    )
  }
}

function portReachable(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (reachable) => {
      socket.destroy()
      resolvePromise(reachable)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function assertPortsFree() {
  for (const [label, port] of [
    ['Vite', 5173],
    ['riga-mcp', 8788],
    ['tac-engine HTTP bridge', Number(process.env.TAC_MCP_HTTP_PORT ?? 8790)],
    ['trade-repo MCP', Number(process.env.TRADE_REPO_HTTP_PORT ?? 8792)],
    ['book MCP bridge', Number(process.env.BOOK_MCP_HTTP_PORT ?? 8795)],
    ['R&D MCP bridge', Number(process.env.RD_MCP_HTTP_PORT ?? 8796)],
    ['RiskCube MCP bridge', Number(process.env.RISKCUBE_MCP_HTTP_PORT ?? 8797)],
    ['fina-scraper MCP', Number(process.env.FINA_SCRAPER_HTTP_PORT ?? 8798)],
  ]) {
    if (await portReachable(port)) {
      throw new Error(`${label} port ${port} is already in use. Stop the existing process or free the port before starting dev:http.`)
    }
  }
}

function startService(label, command, commandArgs, { optional = false } = {}) {
  const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true })
  children.push({ label, child })
  child.once('error', (error) => {
    if (optional) {
      console.error(`[dev:http] ${label} unavailable: ${error.message}`)
      return
    }
    console.error(`[dev:http] ${label} failed to start: ${error.message}`)
    shutdown(1)
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    if (optional) {
      console.error(`[dev:http] ${label} unavailable (${signal ?? `code ${code}`}); continuing without it.`)
      return
    }
    console.error(`[dev:http] ${label} exited (${signal ?? `code ${code}`}); stopping the other services.`)
    shutdown(code === 0 ? 1 : (code ?? 1))
  })
  return child
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  if (children.length === 0) {
    process.exit(code)
    return
  }
  const closed = children.map(({ child }) => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done()
    else child.once('exit', done)
  }))
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const forceStop = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL')
    process.exit(code)
  }, 5000)
  forceStop.unref()
  Promise.all(closed).then(() => {
    clearTimeout(forceStop)
    process.exit(code)
  })
}

async function waitForPort(label, port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopping) throw new Error(`${label} stopped before becoming ready.`)
    if (await portReachable(port)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
  throw new Error(`${label} did not start listening on port ${port} within ${timeoutMs / 1000} seconds.`)
}

async function waitForOptionalPort(label, port, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stopping) return false
    if (child.exitCode !== null || child.signalCode !== null) return false
    if (await portReachable(port)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
  console.error(`[dev:http] ${label} did not start listening on port ${port} within ${timeoutMs / 1000} seconds; continuing without it.`)
  return false
}

async function main() {
  const options = parseArgs(args)
  if (options.help) {
    usage()
    return
  }
  const envFiles = loadLocalEnv()
  if (envFiles.length > 0) console.log(`[dev:http] Loaded local environment from ${envFiles.join(', ')}.`)
  const cargoBin = resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo'), 'bin')
  process.env.CARGO_TARGET_DIR ??= resolve(root, 'modules/target')
  const cargoExecutable = resolve(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  if (existsSync(cargoExecutable) && !process.env.PATH.split(delimiter).includes(cargoBin)) {
    process.env.PATH = `${cargoBin}${delimiter}${process.env.PATH}`
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js 22.19.0 or newer is required; found ${process.version}.`)
  }
  if (!existsSync(resolve(root, 'node_modules/vite/bin/vite.js'))) {
    throw new Error('Frontend dependencies are missing. Run npm ci first.')
  }
  for (const manifest of ['modules/riga-flow/crates/riga-mcp/Cargo.toml', 'modules/tac-engine/Cargo.toml']) {
    if (!existsSync(resolve(root, manifest))) {
      throw new Error(`Missing ${manifest}. Initialize submodules with: git submodule update --init --recursive`)
    }
  }
  if (options.cuda) cudaPreflight()
  tacConfigPreflight()
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  if (cargo.error || cargo.status !== 0) {
    throw new Error('Rust/Cargo is required to build the HTTP backends. Install the pinned toolchain from rust-toolchain.toml with rustup.')
  }
  await assertPortsFree()

  console.log(`[dev:http] Using ${options.cuda ? 'CUDA/GPU' : 'CPU'} for riga-mcp; tac-engine remains CPU.`)
  const rigaFeatures = options.cuda ? ['--features', 'gpu'] : []
  await run('cargo', [
    'build', '--locked', '--release', '--manifest-path', 'modules/riga-flow/crates/riga-mcp/Cargo.toml',
    '--bin', 'riga-mcp', ...rigaFeatures,
  ], 'Building riga-mcp HTTP backend')
  await run('cargo', [
    'build', '--locked', '--release', '--manifest-path', 'modules/tac-engine/Cargo.toml', '--bin', 'tac-engine',
  ], 'Building tac-engine backend')

  const exe = process.platform === 'win32' ? '.exe' : ''
  const rigaBinary = process.env.RIGA_MCP_BIN || resolve(process.env.CARGO_TARGET_DIR, `release/riga-mcp${exe}`)
  if (!existsSync(rigaBinary)) throw new Error(`riga-mcp build output not found: ${rigaBinary}`)
  const tacBinary = process.env.TAC_ENGINE_BIN || resolve(process.env.CARGO_TARGET_DIR, `release/tac-engine${exe}`)
  if (!existsSync(tacBinary)) throw new Error(`tac-engine build output not found: ${tacBinary}`)

  startService('riga-mcp', rigaBinary, [
    '--transport', 'http', '--bind', '127.0.0.1:8788', '--allowed-host', 'localhost', '--allowed-host', '127.0.0.1',
  ])
  startService('tac-engine HTTP bridge', process.execPath, [resolve(root, 'scripts/tac-mcp-http.mjs')])
  startService('trade-repo MCP', process.execPath, [resolve(root, 'scripts/trade-repo-mcp-http.mjs'), '--seed'])
  const book = startService('book MCP bridge', process.execPath, [resolve(root, 'scripts/book-mcp-http.mjs')], { optional: true })
  const rd = startService('R&D MCP bridge', process.execPath, [resolve(root, 'scripts/rd-mcp-http.mjs')], { optional: true })
  const riskcube = startService('RiskCube MCP bridge', process.execPath, [resolve(root, 'scripts/riskcube-mcp-http.mjs')], { optional: true })
  // Revamp F1: fina-scraper sidecar, Streamable HTTP on 127.0.0.1:8798.
  // Optional, like the qlib bridges: the launcher exits 1 when the binary
  // is missing or NIP_LAKE_DIR is unset, and dev:http keeps going without it.
  const finaScraper = startService('fina-scraper MCP', process.execPath, [resolve(root, 'scripts/fina-scraper-mcp-http.mjs')], { optional: true })
  const viteArgs = [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', options.publicHost ? '0.0.0.0' : '127.0.0.1']
  startService('Vite', process.execPath, viteArgs)

  await Promise.all([
    waitForPort('riga-mcp', 8788),
    waitForPort('tac-engine HTTP bridge', Number(process.env.TAC_MCP_HTTP_PORT ?? 8790)),
    waitForPort('trade-repo MCP', Number(process.env.TRADE_REPO_HTTP_PORT ?? 8792)),
    waitForPort('Vite', 5173),
  ])
  const qlibTimeout = Number(process.env.QLIB_MCP_STARTUP_TIMEOUT_MS ?? 300_000)
  const [bookReady, rdReady, riskcubeReady, finaScraperReady] = await Promise.all([
    waitForOptionalPort('book MCP bridge', Number(process.env.BOOK_MCP_HTTP_PORT ?? 8795), book, qlibTimeout),
    waitForOptionalPort('R&D MCP bridge', Number(process.env.RD_MCP_HTTP_PORT ?? 8796), rd, qlibTimeout),
    waitForOptionalPort('RiskCube MCP bridge', Number(process.env.RISKCUBE_MCP_HTTP_PORT ?? 8797), riskcube),
    waitForOptionalPort('fina-scraper MCP', Number(process.env.FINA_SCRAPER_HTTP_PORT ?? 8798), finaScraper),
  ])
  if (stopping) return
  console.log(`\n[dev:http] Ready: http://127.0.0.1:5173/${options.publicHost ? ' (Vite bound to 0.0.0.0)' : ''}`)
  console.log('[dev:http] Ready: trade-repo MCP at http://127.0.0.1:8792/mcp.')
  console.log(`[dev:http] Optional bridges: book ${bookReady ? 'ready' : 'unavailable'}, R&D ${rdReady ? 'ready' : 'unavailable'}, RiskCube ${riskcubeReady ? 'ready' : 'unavailable'}, fina-scraper ${finaScraperReady ? 'ready' : 'unavailable'}.`)
  console.log('[dev:http] Press Ctrl+C to stop all services.')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  process.once('SIGINT', () => shutdown(130))
  process.once('SIGTERM', () => shutdown(143))
  main().catch((error) => {
    console.error(`[dev:http] ${error.message}`)
    if (children.length > 0) shutdown(1)
    else process.exitCode = 1
  })
}
