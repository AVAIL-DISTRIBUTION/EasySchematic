-- AVAIL: who approved a template (library workspace, step 2.2). approved_by is the email of the
-- person (or "admin-token", or "approve-catalog") who last set the status to verified; it
-- stays when the status later changes, like approved_via / approved_at.
ALTER TABLE avail_template_meta ADD COLUMN approved_by TEXT;

-- Back-fill from the audit log (9007): the latest change to verified of each template.
UPDATE avail_template_meta
   SET approved_by = (
     SELECT a.actor FROM avail_audit_log a
      WHERE a.entity = 'template' AND a.entity_id = avail_template_meta.template_id
        AND a.action = 'status' AND json_extract(a.after, '$.status') = 'verified'
      ORDER BY a.id DESC LIMIT 1)
 WHERE approved_at IS NOT NULL AND approved_by IS NULL;
