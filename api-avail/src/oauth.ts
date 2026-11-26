/**
 * OAuth 2.1 for the MCP connector (step 2.8; migration 9013), per the MCP authorization spec:
 * Claude (a claude.ai custom connector, Claude Code) discovers us, registers itself, sends the user
 * through Google Workspace sign-in and a consent page, and calls /mcp with a Bearer token that acts
 * as that user — their role, rights and audit log ("via Claude"). Static AI Assistant tokens
 * (accessTokens.ts) keep working beside it.
 *
 *   GET  /.well-known/oauth-protected-resource[/…]    RFC 9728: resource (…/mcp) and its server
 *   GET  /.well-known/oauth-authorization-server[/…]  RFC 8414: endpoints, PKCE S256, grants
 *   POST /oauth/register     RFC 7591 dynamic client registration (https or loopback redirect URIs)
 *   GET  /oauth/authorize    signed out → Google sign-in (/auth/google/start, returns here);
 *                            signed in → consent page (English); PKCE S256 required
 *   POST /oauth/authorize    the consent form: Allow → code to the client, Deny → access_denied
 *   POST /oauth/token        authorization_code (PKCE verifier) and refresh_token (rotated)
 *   POST /oauth/revoke       RFC 7009: the connection is revoked
 *   GET  /avail/users/:id/oauth           admin: the user's connections (client, granted, last used)
 *   POST /avail/oauth/grants/:id/revoke   admin: revoke a connection now
 *
 * Who may connect: a signed-in user who is not disabled, not a system account and not an AI Assistant
 * (they use static tokens), with an email in GOOGLE_ALLOWED_DOMAIN when it is set. Disabling a user
 * revokes their connections (users.ts); a request with a token of a disabled user is refused anyway.
 * The issuer is API_PUBLIC_URL (https://sch.avail-int.com/api), else the request's origin.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireAdminOrToken, requireSession } from "../../api/src/auth";
import { availRoleOf, isAssistant, isSystemAccount, ROLE_LABELS } from "../../src/avail/roles";
import { ADMIN_TOKEN_ACTOR, writeAudit } from "./audit";
import type { D1DatabaseShim } from "./d1";
import type { TokenRateLimiter, TokenResolution } from "./accessTokens";

type UpstreamApp = typeof UpstreamAppValue;

export const ACCESS_PREFIX = "avail_oa_";
export const REFRESH_PREFIX = "avail_or_";
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_DAYS = 30;
const CODE_TTL_S = 120;
const PENDING_TTL_S = 600;
/** The audit log's mark of what was done through an OAuth connection (audit.ts token column). */
export const VIA_CLAUDE = "via Claude";
export const SCOPE = "library";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const token = (prefix: string) => prefix + randomBytes(32).toString("base64url");
/** SQLite datetime text, `s` seconds from now. */
const at = (s: number) => new Date(Date.now() + s * 1000).toISOString().slice(0, 19).replace("T", " ");
const sqliteOf = (c: { env: { easyschematic_db: D1Database } }) => (c.env.easyschematic_db as unknown as D1DatabaseShim).sqlite;

/** The issuer: API_PUBLIC_URL without a trailing slash, else the origin the request came to. */
export function issuerOf(publicUrl: string | undefined, requestUrl: string): string {
  const p = (publicUrl ?? "").trim().replace(/\/+$/, "");
  return p || new URL(requestUrl).origin;
}
export const resourceOf = (issuer: string) => `${issuer}/mcp`;
export const resourceMetadataUrl = (issuer: string) => `${issuer}/.well-known/oauth-protected-resource`;

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: resourceOf(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "AVAIL device library",
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
  };
}

/** A redirect URI a client may register: https, or http on a loopback host (Claude Code). */
export function allowedRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** PKCE S256: base64url(sha256(verifier)) equals the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------- rows

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  secret_hash: string | null;
  auth_method: string;
  created_at: string;
}

export interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  scope: string | null;
  access_hash: string;
  access_expires_at: string;
  refresh_hash: string;
  refresh_expires_at: string;
  session_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

