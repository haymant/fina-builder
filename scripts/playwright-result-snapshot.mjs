#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/playwright-result-snapshot.mjs <playwright-json-report>')
  process.exit(2)
}

const report = JSON.parse(await readFile(path, 'utf8'))
const tests = []
const statuses = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown']

function normalizeStatus(test) {
  const result = test.results?.at(-1)
  const status = result?.status ?? test.status
  if (statuses.includes(status)) return status
  if (status === 'expected' || status === 'flaky') return result?.status ?? 'passed'
  if (status === 'unexpected') return 'failed'
  return 'unknown'
}

function walk(suite, parents = []) {
  const ancestry = suite.title ? [...parents, suite.title] : parents
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.at(-1)
      const tags = [...new Set([...(spec.tags ?? []), ...(test.tags ?? [])]
        .map((tag) => typeof tag === 'string' ? tag : tag.tag)
        .filter(Boolean)
        .map((tag) => tag.startsWith('@') ? tag : `@${tag}`))]
      tests.push({
        title: [...ancestry, spec.title].filter(Boolean).join(' › '),
        project: test.projectName ?? 'default',
        status: normalizeStatus(test),
        tags,
        duration: result?.duration ?? 0,
        error: result?.error?.message ?? result?.errors?.[0]?.message,
      })
    }
  }
  for (const child of suite.suites ?? []) walk(child, ancestry)
}

for (const suite of report.suites ?? []) walk(suite)
const totals = Object.fromEntries(statuses.map((status) => [status, tests.filter((test) => test.status === status).length]))
const tagStats = new Map()
for (const test of tests) {
  for (const tag of test.tags) {
    if (!tag.startsWith('@journey-') && !tag.startsWith('@feature-')) continue
    const entry = tagStats.get(tag) ?? Object.fromEntries(statuses.map((status) => [status, 0]))
    entry[test.status] += 1
    tagStats.set(tag, entry)
  }
}

console.log('# Playwright result snapshot')
console.log('')
console.log(`- Run: ${report.config?.metadata?.ci ? 'CI' : 'local'}${report.stats?.startTime ? ` · ${report.stats.startTime}` : ''}`)
console.log(`- Tests: ${tests.length} total · ${totals.passed} passed · ${totals.failed} failed · ${totals.timedOut} timed out · ${totals.skipped} skipped · ${totals.interrupted} interrupted`)
console.log('')
console.log('## By journey / feature')
if (tagStats.size === 0) console.log('- No journey/feature tags found in JSON report.')
for (const [tag, counts] of [...tagStats].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`- ${tag}: ${counts.passed} passed, ${counts.failed} failed, ${counts.timedOut} timed out, ${counts.skipped} skipped, ${counts.interrupted} interrupted`)
}
console.log('')
console.log('## Test cases')
for (const test of tests) {
  console.log(`- **${test.status}** [${test.project}] ${test.title}${test.tags.length ? ` — ${test.tags.join(' ')}` : ''}`)
  if (test.error && test.status !== 'passed') console.log(`  - ${test.error.split('\n')[0]}`)
}
if (totals.failed > 0 || totals.timedOut > 0 || totals.interrupted > 0 || totals.unknown > 0) process.exitCode = 1
