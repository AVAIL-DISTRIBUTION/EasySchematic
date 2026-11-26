-- AVAIL: OAuth 2.1 for the MCP connector (step 2.8; api-avail/src/oauth.ts).
--
-- Claude (claude.ai custom connector, Claude Code) registers itself (dynamic client registration),
-- sends the user through /oauth/authorize — Google Workspace sign-in and a consent page — and gets
-- an access token (avail_oa_…, 1 hour) and a refresh token (avail_or_…, 30 days, rotated on use).
-- A request with the access token runs as that user: their role, rights and audit log ("via Claude").
-- Only SHA-256 hashes of codes and tokens are stored.

CREATE TABLE avail_oauth_clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  redirect_uris   TEXT NOT NULL,            -- JSON array
  secret_hash     TEXT,                     -- NULL: public client (token_endpoint_auth_method none)
  auth_method     TEXT NOT NULL DEFAULT 'none',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A consent page shown to a signed-in user: the form posts its id back.
CREATE TABLE avail_oauth_pending (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  client_id       TEXT NOT NULL REFERENCES avail_oauth_clients(id),
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  state           TEXT,
  scope           TEXT,
  resource        TEXT,
  expires_at      TEXT NOT NULL
);

CREATE TABLE avail_oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  client_id       TEXT NOT NULL REFERENCES avail_oauth_clients(id),
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scope           TEXT,
  resource        TEXT,
  expires_at      TEXT NOT NULL
);

-- One row per connection (what Users lists): the current access and refresh tokens.
CREATE TABLE avail_oauth_grants (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  client_id           TEXT NOT NULL REFERENCES avail_oauth_clients(id),
  scope               TEXT,
  access_hash         TEXT NOT NULL UNIQUE,
  access_expires_at   TEXT NOT NULL,
  refresh_hash        TEXT NOT NULL UNIQUE,
  refresh_expires_at  TEXT NOT NULL,
  session_id          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at        TEXT,
  revoked_at          TEXT,
  revoked_by          TEXT,
  revoked_reason      TEXT
);

CREATE INDEX idx_avail_oauth_grants_user ON avail_oauth_grants(user_id);