/** A connection as Users lists it. */
export interface OAuthGrantInfo {
  id: string;
  client: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** When the connection lapses unless Claude refreshes it. */
  expiresAt: string;
  state: "active" | "expired" | "revoked";
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export function grantInfo(r: GrantRow & { client_name: string }, now = at(0)): OAuthGrantInfo {
  return {
    id: r.id, client: r.client_name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.refresh_expires_at,
    state: r.revoked_at ? "revoked" : r.refresh_expires_at <= now ? "expired" : "active",
    revokedAt: r.revoked_at, revokedBy: r.revoked_by, revokedReason: r.revoked_reason,
  };
}

/** Revokes a user's connections and deletes their sessions; returns the revoked ones (client names). */
export function revokeUserGrants(sqlite: Database.Database, userId: string, by: string, reason: string): { id: string; client: string }[] {
  const rows = sqlite
    .prepare(
      `SELECT g.id, g.session_id, c.name AS client FROM avail_oauth_grants g JOIN avail_oauth_clients c ON c.id = g.client_id
        WHERE g.user_id = ? AND g.revoked_at IS NULL`,
    )
    .all(userId) as { id: string; session_id: string | null; client: string }[];
  if (!rows.length) return [];
  sqlite.transaction(() => {
    for (const r of rows) revokeGrantRow(sqlite, r.id, r.session_id, by, reason);
  })();
  return rows.map((r) => ({ id: r.id, client: r.client }));
}

function revokeGrantRow(sqlite: Database.Database, id: string, sessionId: string | null, by: string, reason: string) {
  sqlite.prepare("UPDATE avail_oauth_grants SET revoked_at = datetime('now'), revoked_by = ?, revoked_reason = ?, session_id = NULL WHERE id = ?").run(by, reason, id);
  if (sessionId) sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

// ---------------------------------------------------------------------------- who may connect

interface Person {
  id: string;
  email: string;
  role: string;
  banned: number;
}

/** Why this user may not connect Claude, or null. */
export function connectRefusal(u: Person, allowedDomains: readonly string[]): string | null {
  if (u.banned) return "Your account is disabled. Ask an admin to enable it.";
  if (isSystemAccount(u.email) || isAssistant(u.role)) return "This account cannot connect Claude: AI Assistant and system accounts use access tokens.";
  const domain = u.email.split("@")[1]?.toLowerCase() ?? "";
  if (allowedDomains.length && !allowedDomains.includes(domain)) return `Only ${allowedDomains.join(", ")} accounts can connect Claude.`;
  return null;
}

const domainsOf = (v: string | undefined) => (v ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---------------------------------------------------------------------------- sign-in by OAuth token

/**
 * A request with `Authorization: Bearer avail_oa_…`: checks the connection and, when it is good,
 * returns the request signed in as its user (internal session cookie instead of the header).
 */
export function resolveOAuthToken(sqlite: Database.Database, request: Request, limiter: TokenRateLimiter, issuer: string, allowedDomains: string): TokenResolution {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith(`Bearer ${ACCESS_PREFIX}`)) return { kind: "none" };
  const challenge = `Bearer realm="avail", resource_metadata="${resourceMetadataUrl(issuer)}", error="invalid_token"`;
  const refuse = (error: string): TokenResolution => ({ kind: "refused", status: 401, body: { error }, headers: { "WWW-Authenticate": challenge } });
  const row = sqlite
    .prepare(
      `SELECT g.*, c.name AS client_name, u.email, u.role, u.banned, g.access_expires_at <= datetime('now') AS expired
         FROM avail_oauth_grants g JOIN users u ON u.id = g.user_id JOIN avail_oauth_clients c ON c.id = g.client_id
        WHERE g.access_hash = ?`,
    )
    .get(sha(auth.slice(7).trim())) as (GrantRow & { client_name: string; email: string; role: string; banned: number; expired: number }) | undefined;
  if (!row) return refuse("The Claude connection is not valid. Connect again.");
  if (row.revoked_at) return refuse(`Access for ${row.client_name} was revoked on ${row.revoked_at.slice(0, 10)}. Connect again.`);
  if (row.expired) return refuse("The access token expired. Claude refreshes it; if it does not, connect again.");
  const why = connectRefusal(row, domainsOf(allowedDomains));
  if (why) return refuse(why);
  const wait = limiter.take(`oauth:${row.id}`);
  if (wait !== null) {
    return { kind: "refused", status: 429, body: { error: `Too many requests through Claude: at most ${limiter.perMinute} a minute. Try again in ${wait} s.` }, headers: { "Retry-After": String(wait) } };
  }
  let sid = row.session_id;
  const live = sid && sqlite.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > datetime('now')").get(sid, row.user_id);
  sqlite.transaction(() => {
    if (!live) {
      sid = randomBytes(32).toString("hex");
      sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(sid, row.user_id, row.access_expires_at);
      if (row.session_id) sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    }
    sqlite.prepare("UPDATE avail_oauth_grants SET last_used_at = datetime('now'), session_id = ? WHERE id = ?").run(sid, row.id);
  })();
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("Cookie", `session=${sid}`);
  return { kind: "ok", request: new Request(request, { headers }), token: { id: `oauth:${row.id}`, name: VIA_CLAUDE, userId: row.user_id, email: row.email } };
}

// ---------------------------------------------------------------------------- pages

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — AVAIL Schematic</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1d2330}main{max-width:460px;margin:8vh auto;background:#fff;border:1px solid #dfe3ea;border-radius:10px;padding:28px}
h1{font-size:20px;margin:0 0 12px}ul{padding-left:20px}.muted{color:#5b6475;font-size:13px}.row{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #c9cfd9;background:#fff;cursor:pointer}button.primary{background:#0055cc;border-color:#0055cc;color:#fff}</style>
</head><body><main>${body}</main></body></html>`;
}

/** What a role can do through Claude, as the consent page says it. */
export function roleAbilities(role: string): string[] {
  const r = availRoleOf(role);
  const base = ["Read the device library", "Check templates with the linter and the normalizer (nothing is saved)", "Propose template changes for librarian review"];
  if (r === "librarian" || r === "admin") return [...base, "Create draft templates", "Read the review queue, possible duplicates and the audit log"];
  return base;
}

function consentPage(o: { pending: string; action: string; client: string; redirectHost: string; email: string; role: string }): string {
  const items = roleAbilities(o.role).map((x) => `<li>${esc(x)}</li>`).join("");
  return page(
    "Connect Claude",
    `<h1>Connect ${esc(o.client)} to AVAIL Schematic</h1>
<p><b>${esc(o.client)}</b> asks to use the AVAIL device library as <b>${esc(o.email)}</b> (${esc(ROLE_LABELS[availRoleOf(o.role)])}). It will be able to:</p>
<ul>${items}</ul>
<p class="muted">It acts with your rights only; what it changes goes to the audit log as you, marked “via Claude”. You can disconnect it in Claude, or an admin can revoke it in Users. After you allow it, you return to ${esc(o.redirectHost)}.</p>
<form method="post" action="${esc(o.action)}"><input type="hidden" name="pending" value="${esc(o.pending)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div></form>`,
  );
}

const errorPage = (title: string, text: string) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

// ---------------------------------------------------------------------------- routes

/** Form or JSON body as a string map. */
async function bodyOf(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    }
    return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return {};
  }
}

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function registerOAuthRoutes(app: UpstreamApp): void {
  const issuerFor = (c: { env: { API_PUBLIC_URL?: string }; req: { url: string } }) => issuerOf(c.env.API_PUBLIC_URL, c.req.url);
  const cors = { "Access-Control-Allow-Origin": "*" };

  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"]) {
    app.get(p, (c) => c.json(protectedResourceMetadata(issuerFor(c)), 200, cors));
  }
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*"]) {
    app.get(p, (c) => c.json(authorizationServerMetadata(issuerFor(c)), 200, cors));
  }

  app.post("/oauth/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Send the client metadata as JSON" }, 400, cors);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(allowedRedirectUri)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris: 1 to 10 https URLs (http only on localhost)" }, 400, cors);
    }
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
    if (!grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
      return c.json({ error: "invalid_client_metadata", error_description: "grant_types: authorization_code and refresh_token only" }, 400, cors);
    }
    const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      return c.json({ error: "invalid_client_metadata", error_description: "token_endpoint_auth_method: none, client_secret_post or client_secret_basic" }, 400, cors);
    }
    const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "Claude").slice(0, 80);
    const id = randomUUID();
    const secret = method === "none" ? null : randomBytes(32).toString("base64url");
    sqliteOf(c)
      .prepare("INSERT INTO avail_oauth_clients (id, name, redirect_uris, secret_hash, auth_method) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, JSON.stringify(uris), secret ? sha(secret) : null, method);
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
        scope: SCOPE,
      },
      201,
      { ...cors, ...NO_STORE },
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const sqlite = sqliteOf(c);
    const issuer = issuerFor(c);
    const client = q.client_id ? (sqlite.prepare("SELECT * FROM avail_oauth_clients WHERE id = ?").get(q.client_id) as ClientRow | undefined) : undefined;
    if (!client) return c.html(errorPage("Unknown application", "This connection request names an application that is not registered. Start the connection from Claude again."), 400);
    const uris = JSON.parse(client.redirect_uris) as string[];
    if (!q.redirect_uri || !uris.includes(q.redirect_uri)) {
      return c.html(errorPage("Invalid request", "The return address of this request is not registered for the application. Start the connection from Claude again."), 400);
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", issuer);
      return c.redirect(u.toString());
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with code_challenge_method S256 is required");
    if (q.resource && q.resource !== resourceOf(issuer) && q.resource !== issuer) return back("invalid_target", `resource must be ${resourceOf(issuer)}`);

    const user = requireSession(c);
    if (!user) {
      // Google Workspace sign-in, then back to this very request (returnTo is checked against ALLOWED_ORIGINS).
      const self = `${issuer}/oauth/authorize?${new URL(c.req.url).searchParams}`;
      return c.redirect(`${issuer}/auth/google/start?returnTo=${encodeURIComponent(self)}`);
    }
    const why = connectRefusal(user, domainsOf(c.env.GOOGLE_ALLOWED_DOMAIN));
    if (why) return c.html(errorPage("Cannot connect Claude", why), 403);

    const pending = randomBytes(24).toString("base64url");
    sqlite.prepare("DELETE FROM avail_oauth_pending WHERE expires_at <= datetime('now')").run();
    sqlite
      .prepare(
        `INSERT INTO avail_oauth_pending (id, user_id, client_id, redirect_uri, code_challenge, state, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(pending, user.id, client.id, q.redirect_uri, q.code_challenge, q.state ?? null, q.scope ?? null, q.resource ?? null, at(PENDING_TTL_S));
    return c.html(
      consentPage({ pending, action: `${issuer}/oauth/authorize`, client: client.name, redirectHost: new URL(q.redirect_uri).host, email: user.email, role: user.role }),
      200,
      { ...NO_STORE, "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const sqlite = sqliteOf(c);
    const issuer = issuerFor(c);
    const form = await bodyOf(c.req.raw);
    const user = requireSession(c);
    const p = form.pending
      ? (sqlite.prepare("SELECT * FROM avail_oauth_pending WHERE id = ? AND expires_at > datetime('now')").get(form.pending) as
          | { id: string; user_id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; scope: string | null; resource: string | null }
          | undefined)
      : undefined;
    if (!p || !user || p.user_id !== user.id) return c.html(errorPage("Request expired", "This connection request expired or belongs to another sign-in. Start the connection from Claude again."), 400);
    sqlite.prepare("DELETE FROM avail_oauth_pending WHERE id = ?").run(p.id);
    const u = new URL(p.redirect_uri);
    if (p.state) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", issuer);
    if (form.decision !== "allow") {
      u.searchParams.set("error", "access_denied");
      u.searchParams.set("error_description", "The user denied access");
      return c.redirect(u.toString());
    }
    const why = connectRefusal(user, domainsOf(c.env.GOOGLE_ALLOWED_DOMAIN));
    if (why) return c.html(errorPage("Cannot connect Claude", why), 403);
    const code = randomBytes(32).toString("base64url");
    sqlite
      .prepare(
        `INSERT INTO avail_oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha(code), user.id, p.client_id, p.redirect_uri, p.code_challenge, p.scope, p.resource, at(CODE_TTL_S));
    u.searchParams.set("code", code);
    return c.redirect(u.toString());
  });

  app.post("/oauth/token", async (c) => {
    const sqlite = sqliteOf(c);
    const f = await bodyOf(c.req.raw);
    const fail = (error: string, description: string, status: 400 | 401 = 400) => c.json({ error, error_description: description }, status, { ...cors, ...NO_STORE });
    // Client: client_id (public), or client_secret_post / client_secret_basic.
    let clientId = f.client_id;
    let secret = f.client_secret;
    const basic = c.req.header("Authorization");
    if (basic?.startsWith("Basic ")) {
      const [id, s] = Buffer.from(basic.slice(6), "base64").toString().split(":");
      clientId = decodeURIComponent(id ?? "");
      secret = decodeURIComponent(s ?? "");
    }
    const client = clientId ? (sqlite.prepare("SELECT * FROM avail_oauth_clients WHERE id = ?").get(clientId) as ClientRow | undefined) : undefined;
    if (!client) return fail("invalid_client", "Unknown client_id", 401);
    if (client.secret_hash && (!secret || sha(secret) !== client.secret_hash)) return fail("invalid_client", "Wrong client secret", 401);

    const issue = (userId: string, scope: string | null, grantId: string | null) => {
      const access = token(ACCESS_PREFIX);
      const refresh = token(REFRESH_PREFIX);
      const id = grantId ?? randomUUID();
      if (grantId) {
        const old = sqlite.prepare("SELECT session_id FROM avail_oauth_grants WHERE id = ?").get(grantId) as { session_id: string | null };
        sqlite
          .prepare(
            `UPDATE avail_oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, session_id = NULL,
               last_used_at = datetime('now') WHERE id = ?`,
          )
          .run(sha(access), at(ACCESS_TTL_S), sha(refresh), at(REFRESH_TTL_DAYS * 86400), grantId);
        if (old.session_id) sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(old.session_id);
      } else {
        sqlite
          .prepare(
            `INSERT INTO avail_oauth_grants (id, user_id, client_id, scope, access_hash, access_expires_at, refresh_hash, refresh_expires_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(id, userId, client.id, scope, sha(access), at(ACCESS_TTL_S), sha(refresh), at(REFRESH_TTL_DAYS * 86400));
      }
      return c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scope ?? SCOPE }, 200, { ...cors, ...NO_STORE });
    };
    const personOf = (id: string) => sqlite.prepare("SELECT id, email, role, banned FROM users WHERE id = ?").get(id) as Person | undefined;

    if (f.grant_type === "authorization_code") {
      if (!f.code || !f.code_verifier || !f.redirect_uri) return fail("invalid_request", "code, code_verifier and redirect_uri are required");
      const row = sqlite.prepare("SELECT * FROM avail_oauth_codes WHERE code_hash = ?").get(sha(f.code)) as
        | { user_id: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string | null; expires_at: string }
        | undefined;
      if (row) sqlite.prepare("DELETE FROM avail_oauth_codes WHERE code_hash = ?").run(sha(f.code)); // one use
      if (!row || row.expires_at <= at(0)) return fail("invalid_grant", "The authorization code is not valid or expired");
      if (row.client_id !== client.id || row.redirect_uri !== f.redirect_uri) return fail("invalid_grant", "The code was issued to another client or redirect_uri");
      if (!pkceMatches(f.code_verifier, row.code_challenge)) return fail("invalid_grant", "PKCE verification failed");
      const u = personOf(row.user_id);
      const why = u ? connectRefusal(u, domainsOf(c.env.GOOGLE_ALLOWED_DOMAIN)) : "Unknown user";
      if (why) return fail("invalid_grant", why);
      const res = issue(row.user_id, row.scope, null);
      writeAudit(sqlite, [{
        actor: u!.email, actorId: u!.id, entity: "user", entityId: u!.id, entityLabel: u!.email, action: "token",
        after: { oauthGranted: client.name }, token: VIA_CLAUDE,
      }]);
      return res;
    }
    if (f.grant_type === "refresh_token") {
      if (!f.refresh_token) return fail("invalid_request", "refresh_token is required");
      const g = sqlite.prepare("SELECT * FROM avail_oauth_grants WHERE refresh_hash = ?").get(sha(f.refresh_token)) as GrantRow | undefined;
      if (!g || g.client_id !== client.id) return fail("invalid_grant", "The refresh token is not valid");
      if (g.revoked_at) return fail("invalid_grant", `Access was revoked on ${g.revoked_at.slice(0, 10)}. Connect again.`);
      if (g.refresh_expires_at <= at(0)) return fail("invalid_grant", "The connection expired. Connect again.");
      const u = personOf(g.user_id);
      const why = u ? connectRefusal(u, domainsOf(c.env.GOOGLE_ALLOWED_DOMAIN)) : "Unknown user";
      if (why) return fail("invalid_grant", why);
      return issue(g.user_id, g.scope, g.id);
    }
    return fail("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  app.post("/oauth/revoke", async (c) => {
    const sqlite = sqliteOf(c);
    const f = await bodyOf(c.req.raw);
    const t = f.token ?? "";
    const g = sqlite
      .prepare(
        `SELECT g.*, u.email, cl.name AS client_name FROM avail_oauth_grants g JOIN users u ON u.id = g.user_id JOIN avail_oauth_clients cl ON cl.id = g.client_id
          WHERE g.access_hash = ? OR g.refresh_hash = ?`,
      )
      .get(sha(t), sha(t)) as (GrantRow & { email: string; client_name: string }) | undefined;
    if (g && !g.revoked_at) {
      revokeGrantRow(sqlite, g.id, g.session_id, g.email, "disconnected in Claude");
      writeAudit(sqlite, [{
        actor: g.email, actorId: g.user_id, entity: "user", entityId: g.user_id, entityLabel: g.email, action: "token",
        after: { oauthRevoked: g.client_name, reason: "disconnected in Claude" }, token: VIA_CLAUDE,
      }]);
    }
    return c.body(null, 200, cors); // RFC 7009: 200 whatever the token was
  });

  app.get("/avail/users/:id/oauth", (c) => {
    if (!requireAdminOrToken(c)) return c.json({ error: "Admin access required" }, 403);
    const rows = sqliteOf(c)
      .prepare(
        `SELECT g.*, cl.name AS client_name FROM avail_oauth_grants g JOIN avail_oauth_clients cl ON cl.id = g.client_id
          WHERE g.user_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
      )
      .all(c.req.param("id")) as (GrantRow & { client_name: string })[];
    return c.json(rows.map((r) => grantInfo(r)), 200, NO_STORE);
  });

  app.post("/avail/oauth/grants/:id/revoke", (c) => {
    const auth = requireAdminOrToken(c);
    if (!auth) return c.json({ error: "Admin access required" }, 403);
    const sqlite = sqliteOf(c);
    const g = sqlite
      .prepare("SELECT g.*, cl.name AS client_name, u.email FROM avail_oauth_grants g JOIN avail_oauth_clients cl ON cl.id = g.client_id JOIN users u ON u.id = g.user_id WHERE g.id = ?")
      .get(c.req.param("id")) as (GrantRow & { client_name: string; email: string }) | undefined;
    if (!g) return c.json({ error: "Connection not found" }, 404);
    if (g.revoked_at) return c.json({ error: "Already revoked" }, 409);
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    sqlite.transaction(() => {
      revokeGrantRow(sqlite, g.id, g.session_id, actor.actor, "revoked by an admin");
      writeAudit(sqlite, [{ ...actor, entity: "user", entityId: g.user_id, entityLabel: g.email, action: "token", after: { oauthRevoked: g.client_name, reason: "revoked by an admin" } }]);
    })();
    const row = sqlite.prepare("SELECT g.*, cl.name AS client_name FROM avail_oauth_grants g JOIN avail_oauth_clients cl ON cl.id = g.client_id WHERE g.id = ?").get(g.id) as GrantRow & { client_name: string };
    return c.json(grantInfo(row));
  });
}
