-- AVAIL: how a template was approved (status verified), shown in the Review card.
--
-- approved_via: review — one template, in the Review card (checklist);
--               bulk   — several at once with Approve in the library
-- approved_at:  when it was set to verified. Both stay as they were when the status later changes.
ALTER TABLE avail_template_meta ADD COLUMN approved_via TEXT CHECK (approved_via IN ('review', 'bulk'));
ALTER TABLE avail_template_meta ADD COLUMN approved_at TEXT;
