import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const reports = [
  { name: 'UI (Vitest + Playwright)', path: join(root, 'coverage', 'ui', 'lcov.info') },
  { name: 'Rust (payoff-explorer)', path: join(root, 'coverage', 'rust', 'lcov.info') },
  { name: 'Rust (riga)', path: join(root, 'coverage', 'rust', 'riga', 'lcov.info') },
  { name: 'Rust (riga-flow)', path: join(root, 'coverage', 'rust', 'riga-flow', 'lcov.info') },
  { name: 'Rust (tac-engine)', path: join(root, 'coverage', 'rust', 'tac-engine', 'lcov.info') },
]

function summarizeText(text) {
  let files = 0
  let found = 0
  let hit = 0
  let inFile = false

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      files += 1
      inFile = true
    } else if (inFile && line.startsWith('LF:')) {
      found += Number(line.slice(3))
    } else if (inFile && line.startsWith('LH:')) {
      hit += Number(line.slice(3))
      inFile = false
    }
  }

  return { files, found, hit, percent: found ? (100 * hit) / found : 0 }
}

const availableReports = new Map()
for (const report of reports) {
  try {
    availableReports.set(report.name, await readFile(report.path, 'utf8'))
  } catch {
    // Keep summaries useful when a test stage fails before creating its report.
  }
}

const rustReports = reports.filter((report) => report.name.startsWith('Rust ('))
const availableRust = rustReports
  .map((report) => availableReports.get(report.name))
  .filter(Boolean)
const rustCombinedPath = join(root, 'coverage', 'rust', 'combined', 'lcov.info')
await rm(rustCombinedPath, { force: true })
if (availableRust.length) {
  await mkdir(join(root, 'coverage', 'rust', 'combined'), { recursive: true })
  const rustCombined = `${availableRust.map((text) => text.trimEnd()).join('\n')}\n`
  await writeFile(rustCombinedPath, rustCombined, 'utf8')
  availableReports.set('Rust (all workspaces)', rustCombined)
  console.log(`Combined Rust LCOV written to ${rustCombinedPath}`)
}

const uiReport = availableReports.get('UI (Vitest + Playwright)')
const combinedPath = join(root, 'coverage', 'combined', 'lcov.info')
await rm(combinedPath, { force: true })
const allCodeReports = [uiReport, ...availableRust].filter(Boolean)
if (allCodeReports.length) {
  await mkdir(join(root, 'coverage', 'combined'), { recursive: true })
  const combined = `${allCodeReports.map((text) => text.trimEnd()).join('\n')}\n`
  await writeFile(combinedPath, combined, 'utf8')
  availableReports.set('All code (UI + Rust)', combined)
  console.log(`Combined UI and Rust LCOV written to ${combinedPath}`)
}

const summaryReports = [
  ...reports,
  { name: 'Rust (all workspaces)', path: rustCombinedPath },
  { name: 'All code (UI + Rust)', path: combinedPath },
]
const rows = []
for (const report of summaryReports) {
  const text = availableReports.get(report.name)
  if (text) rows.push({ name: report.name, ...summarizeText(text) })
  else rows.push({ name: report.name, files: 0, found: 0, hit: 0, percent: 0, missing: true })
}

const lines = [
  '## Code coverage',
  '',
  '| Suite | Line coverage | Covered / total lines | Files |',
  '| --- | ---: | ---: | ---: |',
  ...rows.map((row) => `| ${row.name}${row.missing ? ' (report missing)' : ''} | ${row.percent.toFixed(1)}% | ${row.hit} / ${row.found} | ${row.files} |`),
  '',
]
const summary = lines.join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
}
