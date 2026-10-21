// Storage port for the trade repository. `createStoreFromUrl(DATABASE_URL)` picks the adapter:
//   unset | sqlite:<path>   -> SQLite file (default, desktop-first; WAL mode)
//   postgres(ql)://...      -> PostgreSQL (e.g. Supabase)
//   memory:                 -> in-memory (tests)
// Every adapter implements: init(), load() -> records[], append(record), flush(), close().
// The domain core is synchronous over an in-memory projection; adapters persist every
// immutable record write-through, and the server awaits flush() before replying.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function migrations() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ version: f.replace('.sql', ''), sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8') }))
}

/** Maps one domain record to its table row (portable column set). */
export function toRow(rec, seq) {
  const payload = JSON.stringify(rec)
  switch (rec.kind) {
    case 'trade-event':
      return ['tr_trade_event', 'event_id', { event_id: rec.eventId, seq, trade_id: rec.tradeId, uti: rec.uti, version: rec.version, event_type: rec.eventType, amend_kind: rec.amendKind, valid_from: rec.validFrom, recorded_at: rec.recordedAt, actor: rec.actor, idempotency_key: rec.idempotencyKey, status: rec.state.status, book_id: rec.state.bookId, product_id: rec.state.productTemplate?.id ?? null, product_version: rec.state.productTemplate?.version ?? null, caused_by: rec.causedBy ?? null, payload }]
    case 'audit':
      return ['tr_audit_event', 'audit_id', { audit_id: rec.auditId, seq, occurred_at: rec.occurredAt, actor: rec.actor, action: rec.action, target_id: rec.target?.id ?? null, payload }]
    case 'recon-run':
      return ['tr_recon_run', 'run_id', { run_id: rec.runId, seq, ran_at: rec.ranAt, source: rec.source, payload }]
    case 'break':
      return ['tr_recon_break', 'break_id', { break_id: rec.breakId, seq, run_id: rec.runId, status: rec.status, updated_at: rec.updatedAt, payload }]
    case 'product-template':
      return ['tr_product_template', 'template_key', { template_key: rec.key, seq, product_id: rec.id, version: rec.version, registered_at: rec.registeredAt, payload }]
    default:
      throw new Error(`unknown record kind ${rec.kind}`)
  }
}

const LOAD_SQL = `SELECT payload, seq FROM (
  SELECT payload, seq FROM tr_trade_event UNION ALL SELECT payload, seq FROM tr_audit_event
  UNION ALL SELECT payload, seq FROM tr_recon_run UNION ALL SELECT payload, seq FROM tr_recon_break UNION ALL SELECT payload, seq FROM tr_product_template) r ORDER BY seq`

function upsertSql(table, key, cols, placeholder) {
  const names = Object.keys(cols)
  const ph = names.map((_, i) => placeholder(i + 1)).join(', ')
  const upd = names.filter((n) => n !== key).map((n) => `${n} = excluded.${n}`).join(', ')
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${ph}) ON CONFLICT (${key}) DO UPDATE SET ${upd}`
}

export function defaultSqlitePath() {
  const dir = process.env.TRADE_REPO_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.trade-repo')
  return resolve(dir, 'trade-repo.sqlite')
}

export function createSqliteStore(file, { reset = false } = {}) {
  const Database = require('better-sqlite3')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  let seq = 0
  const stmts = new Map()
  return {
    kind: 'sqlite', location: file,
    async init() {
      db.exec('CREATE TABLE IF NOT EXISTS tr_schema_migration (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
      if (reset) db.exec('DROP TABLE IF EXISTS tr_product_template; DROP TABLE IF EXISTS tr_recon_break; DROP TABLE IF EXISTS tr_recon_run; DROP TABLE IF EXISTS tr_audit_event; DROP TABLE IF EXISTS tr_trade_event; DELETE FROM tr_schema_migration;')
      for (const m of migrations()) {
        if (db.prepare('SELECT 1 FROM tr_schema_migration WHERE version = ?').get(m.version)) continue
        db.exec(m.sql.replace(/ DEFERRABLE INITIALLY DEFERRED/g, ''))
        db.prepare('INSERT INTO tr_schema_migration VALUES (?, ?)').run(m.version, new Date().toISOString())
      }
    },
    load() {
      const rows = db.prepare(LOAD_SQL).all()
      seq = rows.length ? Number(rows[rows.length - 1].seq) : 0
      return rows.map((r) => JSON.parse(r.payload))
    },
    append(rec) {
      const [table, key, cols] = toRow(rec, ++seq)
      const sql = upsertSql(table, key, cols, () => '?')
      if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql))
      stmts.get(sql).run(...Object.values(cols))
    },
    transaction: (fn) => db.transaction(fn)(),
    async flush() {},
    async close() { db.close() },
  }
}

export function createPostgresStore(url, { reset = false } = {}) {
  const { Client } = require('pg')
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } })
  let seq = 0
  let queue = Promise.resolve()
  let failure = null
  let rows = []
  return {
    kind: 'postgres', location: url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@'),
    async init() {
      await client.connect()
      await client.query('CREATE TABLE IF NOT EXISTS tr_schema_migration (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
      if (reset) await client.query('DROP TABLE IF EXISTS tr_product_template, tr_recon_break, tr_recon_run, tr_audit_event, tr_trade_event; DELETE FROM tr_schema_migration;')
      for (const m of migrations()) {
        const done = await client.query('SELECT 1 FROM tr_schema_migration WHERE version = $1', [m.version])
        if (done.rowCount) continue
        await client.query('BEGIN')
        await client.query(m.sql)
        await client.query('INSERT INTO tr_schema_migration VALUES ($1, $2)', [m.version, new Date().toISOString()])
        await client.query('COMMIT')
      }
      rows = (await client.query(LOAD_SQL)).rows
    },
    load() {
      seq = rows.length ? Number(rows[rows.length - 1].seq) : 0
      return rows.map((r) => JSON.parse(r.payload))
    },
    append(rec) {
      const [table, key, cols] = toRow(rec, ++seq)
      const sql = upsertSql(table, key, cols, (i) => `$${i}`)
      const values = Object.values(cols)
      queue = queue.then(() => client.query(sql, values)).catch((e) => { failure = e })
    },
    async flush() {
      await queue
      if (failure) { const e = failure; failure = null; throw e }
    },
    async close() { await queue; await client.end() },
  }
}

export function createMemoryStore() {
  const rows = []
  return { kind: 'memory', location: 'memory:', async init() {}, load: () => rows.map((r) => JSON.parse(JSON.stringify(r))), append: (r) => rows.push(JSON.parse(JSON.stringify(r))), async flush() {}, async close() {}, rows }
}

export function createStoreFromUrl(url = process.env.DATABASE_URL, opts = {}) {
  if (!url) return createSqliteStore(defaultSqlitePath(), opts)
  if (url.startsWith('memory:')) return createMemoryStore()
  if (url.startsWith('sqlite:')) return createSqliteStore(url.replace(/^sqlite:(\/\/)?/, '') || defaultSqlitePath(), opts)
  if (/^postgres(ql)?:\/\//.test(url)) return createPostgresStore(url, opts)
  throw new Error(`unsupported DATABASE_URL scheme: ${url.split(':')[0]}`)
}
