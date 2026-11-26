/**
 * AI Assistant role and access tokens (step 2.5): roles.ts, accessTokens.ts, assistant.ts,
 * migration 9010 — what the role may and may not do, creating, using, revoking and expiring
 * tokens, the rate limit, and the audit log (actor = the token's user, with the token's name).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { hashToken, TokenRateLimiter } from "../src/accessTokens";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const ORIGIN = "https://sch.avail.test";
const CLAUDE = "avail-ai-assistant";
let dataDir: string;
let api: ApiServer;

function start(env: Record<string, string> = {}) {
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off", ALLOWED_ORIGINS: ORIGIN, ...env }), log: () => {} });
}
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-ai-"));
  start();
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (method: string, p: string, body: unknown, headers: Record<string, string>) =>
  req(p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });

function user(role: string, email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

const tpl = (id: string, label: string, modelNumber: string) => ({
  ...(id ? { id } : {}), label, manufacturer: "Extron", modelNumber, deviceType: "hdbaset-extender", category: "AV distribution / Extenders",
  referenceUrl: "https://www.extron.com/product/x",
  ports: [{ id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" }],
});

function insert(t: Record<string, unknown>, status = "verified") {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, 'avail-library')").run(t.id, status);
}

const inAYear = () => new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);

async function issue(adminCookie: string, userId = CLAUDE, name = "Claude Code — library") {
  const res = await send("POST", `/avail/users/${userId}/tokens`, { name, expiresAt: inAYear() }, { Cookie: adminCookie });
  expect(res.status).toBe(201);
  return json<{ token: { id: string; name: string; hint: string; state: string }; value: string }>(res);
}

const audit = () =>
  api.db.sqlite.prepare("SELECT actor, entity, entity_id, action, before, after, token FROM avail_audit_log ORDER BY id").all() as {
    actor: string; entity: string; entity_id: string; action: string; before: string | null; after: string | null; token: string | null;
  }[];

describe("the AI Assistant service account", () => {
  it("claude@avail.invalid exists with the AI Assistant role: System in Users, role and access fixed, tokens allowed", async () => {
    const admin = user("admin", "boss@avail.test");
    const list = await json<{ id: string; email: string; role: string; system: boolean; activeTokens: number }[]>(req("/avail/users", { headers: { Cookie: admin.cookie } }));
    expect(list.find((u) => u.email === "claude@avail.invalid")).toMatchObject({ id: CLAUDE, role: "assistant", system: true, activeTokens: 0 });
    expect((await send("PUT", `/avail/users/${CLAUDE}/role`, { role: "librarian" }, { Cookie: admin.cookie })).status).toBe(409);
    await issue(admin.cookie);
    const again = await json<{ email: string; activeTokens: number }[]>(req("/avail/users", { headers: { Cookie: admin.cookie } }));
    expect(again.find((u) => u.email === "claude@avail.invalid")!.activeTokens).toBe(1);
  });
});

describe("issuing tokens (admin)", () => {
  it("name and expiry required, at most a year, only for AI Assistant users, admins only; the value is shown once, only its hash is stored", async () => {
    const admin = user("admin", "boss@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const eng = user("contributor", "eng@avail.test");
    const post = (body: unknown, cookie = admin.cookie, id = CLAUDE) => send("POST", `/avail/users/${id}/tokens`, body, { Cookie: cookie });
    expect((await post({ name: "x", expiresAt: inAYear() }, lib.cookie)).status).toBe(403);
    expect((await post({ name: " ", expiresAt: inAYear() })).status).toBe(400);
    expect((await post({ name: "x" })).status).toBe(400);
    expect((await post({ name: "x", expiresAt: "2020-01-01" })).status).toBe(400);
    expect((await post({ name: "x", expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status).toBe(400);
    const notAi = await post({ name: "x", expiresAt: inAYear() }, admin.cookie, eng.id);
    expect(notAi.status).toBe(409);
    expect((await json(notAi)).error).toBe("Access tokens are only for users with the AI Assistant role");

    const { token, value } = await issue(admin.cookie);
    expect(value).toMatch(/^avail_ai_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({ name: "Claude Code — library", hint: value.slice(-4), state: "active" });
    const row = api.db.sqlite.prepare("SELECT * FROM avail_access_tokens").get() as Record<string, unknown>;
    expect(row.token_hash).toBe(hashToken(value));
    expect(Object.values(row)).not.toContain(value);
    const list = await json<Record<string, unknown>[]>(req(`/avail/users/${CLAUDE}/tokens`, { headers: { Cookie: admin.cookie } }));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(value);
    expect(list[0]).not.toHaveProperty("token_hash");
    expect(list[0].lastUsedAt).toBeNull();
    expect(audit().map((a) => [a.actor, a.entity_id, a.action, JSON.parse(a.after!).created, a.token])).toEqual([["boss@avail.test", CLAUDE, "token", "Claude Code — library", null]]);
  });
});

describe("what the AI Assistant may do", () => {
  it("signs in by token, reads the library, the audit log and the workspace, drafts, proposes, lints and normalizes without saving", async () => {
    const admin = user("admin", "boss@avail.test");
    insert(tpl("v1", "Extron DTP3 T 203", "60-1"));
    const { value } = await issue(admin.cookie);
    const ai = bearer(value);

    expect(await json(req("/auth/me", { headers: ai }))).toMatchObject({ email: "claude@avail.invalid", role: "assistant" });
    expect((await req("/templates", { headers: ai })).status).toBe(200);
    expect((await req("/avail/audit", { headers: ai })).status).toBe(200);
    expect((await req("/avail/workspace/templates", { headers: ai })).status).toBe(200);

    const version = () => api.db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(version) AS v FROM templates").get();
    const before = version();
    const lint = await json<{ level: string }>(send("POST", "/avail/lint", { template: tpl("", "Extron X", "60-9") }, ai));
    expect(lint.level).toMatch(/^(A|B|FIX)$/);
    const norm = await json<{ template: { label: string }; changes: unknown[]; before: unknown; after: unknown }>(
      send("POST", "/avail/normalize", { template: { ...tpl("", "EXTRON X", "60-9"), color: "#ff0000" } }, ai),
    );
    expect(norm.changes.length).toBeGreaterThan(0);
    expect(norm.template).not.toHaveProperty("color");
    expect(version()).toEqual(before);

    const draft = await send("POST", "/avail/templates/draft", tpl("", "Extron DTP3 R 203", "60-2"), ai);
    expect(draft.status).toBe(201);
    const d = await json<{ template: { id: string }; status: string; level: string }>(draft);
    expect(d).toMatchObject({ status: "draft" });
    expect(api.db.sqlite.prepare("SELECT status, source FROM avail_template_meta WHERE template_id = ?").get(d.template.id)).toEqual({ status: "draft", source: "ai-assistant" });
    expect(api.db.sqlite.prepare("SELECT submitted_by FROM templates WHERE id = ?").get(d.template.id)).toEqual({ submitted_by: CLAUDE });
    // A draft that duplicates another template: 409, as for any save.
    expect((await send("POST", "/avail/templates/draft", tpl("", "Extron DTP3 T 203 copy", "60-1"), ai)).status).toBe(409);

    const proposal = await send("POST", "/submissions", { action: "update", templateId: "v1", data: tpl("", "Extron DTP3 T 203", "60-1"), submitterNote: "HDMI port note", source: "manual" }, ai);
    expect(proposal.status).toBeLessThan(300);
  });

  it("may not approve, hide, edit, delete, merge, decide duplicates, change roles or access, issue tokens, run bulk actions", async () => {
    const admin = user("admin", "boss@avail.test");
    const eng = user("contributor", "eng@avail.test");
    insert(tpl("v1", "Extron DTP3 T 203", "60-1"), "draft");
    insert(tpl("v2", "Extron DTP3 T 203 B", "60-1"), "draft");
    const { value } = await issue(admin.cookie);
    const ai = bearer(value);
    const sub = await json<{ id: string }>(send("POST", "/submissions", { action: "update", templateId: "v1", data: tpl("", "Extron DTP3 T 203", "60-1"), submitterNote: "x", source: "manual" }, ai));
    const refused: [string, string, unknown][] = [
      ["PUT", "/avail/templates/v1/status", { status: "verified" }],
      ["PUT", "/avail/templates/v1/status", { status: "hidden" }],
      ["POST", "/avail/templates/status/batch", { ids: ["v1"], status: "verified" }],
      ["POST", "/avail/templates/category/batch", { ids: ["v1"], category: "AV distribution / Switchers" }],
      ["POST", "/avail/templates/merge", { primary: "v1", ids: ["v2"] }],
      ["POST", "/avail/templates/not-duplicates", { ids: ["v1", "v2"], comment: "x" }],
      ["PUT", "/templates/v1", tpl("v1", "Extron DTP3 T 203 edited", "60-1")],
      ["DELETE", "/templates/v1", undefined],
      ["POST", `/submissions/${sub.id}/approve`, {}],
      ["PUT", `/avail/users/${eng.id}/role`, { role: "librarian" }],
      ["PUT", `/avail/users/${eng.id}/active`, { active: false }],
      ["PUT", `/users/${eng.id}/role`, { role: "moderator" }],
      ["POST", `/avail/users/${CLAUDE}/tokens`, { name: "more", expiresAt: inAYear() }],
      ["GET", `/avail/users`, undefined],
    ];
    for (const [method, p, body] of refused) {
      const res = await send(method, p, body, ai);
      expect([401, 403], `${method} ${p}`).toContain(res.status);
    }
    expect((await req("/templates?include=hidden", { headers: ai })).status).toBe(403);
    expect(api.db.sqlite.prepare("SELECT template_id, status FROM avail_template_meta ORDER BY template_id").all()).toEqual([
      { template_id: "v1", status: "draft" },
      { template_id: "v2", status: "draft" },
    ]);
    expect(api.db.sqlite.prepare("SELECT role, banned FROM users WHERE id = ?").get(eng.id)).toEqual({ role: "contributor", banned: 0 });
  });
});

describe("the audit log names the token", () => {
  it("changes by token: actor = the token's user, token = its name; each write request logged", async () => {
    const admin = user("admin", "boss@avail.test");
    const { value } = await issue(admin.cookie, CLAUDE, "nightly import");
    const d = await json<{ template: { id: string } }>(send("POST", "/avail/templates/draft", tpl("", "Extron New", "60-7"), bearer(value)));
    await send("POST", "/avail/lint", { template: tpl("", "Extron X", "60-9") }, bearer(value));
    const log = audit().filter((a) => a.actor === "claude@avail.invalid");
    expect(log.map((a) => [a.entity, a.entity_id, a.action, a.token])).toEqual([
      ["template", d.template.id, "created", "nightly import"],
      ["user", CLAUDE, "request", "nightly import"],
      ["user", CLAUDE, "request", "nightly import"],
    ]);
    expect(JSON.parse(log[1].after!)).toEqual({ method: "POST", path: "/avail/templates/draft", status: 201 });
    const listed = await json<{ action: string; token: string | null }[]>(req(`/avail/audit?entity=template&entityId=${d.template.id}`, { headers: { Cookie: admin.cookie } }));
    expect(listed[0]).toMatchObject({ action: "created", token: "nightly import" });
    // A request by a person is not named.
    expect(audit().filter((a) => a.actor === "boss@avail.test").every((a) => a.token === null)).toBe(true);
  });
});

describe("revoked, expired, unknown tokens: 401 with a clear message", () => {
  it("revoke: one call, the token and its session stop working, logged", async () => {
    const admin = user("admin", "boss@avail.test");
    const { token, value } = await issue(admin.cookie);
    expect((await req("/auth/me", { headers: bearer(value) })).status).toBe(200);
    const sid = (api.db.sqlite.prepare("SELECT session_id FROM avail_access_tokens").get() as { session_id: string }).session_id;
    expect((await send("POST", `/avail/tokens/${token.id}/revoke`, {}, bearer(value))).status).toBe(403);
    const r = await json<{ state: string; revokedBy: string; lastUsedAt: string | null }>(send("POST", `/avail/tokens/${token.id}/revoke`, {}, { Cookie: admin.cookie }));
    expect(r).toMatchObject({ state: "revoked", revokedBy: "boss@avail.test" });
    expect(r.lastUsedAt).toBeTruthy();
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sid)).toEqual({ n: 0 });
    const res = await req("/auth/me", { headers: { ...bearer(value), Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect((await json(res)).error).toMatch(/^Access token "Claude Code — library" was revoked on \d{4}-\d\d-\d\d\. Ask an admin for a new token\.$/);
    expect(audit().filter((a) => a.action === "token").map((a) => JSON.parse(a.after!))).toEqual([
      expect.objectContaining({ created: "Claude Code — library" }),
      { revoked: "Claude Code — library", reason: "revoked by an admin" },
    ]);
  });

  it("expired: 401 naming the date; unknown: 401", async () => {
    const admin = user("admin", "boss@avail.test");
    const { value } = await issue(admin.cookie);
    api.db.sqlite.prepare("UPDATE avail_access_tokens SET expires_at = '2026-01-31 23:59:59'").run();
    const res = await req("/auth/me", { headers: bearer(value) });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('Access token "Claude Code — library" expired on 2026-01-31. Ask an admin for a new token.');
    const list = await json<{ state: string }[]>(req(`/avail/users/${CLAUDE}/tokens`, { headers: { Cookie: admin.cookie } }));
    expect(list[0].state).toBe("expired");
    const unknown = await req("/auth/me", { headers: bearer("avail_ai_nope") });
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).error).toBe("Access token is not valid. Check the value, or ask an admin for a new token.");
  });

  it("disabling the user revokes all their tokens; so does leaving the AI Assistant role", async () => {
    const admin = user("admin", "boss@avail.test");
    const bot = user("assistant", "bot@avail.test");
    const a = await issue(admin.cookie, bot.id, "first");
    const b = await issue(admin.cookie, bot.id, "second");
    expect((await req("/auth/me", { headers: bearer(a.value) })).status).toBe(200);
    expect((await send("PUT", `/avail/users/${bot.id}/active`, { active: false }, { Cookie: admin.cookie })).status).toBe(200);
    for (const v of [a.value, b.value]) {
      const res = await req("/auth/me", { headers: bearer(v) });
      expect(res.status).toBe(401);
      expect((await json(res)).error).toMatch(/was revoked/);
    }
    expect(api.db.sqlite.prepare("SELECT DISTINCT revoked_reason FROM avail_access_tokens").all()).toEqual([{ revoked_reason: "user disabled" }]);
    expect(JSON.parse(audit().find((x) => x.action === "access")!.after!)).toEqual({ active: false, tokensRevoked: ["first", "second"] });
    // Enabled again: the tokens stay revoked; a new one is needed.
    await send("PUT", `/avail/users/${bot.id}/active`, { active: true }, { Cookie: admin.cookie });
    expect((await req("/auth/me", { headers: bearer(a.value) })).status).toBe(401);

    const c = await issue(admin.cookie, bot.id, "third");
    await send("PUT", `/avail/users/${bot.id}/role`, { role: "librarian" }, { Cookie: admin.cookie });
    const res = await req("/auth/me", { headers: bearer(c.value) });
    expect(res.status).toBe(401);
    expect(api.db.sqlite.prepare("SELECT revoked_reason FROM avail_access_tokens WHERE name = 'third'").get()).toEqual({ revoked_reason: "role changed" });
  });

  it("a token whose user stopped being an AI Assistant without a revoke (changed in the database) is refused", async () => {
    const admin = user("admin", "boss@avail.test");
    const bot = user("assistant", "bot@avail.test");
    const { value } = await issue(admin.cookie, bot.id);
    api.db.sqlite.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(bot.id);
    const res = await req("/avail/workspace/templates", { headers: bearer(value) });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('Access token "Claude Code — library" works only for an AI Assistant user; this user is now Librarian.');
  });
});

describe("rate limit per token", () => {
  it("over the limit: 429 with Retry-After; another token is not affected", async () => {
    api.close();
    start({ AI_TOKEN_RATE_LIMIT: "3" });
    const admin = user("admin", "boss@avail.test");
    const a = await issue(admin.cookie, CLAUDE, "a");
    const b = await issue(admin.cookie, CLAUDE, "b");
    for (let i = 0; i < 3; i++) expect((await req("/auth/me", { headers: bearer(a.value) })).status).toBe(200);
    const res = await req("/auth/me", { headers: bearer(a.value) });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await json(res)).error).toMatch(/^Too many requests with access token "a": at most 3 a minute\. Try again in \d+ s\.$/);
    expect((await req("/auth/me", { headers: bearer(b.value) })).status).toBe(200);
  });

  it("the window resets after a minute", () => {
    const l = new TokenRateLimiter(2);
    expect([l.take("t", 0), l.take("t", 1000), l.take("t", 2000)]).toEqual([null, null, 58]);
    expect(l.take("t", 60_000)).toBeNull();
  });
});
