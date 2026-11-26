-- AVAIL: product lifecycle of a template (src/avail/lifecycle.ts). upcoming — announced, not shipping
-- yet (available_from: "2027-Q3", "2027-09"…); active — the default; eol — end of life (eol_date,
-- optional). Set by import:catalog from the card's _avail.lifecycle and by librarians with
-- POST /avail/templates/lifecycle/batch (library workspace "Set lifecycle").
ALTER TABLE avail_template_meta ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('upcoming', 'active', 'eol'));
ALTER TABLE avail_template_meta ADD COLUMN available_from TEXT;
ALTER TABLE avail_template_meta ADD COLUMN eol_date TEXT;
