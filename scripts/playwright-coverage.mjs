import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const rawCoverageDir = join(root, '.nyc_output')
const coverageDir = join(root, 'coverage')
const keepExistingCoverage = process.env.MERGE_WITH_UNIT_COVERAGE === 'true'
const playwrightCli = join(root, 'node_modules', '@playwright', 'test', 'cli.js')
const nycCli = join(root, 'node_modules', 'nyc', 'bin', 'nyc.js')

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(result.error)
    return 1
  }
  return result.status ?? 1
}

if (!keepExistingCoverage) {
  await rm(rawCoverageDir, { recursive: true, force: true })
  for (const reportDir of ['ui', 'combined']) {
    await rm(join(coverageDir, reportDir), { recursive: true, force: true })
  }
}

const coverageWorkers = process.env.PLAYWRIGHT_COVERAGE_WORKERS ?? '2'
const playwrightStatus = run([playwrightCli, 'test', `--workers=${coverageWorkers}`, ...process.argv.slice(2)], {
  ...process.env,
  VITE_COVERAGE: 'true',
  PLAYWRIGHT_COVERAGE: 'true',
})

let coverageFiles = []
try {
  coverageFiles = (await readdir(rawCoverageDir)).filter((file) => file.startsWith('playwright-') && file.endsWith('.json'))
} catch {
  // A zero-test grep or failed server startup may leave no coverage directory.
}

let reportStatus = 0
if (coverageFiles.length === 0) {
  console.error('No browser Istanbul counters were collected. Check that the selected tests load the app through the shared Playwright fixture.')
  reportStatus = 1
} else {
  const mergedCoverage = join(coverageDir, 'ui', 'merged-coverage.json')
  const mergeStatus = run([nycCli, 'merge', rawCoverageDir, mergedCoverage])
  if (mergeStatus !== 0) {
    reportStatus = mergeStatus
  } else {
    await rm(rawCoverageDir, { recursive: true, force: true })
    await mkdir(rawCoverageDir, { recursive: true })
    await copyFile(mergedCoverage, join(rawCoverageDir, 'out.json'))
    reportStatus = run([
      nycCli,
      'report',
      '--reporter=text-summary',
      '--reporter=lcov',
      '--reporter=json',
      '--report-dir=coverage/ui',
      '--exclude-after-remap=false',
    ])
  }
}

process.exitCode = playwrightStatus || reportStatus
