/**
 * Access tokens for AI Assistant users (step 2.5; table avail_access_tokens, migration 9010).
 *
 * An admin creates a token for a user with the AI Assistant role (name, expiry — required, at most
 * a year); its value (avail_ai_…) is shown once, only its SHA-256 is stored. A request with
 * `Authorization: Bearer avail_ai_…` is signed in as that user without Google (server.ts,
 * resolveAccessToken): the header is replaced with an internal session cookie, so upstream's checks
 * (requireSession, requireModerator…) see a plain user with role "assistant". Refused with 401 and a
 * message: unknown, revoked or expired token, disabled user, user no longer an AI Assistant; 429 over
 * the rate limit (AI_TOKEN_RATE_LIMIT requests a minute per token, default 120).
 *
 *   GET  /avail/users/:id/tokens        admin: the user's tokens (no values), last used, state
 *   POST /avail/users/:id/tokens        admin: { name, expiresAt } → { token, value } (value once)
 *   POST /avail/tokens/:id/revoke       admin: revoke now (its session goes too)
 *
 * Disabling a user revokes all their tokens (users.ts). Token lifecycle goes to the audit log
 * (entity user, action token); every change made with a token names it (audit.ts requestContext),
 * and each write request made with one is logged (action request).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireAdminOrToken } from "../../api/src/auth";
import { isAssistant, ROLE_LABELS, availRoleOf } from "../../src/avail/roles";
import { ADMIN_TOKEN_ACTOR, writeAudit, writeAuditD1 } from "./audit";

type UpstreamApp = typeof UpstreamAppValue;

export const TOKEN_PREFIX = "avail_ai_";
/** Longest a token may live. */
export const MAX_TOKEN_DAYS = 366;
export const DEFAULT_RATE_LIMIT = 120;

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");

export function newTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export interface AccessTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  hint: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  session_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

export interface AccessTokenInfo {
  id: string;
  userId: string;
  name: string;
  /** Last 4 characters of the value. */
  hint: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  state: "active" | "expired" | "revoked";
}

/** SQLite datetime text ("YYYY-MM-DD HH:MM:SS", UTC). */
export const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export function tokenInfo(r: AccessTokenRow, now: Date = new Date()): AccessTokenInfo {
  return {
    id: r.id, userId: r.user_id, name: r.name, hint: r.hint, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by, revokedReason: r.revoked_reason,
    state: r.revoked_at ? "revoked" : r.expires_at <= sqlTime(now) ? "expired" : "active",
  };
}

// ---------------------------------------------------------------------------- rate limit

/** Fixed one-minute windows per token, in memory (one API process). */
export class TokenRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(readonly perMinute: number = DEFAULT_RATE_LIMIT) {}

  /** null when allowed, else seconds to wait. */
  take(tokenId: string, now: number = Date.now()): number | null {
    const w = this.windows.get(tokenId);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(tokenId, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return null;
    }
    if (w.count >= this.perMinute) return Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
    w.count++;
    return null;
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(k);
  }
}

