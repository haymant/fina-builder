import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const coverageDir = join(root, 'coverage')
const rawCoverageDir = join(root, '.nyc_output')
const vitestCoverage = join(coverageDir, 'vitest', 'coverage-final.json')
const rawVitestCoverage = join(rawCoverageDir, 'vitest.json')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, env = process.env) {
  const result = spawnSync(npm, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) {
    console.error(result.error)
    return 1
  }
  return result.status ?? 1
}

for (const reportDir of ['ui', 'vitest', 'combined']) {
  await rm(join(coverageDir, reportDir), { recursive: true, force: true })
}
await rm(rawCoverageDir, { recursive: true, force: true })

console.log('\n=== Vitest/jsdom Istanbul coverage ===')
const vitestStatus = run(['run', 'test:coverage'])
let hasVitestCoverage = false
try {
  await stat(vitestCoverage)
  await mkdir(rawCoverageDir, { recursive: true })
  await copyFile(vitestCoverage, rawVitestCoverage)
  hasVitestCoverage = true
} catch {
  console.error(`Vitest did not produce ${vitestCoverage}`)
}

console.log('\n=== Playwright browser Istanbul coverage ===')
const playwrightStatus = run(['run', 'test:e2e:coverage'], {
  ...process.env,
  MERGE_WITH_UNIT_COVERAGE: 'true',
})

if (!hasVitestCoverage || vitestStatus !== 0 || playwrightStatus !== 0) {
  process.exitCode = 1
}
