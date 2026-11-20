import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  canonicalizeDecimal,
  canonicalizeIntegerString,
  normalizeUtcTimestamp,
  safeJsonStringify,
  redactDiagnostic,
  assertSafeInteger,
} from '../phase3-contracts/serialization.mjs'

const require = createRequire(import.meta.url)
const ROOT = dirname(fileURLToPath(import.meta.url))
const MAX_TEXT = 512
const MAX_JSON_BYTES = 64_000
const STATUSES = new Set(['active', 'inactive', 'archived', 'unresolved'])
const ATTEMPT_STATUSES = new Set(['queued', 'started', 'succeeded', 'failed', 'cancelled', 'unavailable'])
const TRIGGER_SOURCES = new Set(['manual', 'schedule', 'retry', 'recovery'])
const WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

export class Phase3ARepositoryError extends Error {
  constructor(code, message, { retryable = false, details = [] } = {}) {
    super(message)
    this.name = 'Phase3ARepositoryError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

const fail = (code, message, details = []) => { throw new Phase3ARepositoryError(code, message, { details }) }
const text = (value, field, { required = false, max = MAX_TEXT } = {}) => {
  if (value === undefined || value === null) {
    if (required) fail('VALIDATION', `${field} is required`)
    return null
  }
  if (typeof value !== 'string' || !value.trim()) fail('VALIDATION', `${field} must be a non-empty string`)
  if (value.length > max) fail('VALIDATION', `${field} exceeds ${max} characters`)
  return value.trim()
}
const optionalText = (value, field, options = {}) => text(value, field, options)
const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${randomUUID()}`
const json = (value, field) => {
  if (value === undefined || value === null) return null
  try { return safeJsonStringify(value, { maxBytes: MAX_JSON_BYTES }) } catch (error) {
    fail('VALIDATION', `${field} is not safe JSON: ${error.message}`)
  }
}
const parseJson = (value) => value === null || value === undefined ? null : JSON.parse(value)
const normalizedRecord = (record) => JSON.parse(JSON.stringify(record))

function validateModelInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION', 'model registry entry must be an object')
  const out = {}
  if (!partial || input.name !== undefined) out.name = text(input.name, 'name', { required: true, max: 128 })
  if (!partial || input.description !== undefined) out.description = optionalText(input.description, 'description', { max: 2000 })
  if (!partial || input.status !== undefined) {
    out.status = input.status ?? 'active'
    if (!STATUSES.has(out.status)) fail('VALIDATION', `status must be one of ${[...STATUSES].join(', ')}`)
  }
  if (!partial || input.strategyId !== undefined) out.strategyId = optionalText(input.strategyId, 'strategyId', { max: 128 })
  if (!partial || input.experimentId !== undefined) out.experimentId = optionalText(input.experimentId, 'experimentId', { max: 256 })
  if (!partial || input.runId !== undefined) out.runId = optionalText(input.runId, 'runId', { max: 256 })
  if (!partial || input.artifactRef !== undefined) out.artifactRef = optionalText(input.artifactRef, 'artifactRef', { max: 512 })
  if (!partial || input.metrics !== undefined) out.metrics = input.metrics === null ? null : input.metrics
  if (!partial || input.metadata !== undefined) out.metadata = input.metadata === null ? null : input.metadata
  return out
}

function validateSchedule(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION', 'scheduler job must be an object')
  const out = {}
  if (!partial || input.name !== undefined) out.name = text(input.name, 'name', { required: true, max: 128 })
  if (!partial || input.timezone !== undefined) {
    out.timezone = text(input.timezone, 'timezone', { required: true, max: 64 })
    try { new Intl.DateTimeFormat('en-US', { timeZone: out.timezone }).format() } catch { fail('VALIDATION', `invalid IANA timezone: ${out.timezone}`) }
  }
  if (!partial || input.time !== undefined) {
    out.time = text(input.time, 'time', { required: true, max: 5 })
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time)) fail('VALIDATION', 'time must use HH:MM')
  }
  if (!partial || input.weekdays !== undefined) {
    if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) fail('VALIDATION', 'weekdays must be a non-empty array')
    out.weekdays = [...new Set(input.weekdays.map((day) => text(day, 'weekday', { max: 2 })))].sort()
    if (out.weekdays.some((day) => !WEEKDAYS.has(day))) fail('VALIDATION', 'weekdays must use ISO abbreviations MO..SU')
  }
  if (!partial || input.strategyId !== undefined) out.strategyId = optionalText(input.strategyId, 'strategyId', { max: 128 })
  if (!partial || input.modelRegistryId !== undefined) out.modelRegistryId = optionalText(input.modelRegistryId, 'modelRegistryId', { max: 256 })
  if (!partial || input.experimentId !== undefined) out.experimentId = optionalText(input.experimentId, 'experimentId', { max: 256 })
  if (!partial || input.runId !== undefined) out.runId = optionalText(input.runId, 'runId', { max: 256 })
  if (!partial || input.enabled !== undefined) {
    out.enabled = input.enabled === undefined ? true : input.enabled
    if (typeof out.enabled !== 'boolean') fail('VALIDATION', 'enabled must be boolean')
  }
  if (!partial || input.overlapPolicy !== undefined) {
    out.overlapPolicy = input.overlapPolicy ?? 'reject'
    if (!['reject', 'queue', 'coalesce'].includes(out.overlapPolicy)) fail('VALIDATION', 'overlapPolicy must be reject, queue, or coalesce')
  }
  return out
}

function validateAttempt(input) {
  const out = {
    schedulerJobId: text(input.schedulerJobId, 'schedulerJobId', { required: true, max: 256 }),
    idempotencyKey: text(input.idempotencyKey, 'idempotencyKey', { required: true, max: 128 }),
    triggerSource: input.triggerSource ?? 'manual',
    status: input.status ?? 'queued',
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    sessionId: optionalText(input.sessionId, 'sessionId', { max: 256 }),
    roundId: optionalText(input.roundId, 'roundId', { max: 256 }),
    engineRunId: optionalText(input.engineRunId, 'engineRunId', { max: 256 }),
    errorSummary: optionalText(input.errorSummary, 'errorSummary', { max: 2000 }),
    snapshot: input.snapshot ?? null,
  }
  if (!TRIGGER_SOURCES.has(out.triggerSource)) fail('VALIDATION', `triggerSource must be one of ${[...TRIGGER_SOURCES].join(', ')}`)
  if (!ATTEMPT_STATUSES.has(out.status)) fail('VALIDATION', `status must be one of ${[...ATTEMPT_STATUSES].join(', ')}`)
  for (const field of ['startedAt', 'finishedAt']) if (out[field] !== null) out[field] = normalizeUtcTimestamp(out[field], field)
  return out
}

const MODEL_FIELDS = ['id', 'name', 'description', 'status', 'strategyId', 'experimentId', 'runId', 'artifactRef', 'metrics', 'metadata', 'createdAt', 'updatedAt']
const JOB_FIELDS = ['id', 'name', 'timezone', 'time', 'weekdays', 'strategyId', 'modelRegistryId', 'experimentId', 'runId', 'enabled', 'overlapPolicy', 'createdAt', 'updatedAt']
const ATTEMPT_FIELDS = ['id', 'schedulerJobId', 'idempotencyKey', 'triggerSource', 'status', 'startedAt', 'finishedAt', 'sessionId', 'roundId', 'engineRunId', 'errorSummary', 'snapshot', 'createdAt', 'updatedAt']

function makeModel(input, existing = {}) {
  const fields = validateModelInput(input, { partial: Boolean(existing.id) })
  if (fields.metrics !== undefined && fields.metrics !== null) json(fields.metrics, 'metrics')
  if (fields.metadata !== undefined && fields.metadata !== null) json(fields.metadata, 'metadata')
  const timestamp = now()
  return {
    id: existing.id ?? id('model'), name: fields.name ?? existing.name, description: fields.description ?? existing.description ?? null,
    status: fields.status ?? existing.status ?? 'active', strategyId: fields.strategyId ?? existing.strategyId ?? null,
    experimentId: fields.experimentId ?? existing.experimentId ?? null, runId: fields.runId ?? existing.runId ?? null,
    artifactRef: fields.artifactRef ?? existing.artifactRef ?? null, metrics: fields.metrics === undefined ? existing.metrics ?? null : fields.metrics,
    metadata: fields.metadata === undefined ? existing.metadata ?? null : fields.metadata,
    createdAt: existing.createdAt ?? timestamp, updatedAt: timestamp,
  }
}
function makeJob(input, existing = {}) {
  const fields = validateSchedule(input, { partial: Boolean(existing.id) })
  return {
    id: existing.id ?? id('job'), name: fields.name ?? existing.name, timezone: fields.timezone ?? existing.timezone,
    time: fields.time ?? existing.time, weekdays: fields.weekdays ?? existing.weekdays, strategyId: fields.strategyId ?? existing.strategyId ?? null,
    modelRegistryId: fields.modelRegistryId ?? existing.modelRegistryId ?? null, experimentId: fields.experimentId ?? existing.experimentId ?? null,
    runId: fields.runId ?? existing.runId ?? null, enabled: fields.enabled ?? existing.enabled ?? true,
    overlapPolicy: fields.overlapPolicy ?? existing.overlapPolicy ?? 'reject', createdAt: existing.createdAt ?? now(), updatedAt: now(),
  }
}
function makeAttempt(input, existing = {}) {
  const fields = validateAttempt(input)
  if (fields.snapshot !== undefined && fields.snapshot !== null) json(fields.snapshot, 'snapshot')
  return { id: existing.id ?? id('attempt'), ...fields, createdAt: existing.createdAt ?? now(), updatedAt: now() }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS p3a_model_registry (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, status TEXT NOT NULL,
 strategy_id TEXT, experiment_id TEXT, run_id TEXT, artifact_ref TEXT, metrics_json TEXT, metadata_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS p3a_scheduler_job (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, time TEXT NOT NULL, weekdays_json TEXT NOT NULL,
 strategy_id TEXT, model_registry_id TEXT, experiment_id TEXT, run_id TEXT, enabled INTEGER NOT NULL, overlap_policy TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS p3a_scheduler_attempt (
 id TEXT PRIMARY KEY, scheduler_job_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, trigger_source TEXT NOT NULL,
 status TEXT NOT NULL, started_at TEXT, finished_at TEXT, session_id TEXT, round_id TEXT, engine_run_id TEXT, error_summary TEXT,
 snapshot_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_p3a_job_updated ON p3a_scheduler_job(updated_at, id);
CREATE INDEX IF NOT EXISTS ix_p3a_attempt_job ON p3a_scheduler_attempt(scheduler_job_id, created_at, id);
`

function fromRow(row, kind) {
  if (!row) return null
  if (kind === 'model') return { id: row.id, name: row.name, description: row.description, status: row.status, strategyId: row.strategy_id, experimentId: row.experiment_id, runId: row.run_id, artifactRef: row.artifact_ref, metrics: parseJson(row.metrics_json), metadata: parseJson(row.metadata_json), createdAt: row.created_at, updatedAt: row.updated_at }
  if (kind === 'job') return { id: row.id, name: row.name, timezone: row.timezone, time: row.time, weekdays: parseJson(row.weekdays_json), strategyId: row.strategy_id, modelRegistryId: row.model_registry_id, experimentId: row.experiment_id, runId: row.run_id, enabled: Boolean(row.enabled), overlapPolicy: row.overlap_policy, createdAt: row.created_at, updatedAt: row.updated_at }
  return { id: row.id, schedulerJobId: row.scheduler_job_id, idempotencyKey: row.idempotency_key, triggerSource: row.trigger_source, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, sessionId: row.session_id, roundId: row.round_id, engineRunId: row.engine_run_id, errorSummary: row.error_summary, snapshot: parseJson(row.snapshot_json), createdAt: row.created_at, updatedAt: row.updated_at }
}

function rowFor(record, kind) {
  if (kind === 'model') return [record.id, record.name, record.description, record.status, record.strategyId, record.experimentId, record.runId, record.artifactRef, json(record.metrics, 'metrics'), json(record.metadata, 'metadata'), record.createdAt, record.updatedAt]
  if (kind === 'job') return [record.id, record.name, record.timezone, record.time, json(record.weekdays, 'weekdays'), record.strategyId, record.modelRegistryId, record.experimentId, record.runId, record.enabled ? 1 : 0, record.overlapPolicy, record.createdAt, record.updatedAt]
  return [record.id, record.schedulerJobId, record.idempotencyKey, record.triggerSource, record.status, record.startedAt, record.finishedAt, record.sessionId, record.roundId, record.engineRunId, record.errorSummary, json(record.snapshot, 'snapshot'), record.createdAt, record.updatedAt]
}

function createMemoryStore() {
  const models = new Map(); const jobs = new Map(); const attempts = new Map()
  return {
    kind: 'memory', location: 'memory:', async init() {}, async close() {},
    models, jobs, attempts,
    async insert(kind, record) { const map = kind === 'model' ? models : kind === 'job' ? jobs : attempts; if (map.has(record.id)) fail('CONFLICT', `${kind} ${record.id} already exists`); if (kind === 'model' && [...models.values()].some((m) => m.name === record.name)) fail('CONFLICT', `model name already exists: ${record.name}`); if (kind === 'attempt' && [...attempts.values()].some((a) => a.idempotencyKey === record.idempotencyKey)) fail('CONFLICT', `idempotency key already exists: ${record.idempotencyKey}`); map.set(record.id, normalizedRecord(record)); return normalizedRecord(record) },
    async update(kind, record) { const map = kind === 'model' ? models : kind === 'job' ? jobs : attempts; if (!map.has(record.id)) fail('NOT_FOUND', `${kind} ${record.id} not found`); if (kind === 'model' && [...models.values()].some((m) => m.id !== record.id && m.name === record.name)) fail('CONFLICT', `model name already exists: ${record.name}`); map.set(record.id, normalizedRecord(record)); return normalizedRecord(record) },
    async get(kind, key) { const map = kind === 'model' ? models : kind === 'job' ? jobs : attempts; return normalizedRecord(map.get(key) ?? null) },
    async list(kind) { const map = kind === 'model' ? models : kind === 'job' ? jobs : attempts; return [...map.values()].map(normalizedRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) },
    async remove(kind, key) { const map = kind === 'model' ? models : kind === 'job' ? jobs : attempts; map.delete(key) },
  }
}

function createSqliteStore(file, { reset = false } = {}) {
  const Database = require('better-sqlite3')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  return {
    kind: 'sqlite', location: file,
    async init() { if (reset) db.exec('DROP TABLE IF EXISTS p3a_scheduler_attempt; DROP TABLE IF EXISTS p3a_scheduler_job; DROP TABLE IF EXISTS p3a_model_registry;'); db.exec(SCHEMA) },
    async close() { db.close() },
    async insert(kind, record) { const r = rowFor(record, kind); try { if (kind === 'model') db.prepare('INSERT INTO p3a_model_registry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...r); else if (kind === 'job') db.prepare('INSERT INTO p3a_scheduler_job VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...r); else db.prepare('INSERT INTO p3a_scheduler_attempt VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...r); return record } catch (error) { if (String(error.message).includes('UNIQUE')) fail('CONFLICT', 'record conflicts with an existing unique value'); throw error } },
    async update(kind, record) { const r = rowFor(record, kind); if (kind === 'model') db.prepare('UPDATE p3a_model_registry SET name=?, description=?, status=?, strategy_id=?, experiment_id=?, run_id=?, artifact_ref=?, metrics_json=?, metadata_json=?, created_at=?, updated_at=? WHERE id=?').run(...r.slice(1), r[0]); else if (kind === 'job') db.prepare('UPDATE p3a_scheduler_job SET name=?, timezone=?, time=?, weekdays_json=?, strategy_id=?, model_registry_id=?, experiment_id=?, run_id=?, enabled=?, overlap_policy=?, created_at=?, updated_at=? WHERE id=?').run(...r.slice(1), r[0]); else db.prepare('UPDATE p3a_scheduler_attempt SET scheduler_job_id=?, idempotency_key=?, trigger_source=?, status=?, started_at=?, finished_at=?, session_id=?, round_id=?, engine_run_id=?, error_summary=?, snapshot_json=?, created_at=?, updated_at=? WHERE id=?').run(...r.slice(1), r[0]); return record },
    async get(kind, key) { const table = kind === 'model' ? 'p3a_model_registry' : kind === 'job' ? 'p3a_scheduler_job' : 'p3a_scheduler_attempt'; const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(key); return fromRow(row, kind) },
    async list(kind) { const table = kind === 'model' ? 'p3a_model_registry' : kind === 'job' ? 'p3a_scheduler_job' : 'p3a_scheduler_attempt'; return db.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC, id ASC`).all().map((row) => fromRow(row, kind)) },
    async remove(kind, key) { const table = kind === 'model' ? 'p3a_model_registry' : kind === 'job' ? 'p3a_scheduler_job' : 'p3a_scheduler_attempt'; db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(key) },
  }
}

function createPostgresStore(url) {
  const { Client } = require('pg')
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } })
  const location = url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')
  const table = (kind) => kind === 'model' ? 'p3a_model_registry' : kind === 'job' ? 'p3a_scheduler_job' : 'p3a_scheduler_attempt'
  const columns = (kind) => kind === 'model'
    ? ['id', 'name', 'description', 'status', 'strategy_id', 'experiment_id', 'run_id', 'artifact_ref', 'metrics_json', 'metadata_json', 'created_at', 'updated_at']
    : kind === 'job'
      ? ['id', 'name', 'timezone', 'time', 'weekdays_json', 'strategy_id', 'model_registry_id', 'experiment_id', 'run_id', 'enabled', 'overlap_policy', 'created_at', 'updated_at']
      : ['id', 'scheduler_job_id', 'idempotency_key', 'trigger_source', 'status', 'started_at', 'finished_at', 'session_id', 'round_id', 'engine_run_id', 'error_summary', 'snapshot_json', 'created_at', 'updated_at']
  const placeholders = (count) => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', ')
  return {
    kind: 'postgres', location,
    async init() { await client.connect(); for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await client.query(statement) },
    async close() { await client.end() },
    async insert(kind, record) { const names = columns(kind); try { await client.query(`INSERT INTO ${table(kind)} (${names.join(', ')}) VALUES (${placeholders(names.length)})`, rowFor(record, kind)); return record } catch (error) { if (String(error.message).includes('unique')) fail('CONFLICT', 'record conflicts with an existing unique value'); throw error } },
    async update(kind, record) { const names = columns(kind); const values = rowFor(record, kind); const assignments = names.slice(1).map((name, index) => `${name} = $${index + 1}`).join(', '); await client.query(`UPDATE ${table(kind)} SET ${assignments} WHERE id = $${names.length}`, [...values.slice(1), values[0]]); return record },
    async get(kind, key) { const result = await client.query(`SELECT * FROM ${table(kind)} WHERE id = $1`, [key]); return fromRow(result.rows[0], kind) },
    async list(kind) { const result = await client.query(`SELECT * FROM ${table(kind)} ORDER BY updated_at DESC, id ASC`); return result.rows.map((row) => fromRow(row, kind)) },
    async remove(kind, key) { await client.query(`DELETE FROM ${table(kind)} WHERE id = $1`, [key]) },
  }
}

export function createPhase3AStore(url = process.env.DATABASE_URL, options = {}) {
  if (!url || url === 'sqlite') return createSqliteStore(':memory:', options)
  if (url.startsWith('memory:')) return createMemoryStore()
  if (url.startsWith('sqlite:')) return createSqliteStore(url.replace(/^sqlite:(\/\/)?/, '') || ':memory:', options)
  if (/^postgres(ql)?:\/\//.test(url)) return createPostgresStore(url)
  fail('CONFIGURATION', `unsupported Phase 3A database scheme: ${url.split(':')[0]}`)
}

export class Phase3ARepository {
  constructor(store) { this.store = store }
  async init() { return this.store.init() }
  async close() { return this.store.close() }
  async createModel(input) { const record = makeModel(input); return this.store.insert('model', record) }
  async updateModel(modelId, input) { const current = await this.store.get('model', modelId); if (!current) fail('NOT_FOUND', `model ${modelId} not found`); return this.store.update('model', makeModel(input, current)) }
  async getModel(modelId) { return this.store.get('model', modelId) }
  async listModels() { return this.store.list('model') }
  async deleteModel(modelId) { const jobs = await this.store.list('job'); if (jobs.some((job) => job.modelRegistryId === modelId)) fail('REFERENCE_CONFLICT', `model ${modelId} is referenced by a scheduler job`); const current = await this.store.get('model', modelId); if (!current) fail('NOT_FOUND', `model ${modelId} not found`); await this.store.remove('model', modelId); return { deleted: true, id: modelId } }
  async createJob(input) { const record = makeJob(input); if (record.modelRegistryId && !(await this.store.get('model', record.modelRegistryId))) fail('REFERENCE_NOT_FOUND', `model ${record.modelRegistryId} not found`); return this.store.insert('job', record) }
  async updateJob(jobId, input) { const current = await this.store.get('job', jobId); if (!current) fail('NOT_FOUND', `job ${jobId} not found`); const record = makeJob(input, current); if (record.modelRegistryId && !(await this.store.get('model', record.modelRegistryId))) fail('REFERENCE_NOT_FOUND', `model ${record.modelRegistryId} not found`); return this.store.update('job', record) }
  async getJob(jobId) { return this.store.get('job', jobId) }
  async listJobs() { return this.store.list('job') }
  async deleteJob(jobId) { const current = await this.store.get('job', jobId); if (!current) fail('NOT_FOUND', `job ${jobId} not found`); await this.store.remove('job', jobId); return { deleted: true, id: jobId } }
  async createRunAttempt(input) { if (!(await this.store.get('job', input.schedulerJobId))) fail('REFERENCE_NOT_FOUND', `scheduler job ${input.schedulerJobId} not found`); const record = makeAttempt(input); const existing = (await this.store.list('attempt')).find((attempt) => attempt.idempotencyKey === record.idempotencyKey); if (existing) return { ...existing, reused: true }; return { ...(await this.store.insert('attempt', record)), reused: false } }
  async updateRunAttempt(attemptId, patch) { const current = await this.store.get('attempt', attemptId); if (!current) fail('NOT_FOUND', `attempt ${attemptId} not found`); const record = makeAttempt({ ...current, ...patch }, current); return this.store.update('attempt', record) }
  async getRunAttempt(attemptId) { return this.store.get('attempt', attemptId) }
  async listRunAttempts() { return this.store.list('attempt') }
  async purgeRunAttempts(before) { const cutoff = normalizeUtcTimestamp(before, 'before'); const attempts = await this.store.list('attempt'); let deleted = 0; for (const attempt of attempts) if (attempt.createdAt < cutoff) { await this.store.remove('attempt', attempt.id); deleted += 1 } return { deleted, before: cutoff } }
}

export { MODEL_FIELDS, JOB_FIELDS, ATTEMPT_FIELDS, validateModelInput, validateSchedule, validateAttempt, redactDiagnostic, canonicalizeDecimal, canonicalizeIntegerString, assertSafeInteger }
