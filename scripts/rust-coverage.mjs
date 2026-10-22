import { spawnSync } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))
const coverageRoot = join(root, 'coverage', 'rust')
const targets = [
  {
    name: 'payoff-explorer',
    cwd: root,
    manifest: join(root, 'Cargo.toml'),
    output: join(coverageRoot, 'lcov.info'),
  },
  {
    name: 'riga',
    cwd: join(root, 'modules', 'riga'),
    manifest: join(root, 'modules', 'riga', 'Cargo.toml'),
    output: join(coverageRoot, 'riga', 'lcov.info'),
  },
  {
    name: 'riga-flow',
    cwd: join(root, 'modules', 'riga-flow'),
    manifest: join(root, 'modules', 'riga-flow', 'Cargo.toml'),
    output: join(coverageRoot, 'riga-flow', 'lcov.info'),
  },
  {
    name: 'tac-engine',
    cwd: join(root, 'modules', 'tac-engine'),
    manifest: join(root, 'modules', 'tac-engine', 'Cargo.toml'),
    output: join(coverageRoot, 'tac-engine', 'lcov.info'),
  },
]

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
const env = {
  ...process.env,
  PATH: [join(cargoHome, 'bin'), process.env.PATH || ''].filter(Boolean).join(delimiter),
}
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'

await rm(coverageRoot, { recursive: true, force: true })
let failures = 0

for (const target of targets) {
  console.log(`\n=== Rust coverage: ${target.name} ===`)
  try {
    await stat(target.manifest)
  } catch {
    console.error(`Missing Cargo manifest: ${target.manifest}. Initialize submodules with git submodule update --init --recursive.`)
    failures += 1
    continue
  }

  await mkdir(dirname(target.output), { recursive: true })
  const result = spawnSync(
    cargo,
    ['llvm-cov', '--workspace', '--locked', '--lcov', '--output-path', target.output],
    { cwd: target.cwd, env, stdio: 'inherit' },
  )

  if (result.error) {
    console.error(`Could not run cargo llvm-cov for ${target.name}: ${result.error.message}`)
    failures += 1
    continue
  }
  if (result.status !== 0) {
    console.error(`cargo llvm-cov failed for ${target.name} (exit ${result.status ?? 'unknown'})`)
    failures += 1
    continue
  }

  try {
    const report = await stat(target.output)
    if (report.size === 0) throw new Error('the LCOV file is empty')
    console.log(`LCOV: ${target.output} (${report.size} bytes)`)
  } catch (error) {
    console.error(`Coverage command did not produce a usable report for ${target.name}: ${error.message}`)
    failures += 1
  }
}

if (failures) {
  console.error(`\nRust coverage finished with ${failures} failed workspace(s). Reports from successful workspaces were preserved.`)
  process.exitCode = 1
} else {
  console.log('\nRust coverage completed successfully for the app and all dependency modules.')
}
