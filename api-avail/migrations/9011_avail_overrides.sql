-- AVAIL: overrides — decided values of a template that imports must not lose (step 2.7;
-- api-avail/src/overrides.ts, src/avail/overrides.ts).
--
-- An accepted proposal records each field and port it changed. import:catalog and
-- normalize:library apply the active rows (and docs/avail/overrides.json entries the table does not
-- know) over the catalog and the database. kind 'field': `field`, value = JSON of the field (null
-- removes it); kind 'port': `port` (label as it was), port_id, op set / add / remove, value = JSON
-- of the port fields or of the port. base = JSON of what it was before (NULL = unknown).
-- A removed override keeps its row (removed_at): a file entry removed here stays out.
CREATE TABLE avail_overrides (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id    TEXT,
  manufacturer   TEXT,
  model_number   TEXT,
  label          TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('field', 'port')),
  field          TEXT,
  port           TEXT,
  port_id        TEXT,
  op             TEXT CHECK (op IS NULL OR op IN ('set', 'add', 'remove')),
  value          TEXT,
  base           TEXT,
  source         TEXT NOT NULL,
  submission_id  TEXT,
  comment        TEXT NOT NULL DEFAULT '',
  accepted_by    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at     TEXT,
  removed_by     TEXT,
  removed_reason TEXT
);

CREATE INDEX idx_avail_overrides_template ON avail_overrides(template_id);