export function rateLimitFromEnv(v: string | undefined): number {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

// ---------------------------------------------------------------------------- sign-in by token

export type TokenResolution =
  | { kind: "none" }
  | { kind: "refused"; status: 401 | 429; body: { error: string }; headers?: Record<string, string> }
  | { kind: "ok"; request: Request; token: { id: string; name: string; userId: string; email: string } };

const day = (t: string) => t.slice(0, 10);

/**
 * A request with `Authorization: Bearer avail_ai_…`: checks the token and, when it is good, returns
 * the request signed in as its user (internal session cookie instead of the header). Any other
 * request: { kind: "none" }.
 */
export function resolveAccessToken(sqlite: Database.Database, request: Request, limiter: TokenRateLimiter): TokenResolution {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith(`Bearer ${TOKEN_PREFIX}`)) return { kind: "none" };
  const value = auth.slice(7).trim();
  const refuse = (error: string): TokenResolution => ({ kind: "refused", status: 401, body: { error }, headers: { "WWW-Authenticate": 'Bearer realm="avail"' } });
  const row = sqlite
    .prepare(
      `SELECT t.*, u.email, u.role, u.banned, t.expires_at <= datetime('now') AS expired
         FROM avail_access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
    .get(hashToken(value)) as (AccessTokenRow & { email: string; role: string; banned: number; expired: number }) | undefined;
  if (!row) return refuse("Access token is not valid. Check the value, or ask an admin for a new token.");
  if (row.revoked_at) return refuse(`Access token "${row.name}" was revoked on ${day(row.revoked_at)}. Ask an admin for a new token.`);
  if (row.expired) return refuse(`Access token "${row.name}" expired on ${day(row.expires_at)}. Ask an admin for a new token.`);
  if (row.banned) return refuse(`Access token "${row.name}" belongs to a disabled user.`);
  if (!isAssistant(row.role)) {
    return refuse(`Access token "${row.name}" works only for an AI Assistant user; this user is now ${ROLE_LABELS[availRoleOf(row.role)]}.`);
  }
  const wait = limiter.take(row.id);
  if (wait !== null) {
    return {
      kind: "refused",
      status: 429,
      body: { error: `Too many requests with access token "${row.name}": at most ${limiter.perMinute} a minute. Try again in ${wait} s.` },
      headers: { "Retry-After": String(wait) },
    };
  }
  // The internal session upstream signs the user in with; recreated when it is gone.
  let sid = row.session_id;
  const live = sid && sqlite.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > datetime('now')").get(sid, row.user_id);
  sqlite.transaction(() => {
    if (!live) {
      sid = randomBytes(32).toString("hex");
      sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(sid, row.user_id, row.expires_at);
      if (row.session_id) sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    }
    sqlite.prepare("UPDATE avail_access_tokens SET last_used_at = datetime('now'), session_id = ? WHERE id = ?").run(sid, row.id);
  })();
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("Cookie", `session=${sid}`);
  return { kind: "ok", request: new Request(request, { headers }), token: { id: row.id, name: row.name, userId: row.user_id, email: row.email } };
}

/** The write requests a token made: one audit entry each (method, path, status). */
export function logTokenRequest(sqlite: Database.Database, token: { userId: string; email: string; name: string }, request: Request, status: number): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  writeAudit(sqlite, [{
    actor: token.email, actorId: token.userId, entity: "user", entityId: token.userId, entityLabel: token.email, action: "request",
    after: { method: request.method, path: new URL(request.url).pathname, status }, token: token.name,
  }]);
}

/** Answers of resolveAccessToken that refuse a request, served by an internal route (CORS applies). */
export const pendingRefusals = new WeakMap<Request, { status: 401 | 429; body: { error: string }; headers?: Record<string, string> }>();
export const REFUSAL_PATH = "/avail/internal/token-refused";

// ---------------------------------------------------------------------------- revoke

/** Revokes a user's active tokens and deletes their sessions; returns the revoked tokens. */
export async function revokeUserTokens(db: D1Database, userId: string, by: string, reason: string): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare("SELECT id, name, session_id FROM avail_access_tokens WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .all<{ id: string; name: string; session_id: string | null }>();
  if (!results.length) return [];
  await db.batch(
    results.flatMap((t) => [
      db.prepare("UPDATE avail_access_tokens SET revoked_at = datetime('now'), revoked_by = ?, revoked_reason = ?, session_id = NULL WHERE id = ?").bind(by, reason, t.id),
      ...(t.session_id ? [db.prepare("DELETE FROM sessions WHERE id = ?").bind(t.session_id)] : []),
    ]),
  );
  return results.map((t) => ({ id: t.id, name: t.name }));
}

// ---------------------------------------------------------------------------- routes

export function registerAccessTokenRoutes(app: UpstreamApp): void {
  app.all(REFUSAL_PATH, (c) => {
    const r = pendingRefusals.get(c.req.raw);
    return r ? c.json(r.body, r.status, { "Cache-Control": "no-store", ...r.headers }) : c.json({ error: "Not found" }, 404);
  });

  app.get("/avail/users/:id/tokens", async (c) => {
    if (!requireAdminOrToken(c)) return c.json({ error: "Admin access required" }, 403);
    const { results } = await c.env.easyschematic_db
      .prepare("SELECT * FROM avail_access_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC")
      .bind(c.req.param("id"))
      .all<AccessTokenRow>();
    return c.json(results.map((r) => tokenInfo(r)), 200, { "Cache-Control": "no-store" });
  });

  app.post("/avail/users/:id/tokens", async (c) => {
    const auth = requireAdminOrToken(c);
    if (!auth) return c.json({ error: "Admin access required" }, 403);
    let body: { name?: unknown; expiresAt?: unknown };
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return c.json({ error: "A token needs a name (up to 80 characters), e.g. what it is for" }, 400);
    const expires = typeof body.expiresAt === "string" ? new Date(body.expiresAt.length === 10 ? `${body.expiresAt}T23:59:59Z` : body.expiresAt) : null;
    const now = Date.now();
    if (!expires || Number.isNaN(expires.getTime())) return c.json({ error: "expiresAt is required: the date the token stops working" }, 400);
    if (expires.getTime() <= now) return c.json({ error: "expiresAt must be in the future" }, 400);
    if (expires.getTime() > now + MAX_TOKEN_DAYS * 86_400_000) return c.json({ error: `A token may live at most ${MAX_TOKEN_DAYS} days` }, 400);

    const db = c.env.easyschematic_db;
    const user = await db.prepare("SELECT id, email, role, banned FROM users WHERE id = ?").bind(c.req.param("id")).first<{ id: string; email: string; role: string; banned: number }>();
    if (!user) return c.json({ error: "User not found" }, 404);
    if (!isAssistant(user.role)) return c.json({ error: "Access tokens are only for users with the AI Assistant role" }, 409);
    if (user.banned) return c.json({ error: "The user is disabled: enable them first" }, 409);

    const value = newTokenValue();
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const row: AccessTokenRow = {
      id: randomUUID(), user_id: user.id, name, token_hash: hashToken(value), hint: value.slice(-4), created_by: actor.actor,
      created_at: sqlTime(new Date(now)), expires_at: sqlTime(expires), last_used_at: null, session_id: null, revoked_at: null, revoked_by: null, revoked_reason: null,
    };
    await db
      .prepare("INSERT INTO avail_access_tokens (id, user_id, name, token_hash, hint, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.user_id, row.name, row.token_hash, row.hint, row.created_by, row.created_at, row.expires_at)
      .run();
    await writeAuditD1(db, [{
      ...actor, entity: "user", entityId: user.id, entityLabel: user.email, action: "token",
      before: null, after: { created: name, expiresAt: row.expires_at, hint: row.hint },
    }]);
    return c.json({ token: tokenInfo(row), value }, 201, { "Cache-Control": "no-store" });
  });

  app.post("/avail/tokens/:id/revoke", async (c) => {
    const auth = requireAdminOrToken(c);
    if (!auth) return c.json({ error: "Admin access required" }, 403);
    const db = c.env.easyschematic_db;
    const row = await db.prepare("SELECT * FROM avail_access_tokens WHERE id = ?").bind(c.req.param("id")).first<AccessTokenRow>();
    if (!row) return c.json({ error: "Token not found" }, 404);
    if (row.revoked_at) return c.json(tokenInfo(row), 200, { "Cache-Control": "no-store" });
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    await db.batch([
      db.prepare("UPDATE avail_access_tokens SET revoked_at = datetime('now'), revoked_by = ?, revoked_reason = 'revoked by an admin', session_id = NULL WHERE id = ?").bind(actor.actor, row.id),
      ...(row.session_id ? [db.prepare("DELETE FROM sessions WHERE id = ?").bind(row.session_id)] : []),
    ]);
    const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(row.user_id).first<{ email: string }>();
    await writeAuditD1(db, [{
      ...actor, entity: "user", entityId: row.user_id, entityLabel: user?.email ?? null, action: "token",
      before: { token: row.name, hint: row.hint }, after: { revoked: row.name, reason: "revoked by an admin" },
    }]);
    const fresh = await db.prepare("SELECT * FROM avail_access_tokens WHERE id = ?").bind(row.id).first<AccessTokenRow>();
    return c.json(tokenInfo(fresh!), 200, { "Cache-Control": "no-store" });
  });
}
