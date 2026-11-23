-- AVAIL: status of library templates, kept next to the upstream `templates` table
-- (which we do not alter). Our migrations are numbered 9xxx so their names never
-- collide with upstream's in d1_migrations.
--
-- status:     verified — checked by AVAIL (standard level A), usable in customer projects
--             draft    — being worked on by an engineer
--             raw      — imported as is (e.g. from easyschematic.live), not reviewed
--             hidden   — not offered in the library
-- A template without a row here is treated as raw.
CREATE TABLE avail_template_meta (
  template_id TEXT PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('verified', 'draft', 'raw', 'hidden')),
  source      TEXT,                                          -- where the template came from: easyschematic.live, avail, ...
  upstream_id TEXT,                                          -- template id at the source
  lint_level  TEXT CHECK (lint_level IN ('A', 'B', 'FIX')),  -- src/avail/blockLint.ts at the last write
  updated_by  TEXT,                                          -- user email, "admin-token" or "import"
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_avail_template_meta_status ON avail_template_meta(status);
CREATE UNIQUE INDEX idx_avail_template_meta_upstream ON avail_template_meta(source, upstream_id) WHERE upstream_id IS NOT NULL;
