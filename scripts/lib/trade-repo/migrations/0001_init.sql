-- Trade repository schema (portable: SQLite >= 3.35 and PostgreSQL >= 13).
-- Rules: TEXT ids and ISO-8601 UTC timestamps as TEXT, JSON payloads as TEXT,
-- BIGINT integers, no AUTOINCREMENT/SERIAL, ON CONFLICT upserts only.
CREATE TABLE IF NOT EXISTS tr_trade_event (
  event_id        TEXT PRIMARY KEY,
  seq             BIGINT NOT NULL UNIQUE,
  trade_id        TEXT NOT NULL,
  uti             TEXT NOT NULL,
  version         BIGINT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN ('NEW','AMEND','CANCEL','NOVATE','PARTIAL_TERMINATE','EXERCISE','MATURE','BOOK_TRANSFER')),
  amend_kind      TEXT,
  valid_from      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  actor           TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status          TEXT NOT NULL,
  book_id         TEXT NOT NULL,
  payload         TEXT NOT NULL,
  UNIQUE (trade_id, version)
);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_trade ON tr_trade_event (trade_id, version);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_uti ON tr_trade_event (uti);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_bitemporal ON tr_trade_event (recorded_at, valid_from);

CREATE TABLE IF NOT EXISTS tr_audit_event (
  audit_id    TEXT PRIMARY KEY,
  seq         BIGINT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   TEXT,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tr_audit_target ON tr_audit_event (target_id, occurred_at);

CREATE TABLE IF NOT EXISTS tr_recon_run (
  run_id  TEXT PRIMARY KEY,
  seq     BIGINT NOT NULL UNIQUE,
  ran_at  TEXT NOT NULL,
  source  TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Breaks are mutable workflow objects; every change is also in tr_audit_event.
CREATE TABLE IF NOT EXISTS tr_recon_break (
  break_id   TEXT PRIMARY KEY,
  seq        BIGINT NOT NULL,
  run_id     TEXT NOT NULL REFERENCES tr_recon_run (run_id) DEFERRABLE INITIALLY DEFERRED,
  status     TEXT NOT NULL CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','WAIVED')),
  updated_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tr_recon_break_status ON tr_recon_break (status);
