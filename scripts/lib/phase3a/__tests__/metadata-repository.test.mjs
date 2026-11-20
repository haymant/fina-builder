import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Phase3ARepository,
  Phase3ARepositoryError,
  createPhase3AStore,
} from '../metadata-repository.mjs'

const stores = []
afterEach(async () => {
  while (stores.length) await stores.pop().close()
})

function repo(url = 'memory:') {
  const store = createPhase3AStore(url)
  stores.push(store)
  return new Phase3ARepository(store)
}

describe('Phase 3A model registry', () => {
  it('creates and reloads a safe model metadata entry', async () => {
    const r = repo()
    await r.init()
    const model = await r.createModel({
      name: 'demo-signal-v1', description: 'Synthetic fixture model', status: 'active',
      experimentId: 'exp-fixture', runId: 'run-fixture', metrics: { sharpe: '1.25', count: 12 },
    })
    expect(model).toMatchObject({ name: 'demo-signal-v1', experimentId: 'exp-fixture', metrics: { sharpe: '1.25', count: 12 } })
    expect(await r.getModel(model.id)).toEqual(model)
    expect(await r.listModels()).toEqual([model])
  })

  it('rejects duplicate names and secret-bearing metadata', async () => {
    const r = repo(); await r.init()
    await r.createModel({ name: 'unique-model' })
    await expect(r.createModel({ name: 'unique-model' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(r.createModel({ name: 'secret-model', metadata: { apiKey: 'never-store' } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('blocks deletion while a scheduler job references the model', async () => {
    const r = repo(); await r.init()
    const model = await r.createModel({ name: 'referenced-model' })
    await r.createJob({ name: 'morning-run', timezone: 'UTC', time: '09:30', weekdays: ['MO', 'FR'], modelRegistryId: model.id })
    await expect(r.deleteModel(model.id)).rejects.toMatchObject({ code: 'REFERENCE_CONFLICT' })
    expect(await r.getModel(model.id)).toEqual(expect.objectContaining({ id: model.id }))
  })
})

describe('Phase 3A scheduler configuration and manual attempts', () => {
  it('validates schedules and creates an idempotent manual attempt', async () => {
    const r = repo(); await r.init()
    const job = await r.createJob({ name: 'weekday-run', timezone: 'America/New_York', time: '09:30', weekdays: ['FR', 'MO'], enabled: true })
    expect(job.weekdays).toEqual(['FR', 'MO'])
    await expect(r.createJob({ name: 'bad', timezone: 'Not/AZone', time: '09:30', weekdays: ['MO'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(r.createJob({ name: 'bad', timezone: 'UTC', time: '9:30', weekdays: ['MO'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    const first = await r.createRunAttempt({ schedulerJobId: job.id, idempotencyKey: 'manual-1', triggerSource: 'manual', snapshot: { strategy: 'fixture' } })
    const second = await r.createRunAttempt({ schedulerJobId: job.id, idempotencyKey: 'manual-1', triggerSource: 'manual', snapshot: { strategy: 'different' } })
    expect(first.reused).toBe(false)
    expect(second).toMatchObject({ reused: true, id: first.id })
    expect(second.snapshot).toEqual({ strategy: 'fixture' })
  })

  it('rejects unknown model and job references', async () => {
    const r = repo(); await r.init()
    await expect(r.createJob({ name: 'missing-model', timezone: 'UTC', time: '08:00', weekdays: ['MO'], modelRegistryId: 'model_missing' })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' })
    await expect(r.createRunAttempt({ schedulerJobId: 'job_missing', idempotencyKey: 'attempt-1' })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' })
  })

  it('supports bounded operational retention without touching models or jobs', async () => {
    const r = repo(); await r.init()
    const job = await r.createJob({ name: 'retention', timezone: 'UTC', time: '08:00', weekdays: ['MO'] })
    const attempt = await r.createRunAttempt({ schedulerJobId: job.id, idempotencyKey: 'old-attempt' })
    expect(await r.purgeRunAttempts('2099-01-01T00:00:00Z')).toMatchObject({ deleted: 1 })
    expect(await r.getJob(job.id)).toEqual(expect.objectContaining({ id: job.id }))
  })
})

describe('Phase 3A SQLite adapter', () => {
  it('survives restart and keeps migrations idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fina-phase3a-'))
    const file = join(dir, 'metadata.sqlite')
    try {
      const firstStore = createPhase3AStore(`sqlite:${file}`); stores.push(firstStore)
      const first = new Phase3ARepository(firstStore); await first.init()
      const model = await first.createModel({ name: 'restart-model', metrics: { pnl: '-12.500' } })
      await firstStore.close(); stores.splice(stores.indexOf(firstStore), 1)
      const secondStore = createPhase3AStore(`sqlite:${file}`); stores.push(secondStore)
      const second = new Phase3ARepository(secondStore); await second.init(); await second.init()
      expect(await second.getModel(model.id)).toEqual(expect.objectContaining({ id: model.id, metrics: { pnl: '-12.500' } }))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails clearly for unsupported configuration', () => {
    expect(() => createPhase3AStore('mysql://localhost/db')).toThrowError(Phase3ARepositoryError)
  })
})
