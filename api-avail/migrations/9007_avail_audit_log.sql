-- AVAIL: audit log (step 2.1) — who changed what and when: role and access changes of users,
-- every change of a template (created, updated, deleted) and of its status.
--
-- actor:     user email, "admin-token" (Authorization: Bearer ADMIN_TOKEN), "system" (automatic,
--            e.g. a verified template moved to draft below level A) or "cli:<command>"
-- actor_id:  users.id when the actor is a person
-- entity:    'user' | 'template'; entity_id has no foreign key, so the log outlives deletions
-- action:    role, access (user); created, updated, deleted, status (template)
-- before / after: JSON of what changed — only the changed fields for an update
CREATE TABLE avail_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  actor        TEXT NOT NULL,
  actor_id     TEXT,
  entity       TEXT NOT NULL CHECK (entity IN ('user', 'template')),
  entity_id    TEXT NOT NULL,
  entity_label TEXT,
  action       TEXT NOT NULL,
  before       TEXT,
  after        TEXT
);

CREATE INDEX idx_avail_audit_entity ON avail_audit_log(entity, entity_id);
CREATE INDEX idx_avail_audit_at ON avail_audit_log(at);
