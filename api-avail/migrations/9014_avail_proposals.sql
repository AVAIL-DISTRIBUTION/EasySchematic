-- AVAIL: a proposal stores its edit, not a snapshot (step 2.9; api-avail/src/proposals.ts).
--
-- Upstream's submissions.data keeps the whole proposed template (its routes need it); next to it we
-- keep what the proposal changes (patch: fields, ports by id) and the template it was built on (its
-- version and stored form). Accept applies the patch to the template as it is then; a field or port
-- changed since is a conflict the librarian resolves. Submissions without a row here (made before
-- this migration) are accepted as before: the whole snapshot.
CREATE TABLE avail_proposals (
  submission_id  TEXT PRIMARY KEY,
  template_id    TEXT NOT NULL,
  base_version   INTEGER NOT NULL,
  base           TEXT NOT NULL,          -- JSON: the template (stored form) the patch was built on
  patch          TEXT NOT NULL,          -- JSON: TemplatePatch (src/avail/templatePatch.ts)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
