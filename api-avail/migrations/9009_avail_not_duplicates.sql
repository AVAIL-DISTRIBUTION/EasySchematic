-- AVAIL: "Not duplicates" decisions (step 2.4). A librarian decided that two templates the duplicate
-- check pairs are different products. Stored per pair (id_a < id_b), with the comment, who and when,
-- and the manufacturer + modelNumber both templates had then: when either changes, the decision is
-- dropped automatically (api-avail/src/notDuplicates.ts dropStaleNotDuplicates, logged).
-- No foreign keys: a deleted template's decisions are dropped the same way, with a log entry.
CREATE TABLE avail_not_duplicates (
  id_a            TEXT NOT NULL,
  id_b            TEXT NOT NULL,
  a_manufacturer  TEXT,
  a_model_number  TEXT,
  b_manufacturer  TEXT,
  b_model_number  TEXT,
  comment         TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id_a, id_b),
  CHECK (id_a < id_b)
);

CREATE INDEX idx_avail_not_duplicates_b ON avail_not_duplicates(id_b);
