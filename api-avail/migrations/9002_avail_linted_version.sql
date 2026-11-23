-- AVAIL: templates.version at which lint_level was computed. Upstream bumps the version
-- on every save (PUT /templates/:id, approved submissions), so a mismatch means the
-- template changed since the last lint; api-avail re-lints after each write request.
ALTER TABLE avail_template_meta ADD COLUMN linted_version INTEGER;
