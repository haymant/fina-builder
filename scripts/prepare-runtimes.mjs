#!/usr/bin/env node
/** Prepare all developer runtimes required before starting the Tauri desktop shell. */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modulesDir = resolve(root, 'modules')
const sharedPythonEnv = resolve(modulesDir, '.venv')
const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? resolve(modulesDir, 'target') }

function run(command, args, label, options = {}) {
  console.log(`[runtime] ${label}`)
  try {
    execFileSync(command, args, { cwd: root, env, stdio: 'inherit', ...options })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} failed: ${detail}`)
  }
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} was not produced at ${path}`)
}

function main() {
  requireFile(resolve(root, 'modules/riga-flow/Cargo.toml'), 'riga-flow submodule')
  requireFile(resolve(root, 'modules/tac-engine/Cargo.toml'), 'tac-engine submodule')
  run('bash', ['scripts/build-engine-sidecar.sh', 'riga-flow', 'riga-mcp', 'RIGA_MCP_BIN'], 'Build riga-mcp')
  run('bash', ['scripts/build-engine-sidecar.sh', 'tac-engine', 'tac-engine', 'TAC_ENGINE_BIN'], 'Build tac-engine')
  run('bash', ['scripts/build-nip-sidecar.sh'], 'Build nip-engine')

  run('uv', ['sync', '--project', resolve(modulesDir, 'tac-qlib'), '--locked'], 'Synchronize shared TAC Python environment', {
    env: { ...env, UV_PROJECT_ENVIRONMENT: sharedPythonEnv },
  })
  const python = resolve(sharedPythonEnv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  requireFile(python, 'shared TAC Python interpreter')
  run(python, ['-c', 'import tac_qlib.rd_server, tac_qlib.book_server'], 'Verify TAC R&D/book imports', {
    env: { ...env, PYTHONPATH: resolve(modulesDir, 'tac-qlib'), UV_PROJECT_ENVIRONMENT: sharedPythonEnv },
  })
  console.log(`[runtime] ready: Rust=${env.CARGO_TARGET_DIR}; Python=${python}`)
}

try {
  main()
} catch (error) {
  console.error(`[runtime] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
