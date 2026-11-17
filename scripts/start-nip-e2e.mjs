import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'

const root = process.cwd()
const dataDir = `${root}/playwright/.data/nip/e2e-run`
const lakeDir = `${root}/playwright/.data/nip-lake/e2e-run`
const cargo = process.env.CARGO_BIN ?? '/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin/cargo'
rmSync(dataDir, { recursive: true, force: true })
rmSync(lakeDir, { recursive: true, force: true })

const child = spawn(cargo, ['run', '-p', 'nip-engine', '--', '--transport', 'http', '--bind', '127.0.0.1:8794'], {
  cwd: root,
  env: {
    ...process.env,
    NIP_TEST_MODE: '1',
    NIP_DATA_DIR: dataDir,
    NIP_LAKE_DIR: lakeDir,
    DATABASE_URL: '',
    VECTOR_DB_URL: '',
    NIP_COMFYUI_URL: '',
    PATH: `/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin:${process.env.PATH ?? ''}`,
  },
  stdio: 'inherit',
})

const stop = (signal) => child.kill(signal)
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
