-- AVAIL: why and when a template's status last changed, and the curated-library file
-- it was loaded from.
--
-- status_reason:     set when the status is changed automatically, e.g. a verified
--                    template that fell below standard level A on save is moved to
--                    draft ("level B after save (version 7)"); NULL after a manual change
-- status_changed_at: time of the last status change (manual or automatic)
-- source_hash:       sha-256 of the library/avail/*.json file last loaded by
--                    import:avail; an unchanged file is not loaded again
ALTER TABLE avail_template_meta ADD COLUMN status_reason TEXT;
ALTER TABLE avail_template_meta ADD COLUMN status_changed_at TEXT;
ALTER TABLE avail_template_meta ADD COLUMN source_hash TEXT;
