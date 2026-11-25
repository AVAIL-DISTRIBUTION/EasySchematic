-- AVAIL: catalog data of templates loaded by import:catalog (library/catalog, step 1.9).
--
-- catalog: JSON of the catalog file's _avail (variant, altPartNumber, slotFamilies, cardFamilies,
--          description, notes, portsSource, …) plus fields the templates table has no column for
--          (rackForm) and the catalog file path. NULL for templates that did not come from the catalog.
ALTER TABLE avail_template_meta ADD COLUMN catalog TEXT;
