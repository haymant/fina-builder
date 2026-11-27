import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const root = process.cwd()
const runId = process.env.NIP_E2E_RUN_ID
if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,95}$/u.test(runId) || runId === '.' || runId === '..') {
  throw new Error('Set NIP_E2E_RUN_ID to a fresh, unique 3–96 character test run ID before starting the disposable NIP service')
}
const runRoot = resolve(root, 'playwright/.data/nip', runId)
const dataDir = resolve(runRoot, '_nip')
const lakeDir = runRoot
if (!runRoot.startsWith(`${resolve(root, 'playwright/.data/nip')}/`)) {
  throw new Error('NIP_E2E_RUN_ID must resolve inside playwright/.data/nip')
}
const bridgeToken = process.env.NIP_BRIDGE_FIXTURE_TOKEN ?? 'nip-e2e-bridge-token'
const bridgeUrl = process.env.NIP_RIGA_BRIDGE_URL ?? 'http://127.0.0.1:8796'
const transcriptFile = process.env.NIP_E2E_TRANSCRIPT_FILE
  ? resolve(root, process.env.NIP_E2E_TRANSCRIPT_FILE)
  : undefined
if (transcriptFile && !transcriptFile.startsWith(`${root}/`)) {
  throw new Error('NIP_E2E_TRANSCRIPT_FILE must stay inside the repository')
}
const testTranscript = transcriptFile ? readFileSync(transcriptFile, 'utf8').trim() : undefined
if (testTranscript !== undefined && !testTranscript) throw new Error('NIP E2E transcript fixture must not be empty')

const cargoCandidates = [
  process.env.CARGO_BIN,
  `${homedir()}/.cargo/bin/cargo`,
  '/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin/cargo',
  'cargo',
].filter(Boolean)
const cargo = cargoCandidates.find((candidate) => candidate === 'cargo' || existsSync(candidate)) ?? 'cargo'

if (existsSync(runRoot) || existsSync(dataDir)) {
  throw new Error(`Refusing to reuse or delete existing NIP E2E data: ${runRoot}`)
}

const child = spawn(cargo, ['run', '-p', 'nip-engine', '--', '--transport', 'http', '--bind', '127.0.0.1:8794'], {
  cwd: root,
  env: {
    ...process.env,
    ...(testTranscript ? { NIP_TEST_TRANSCRIPT: testTranscript } : {}),
    NIP_TEST_MODE: '1',
    NIP_LAKE_DIR: lakeDir,
    DATABASE_URL: '',
    VECTOR_DB_URL: '',
    NIP_COMFYUI_URL: '',
    NIP_RIGA_BRIDGE_URL: bridgeUrl,
    NIP_RIGA_BRIDGE_TOKEN: bridgeToken,
    PATH: `${homedir()}/.cargo/bin:${process.env.PATH ?? ''}`,
  },
  stdio: 'inherit',
})

const stop = (signal) => child.kill(signal)
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
