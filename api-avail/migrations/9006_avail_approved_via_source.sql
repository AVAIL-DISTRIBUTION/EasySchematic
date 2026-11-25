-- AVAIL: a third way of approval, bulk-source — approve:catalog sets verified for draft catalog
-- templates at level A whose ports come from the manufacturer's documents (Extron stencil, data
-- sheet, curated library). SQLite cannot change a CHECK constraint, so the table is rebuilt with
-- the same columns (9001–9005) and indexes.
CREATE TABLE avail_template_meta_new (
  template_id       TEXT PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('verified', 'draft', 'raw', 'hidden')),
  source            TEXT,
  upstream_id       TEXT,
  lint_level        TEXT CHECK (lint_level IN ('A', 'B', 'FIX')),
  updated_by        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  linted_version    INTEGER,
  status_reason     TEXT,
  status_changed_at TEXT,
  source_hash       TEXT,
  approved_via      TEXT CHECK (approved_via IN ('review', 'bulk', 'bulk-source')),
  approved_at       TEXT,
  catalog           TEXT
);

INSERT INTO avail_template_meta_new
  (template_id, status, source, upstream_id, lint_level, updated_by, updated_at, linted_version,
   status_reason, status_changed_at, source_hash, approved_via, approved_at, catalog)
SELECT template_id, status, source, upstream_id, lint_level, updated_by, updated_at, linted_version,
       status_reason, status_changed_at, source_hash, approved_via, approved_at, catalog
  FROM avail_template_meta;

DROP TABLE avail_template_meta;
ALTER TABLE avail_template_meta_new RENAME TO avail_template_meta;

CREATE INDEX idx_avail_template_meta_status ON avail_template_meta(status);
CREATE UNIQUE INDEX idx_avail_template_meta_upstream ON avail_template_meta(source, upstream_id) WHERE upstream_id IS NOT NULL;
