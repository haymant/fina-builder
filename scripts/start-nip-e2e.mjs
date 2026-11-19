import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const root = process.cwd()
const runId = process.env.NIP_E2E_RUN_ID ?? 'e2e-run'
const dataDir = `${root}/playwright/.data/nip/${runId}`
const lakeDir = `${root}/playwright/.data/nip-lake/${runId}`
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

rmSync(dataDir, { recursive: true, force: true })
rmSync(lakeDir, { recursive: true, force: true })

const child = spawn(cargo, ['run', '-p', 'nip-engine', '--', '--transport', 'http', '--bind', '127.0.0.1:8794'], {
  cwd: root,
  env: {
    ...process.env,
    ...(testTranscript ? { NIP_TEST_TRANSCRIPT: testTranscript } : {}),
    NIP_TEST_MODE: '1',
    NIP_DATA_DIR: dataDir,
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
