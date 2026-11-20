#!/usr/bin/env node
/**
 * Launch one tac-qlib MCP service from its module-local uv environment.
 *
 * Usage:
 *   node scripts/tac-qlib-mcp.mjs rd
 *   node scripts/tac-qlib-mcp.mjs book
 *
 * The child owns the MCP protocol on stdio; this wrapper only resolves the
 * interpreter, applies the module cwd/PYTHONPATH, and forwards signals.
 */
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleRoot = resolve(root, 'modules/tac-qlib')
const service = process.argv[2]
const entry = service === 'rd' ? 'tac_qlib.rd_server' : service === 'book' ? 'tac_qlib.book_server' : null
if (!entry) {
  console.error('Usage: node scripts/tac-qlib-mcp.mjs <rd|book>')
  process.exit(2)
}

function syncModuleEnvironment() {
  try {
    execFileSync('uv', ['--version'], { cwd: moduleRoot, stdio: 'pipe', env: process.env })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error('uv is required to prepare the tac-qlib sidecar. Install uv and retry.')
    } else {
      console.error(`Unable to run uv --version: ${error instanceof Error ? error.message : String(error)}`)
    }
    process.exit(1)
  }

  try {
    execFileSync('uv', ['sync', '--project', moduleRoot, '--locked'], {
      cwd: moduleRoot,
      stdio: 'inherit',
      env: process.env,
    })
  } catch (error) {
    console.error(
      `Unable to synchronize tac-qlib with uv --locked. Check modules/tac-qlib/pyproject.toml and uv.lock.\n${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }
}

// Only pass variables that are part of the tac-qlib runtime contract. In
// particular, do not forward arbitrary host environment variables or secrets
// into the child process merely because they happen to be present in the shell.
const RUNTIME_ENV_KEYS = [
  'TAC_LAKE_DIR',
  'TAC_RD_IN_SYSTEMD',
  'MLFLOW_ALLOW_FILE_STORE',
  'MLRUNS_URI',
  'DATABASE_URL',
  'APCA_API_KEY_ID',
  'APCA_API_SECRET_KEY',
  'APCA_API_BASE_URL',
  'GIT_REPO_URL',
  'GIT_USER',
  'GIT_PASS',
  'EMBEDDING_API_BASE_URL',
  'EMBEDDING_API_KEY',
]

function buildChildEnvironment() {
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: moduleRoot,
  }
  for (const key of RUNTIME_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
}

syncModuleEnvironment()

const python = resolve(moduleRoot, '.venv/bin/python')
if (!existsSync(python)) {
  console.error(`uv sync completed but the tac-qlib interpreter was not created at ${python}`)
  process.exit(1)
}

const env = buildChildEnvironment()
const child = spawn(python, ['-m', entry], { cwd: moduleRoot, env, stdio: 'inherit' })
const forward = (signal) => child.kill(signal)
process.once('SIGINT', () => forward('SIGINT'))
process.once('SIGTERM', () => forward('SIGTERM'))
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
