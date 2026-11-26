-- AVAIL: AI Assistant role and access tokens (step 2.5).
--
-- avail_access_tokens: a token signs an AI Assistant user in without Google
-- (Authorization: Bearer avail_ai_…). Only the SHA-256 of the value is stored; `hint` is its
-- last 4 characters, to tell tokens apart. A valid token is turned into an internal session
-- (session_id, sessions row with the token's expiry), so upstream's checks see a plain user.
-- Revoking deletes that session; disabling the user revokes all of their tokens.
CREATE TABLE avail_access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  hint          TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  last_used_at  TEXT,
  session_id    TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT,
  revoked_reason TEXT
);

CREATE INDEX idx_avail_access_tokens_user ON avail_access_tokens(user_id);

-- The audit log names the token a change was made with (actor = the token's user).
ALTER TABLE avail_audit_log ADD COLUMN token TEXT;

-- The AI Assistant service account: System in Users (role and access fixed), gets tokens.
INSERT INTO users (id, email, name, role)
  SELECT 'avail-ai-assistant', 'claude@avail.invalid', 'Claude (AI Assistant)', 'assistant'
   WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'claude@avail.invalid');
UPDATE users SET role = 'assistant' WHERE email = 'claude@avail.invalid';
