-- Product definition registry (docs/52 §R): event types now come from product templates,
-- so the hard-coded event_type CHECK is removed (portable table rebuild: works on SQLite,
-- which cannot ALTER ... DROP CONSTRAINT, and on PostgreSQL), and derived events record
-- the event that caused them.
CREATE TABLE tr_trade_event_v2 (
  event_id        TEXT PRIMARY KEY,
  seq             BIGINT NOT NULL UNIQUE,
  trade_id        TEXT NOT NULL,
  uti             TEXT NOT NULL,
  version         BIGINT NOT NULL,
  event_type      TEXT NOT NULL,
  amend_kind      TEXT,
  valid_from      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  actor           TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status          TEXT NOT NULL,
  book_id         TEXT NOT NULL,
  product_id      TEXT,
  product_version BIGINT,
  caused_by       TEXT,
  payload         TEXT NOT NULL,
  UNIQUE (trade_id, version)
);
INSERT INTO tr_trade_event_v2 (event_id, seq, trade_id, uti, version, event_type, amend_kind, valid_from, recorded_at, actor, idempotency_key, status, book_id, payload)
  SELECT event_id, seq, trade_id, uti, version, event_type, amend_kind, valid_from, recorded_at, actor, idempotency_key, status, book_id, payload FROM tr_trade_event;
DROP TABLE tr_trade_event;
ALTER TABLE tr_trade_event_v2 RENAME TO tr_trade_event;
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_trade ON tr_trade_event (trade_id, version);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_uti ON tr_trade_event (uti);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_bitemporal ON tr_trade_event (recorded_at, valid_from);
CREATE INDEX IF NOT EXISTS ix_tr_trade_event_product ON tr_trade_event (product_id, product_version);

-- Versioned product templates (fina.product-template/v1) — immutable once registered.
CREATE TABLE IF NOT EXISTS tr_product_template (
  template_key  TEXT PRIMARY KEY,
  seq           BIGINT NOT NULL UNIQUE,
  product_id    TEXT NOT NULL,
  version       BIGINT NOT NULL,
  registered_at TEXT NOT NULL,
  payload       TEXT NOT NULL,
  UNIQUE (product_id, version)
);
