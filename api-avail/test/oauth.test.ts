/**
 * OAuth 2.1 for the MCP connector (step 2.8; src/oauth.ts, migration 9013): discovery, dynamic client
 * registration, sign-in and consent, PKCE, refresh rotation; requests act as the user who connected —
 * an engineer and a librarian through MCP, the audit log "via Claude"; a disabled user is refused and
 * their connections revoked; revoking in Users; static AI Assistant tokens keep working. Also the
 * linter previews (lint / normalize) with the template's lifecycle.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { resetMcpCache } from "../src/mcp";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const ISSUER = "https://sch.avail.test/api";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-oauth-"));
  api = createApiServer({
    ...configFromEnv({
      DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off", ALLOWED_ORIGINS: "https://sch.avail.test", API_PUBLIC_URL: ISSUER,
      GOOGLE_ALLOWED_DOMAIN: "avail-int.com", DISABLE_MAGIC_LINK: "1",
    }),
    log: () => {},
  });
  resetMcpCache();
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const form = (p: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  req(p, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });

function user(role: string, email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

const tpl = (id: string, label: string, modelNumber: string, over: Record<string, unknown> = {}) => ({
  id, label, shortName: label.split(" ").slice(1).join(" "), manufacturer: "Extron", modelNumber, deviceType: "hdbaset-extender",
  category: "AV distribution / Extenders", auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
  heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3, powerDrawW: 6, voltage: "12V DC",
  referenceUrl: "https://www.extron.com/product/x", searchTerms: [modelNumber],
  ports: [
    { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
    { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
  ],
  ...over,
});

function insert(t: Record<string, unknown>, status = "verified", lifecycle: { lifecycle: string; available_from?: string } = { lifecycle: "active" }) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite
    .prepare("INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, lifecycle, available_from) VALUES (?, ?, 'A', 1, ?, ?)")
    .run(t.id, status, lifecycle.lifecycle, lifecycle.available_from ?? null);
}

/** Claude registers itself (dynamic client registration, public client). */
async function register(): Promise<string> {
  const res = await req("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${ISSUER}/mcp`, ...extra })}`;

/** The whole connection: consent page, Allow, code → tokens. */
async function connect(cookie: string): Promise<{ access: string; refresh: string; clientId: string; consent: string }> {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const page = await req(authorizeUrl(clientId, challenge), { headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  const consent = await page.text();
  const pending = /name="pending" value="([^"]+)"/.exec(consent)![1];
  const allow = await form("/oauth/authorize", { pending, decision: "allow" }, { Cookie: cookie });
  expect(allow.status).toBe(302);
  const back = new URL(allow.headers.get("Location")!);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get("state")).toBe("st-1");
  expect(back.searchParams.get("iss")).toBe(ISSUER);
  const tokens = await json<{ access_token: string; refresh_token: string; token_type: string; expires_in: number }>(
    form("/oauth/token", { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }),
  );
  expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId, consent };
}

let rpcId = 1;
async function mcp(access: string, method: string, params?: unknown) {
  const res = await req("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: unknown; error_description?: string } | null };
}
async function tool<T = Record<string, unknown>>(access: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp(access, "tools/call", { name, arguments: args });
  const r = body!.result as { content: { text: string }[]; isError?: boolean };
  return { data: JSON.parse(r.content[0].text) as T, isError: r.isError ?? false };
}
const toolNames = async (access: string) => ((await mcp(access, "tools/list")).body!.result!.tools as { name: string }[]).map((t) => t.name);
const auditOf = (actor: string) =>
  api.db.sqlite.prepare("SELECT action, entity_id, after, token FROM avail_audit_log WHERE actor = ? ORDER BY id").all(actor) as { action: string; entity_id: string; after: string; token: string | null }[];

describe("discovery and registration", () => {
  it("MCP without a token: 401 pointing at the protected-resource metadata; metadata on both well-known forms", async () => {
    const res = await req("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer realm="avail", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", error="invalid_token"`);
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      expect(await json(req(p))).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    }
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api"]) {
      expect(await json(req(p))).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
  });

  it("registration: https or loopback redirect URIs only; a confidential client gets a secret", async () => {
    const reg = (body: unknown) => req("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await reg({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await reg({ redirect_uris: [] })).status).toBe(400);
    expect((await reg({ redirect_uris: ["http://localhost:4567/callback"] })).status).toBe(201);
    const conf = await json<{ client_secret?: string }>(reg({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" }));
    expect(conf.client_secret).toBeTruthy();
  });
});

describe("authorize: Google Workspace sign-in, consent, PKCE", () => {
  it("signed out → Google sign-in that returns to this request; unknown client and no PKCE refused", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await req(authorizeUrl(clientId, challenge));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/auth/google/start`);
    expect(to.searchParams.get("returnTo")).toBe(`${ISSUER}${authorizeUrl(clientId, challenge)}`);
    expect((await req(authorizeUrl("nope", challenge))).status).toBe(400);
    const noPkce = await req(authorizeUrl(clientId, "", { code_challenge_method: "plain" }), { headers: { Cookie: user("contributor", "e@avail-int.com").cookie } });
    expect(new URL(noPkce.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("consent names the user, role and abilities; Deny → access_denied; a wrong verifier or a reused code → invalid_grant", async () => {
    const eng = user("contributor", "eng@avail-int.com");
    const { consent } = await connect(eng.cookie);
    expect(consent).toContain("eng@avail-int.com");
    expect(consent).toContain("(Engineer)");
    expect(consent).toContain("Propose template changes for librarian review");
    expect(consent).not.toContain("Create draft templates");

    const clientId = await register();
    const { verifier, challenge } = pkce();
    const pending = (await (await req(authorizeUrl(clientId, challenge), { headers: { Cookie: eng.cookie } })).text()).match(/name="pending" value="([^"]+)"/)![1];
    const deny = await form("/oauth/authorize", { pending, decision: "deny" }, { Cookie: eng.cookie });
    expect(new URL(deny.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");

    const p2 = (await (await req(authorizeUrl(clientId, challenge), { headers: { Cookie: eng.cookie } })).text()).match(/name="pending" value="([^"]+)"/)![1];
    // The form of another signed-in user is refused.
    const other = user("contributor", "other@avail-int.com");
    expect((await form("/oauth/authorize", { pending: p2, decision: "allow" }, { Cookie: other.cookie })).status).toBe(400);
    const p3 = (await (await req(authorizeUrl(clientId, challenge), { headers: { Cookie: eng.cookie } })).text()).match(/name="pending" value="([^"]+)"/)![1];
    const code = new URL((await form("/oauth/authorize", { pending: p3, decision: "allow" }, { Cookie: eng.cookie })).headers.get("Location")!).searchParams.get("code")!;
    const bad = await json(form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: "x".repeat(50) }));
    expect(bad).toMatchObject({ error: "invalid_grant" });
    // The code was used up by the failed attempt.
    expect(await json(form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }))).toMatchObject({ error: "invalid_grant" });
  });

  it("AI Assistant and system accounts, and accounts outside the Workspace domain, cannot connect", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    for (const u of [user("assistant", "bot@avail-int.com"), user("contributor", "someone@gmail.com")]) {
      const res = await req(authorizeUrl(clientId, challenge), { headers: { Cookie: u.cookie } });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Cannot connect Claude");
    }
  });
});

describe("requests act as the user who connected", () => {
  it("engineer: reads the library and proposes changes, as in the interface; librarian tools refused; logged via Claude", async () => {
    insert(tpl("v1", "Extron DTP3 T 203", "60-1"));
    insert(tpl("d1", "Extron DTP3 R 203", "60-2"), "draft");
    insert(tpl("h1", "Extron Hidden", "60-3"), "hidden");
    const eng = user("contributor", "eng@avail-int.com");
    const { access } = await connect(eng.cookie);

    expect(await toolNames(access)).toEqual(["search_templates", "get_template", "lint_template", "normalize_template", "propose_change"]);
    const found = await tool<{ total: number; items: { id: string }[] }>(access, "search_templates", { vendor: "Extron" });
    expect(found.data.items.map((i) => i.id).sort()).toEqual(["d1", "v1"]);
    const one = await tool<{ id: string; history?: unknown; raw: { id: string } }>(access, "get_template", { id: "v1" });
    expect(one.data).toMatchObject({ id: "v1", raw: { id: "v1" } });
    expect(one.data.history).toBeUndefined(); // the audit log is not an engineer's
    expect(await tool(access, "audit_log")).toMatchObject({ isError: true, data: { error: expect.stringContaining("Librarian or Admin") } });
    expect(await tool(access, "create_draft_template", { template: tpl("", "Extron New", "60-9") })).toMatchObject({ isError: true });

    const p = await tool<{ proposal_id: string; changes: string[] }>(access, "propose_change", { template_id: "v1", patch: { powerDrawW: 7 }, comment: "Data sheet p. 2" });
    expect(p.data.changes).toEqual(["powerDrawW"]);
    expect(api.db.sqlite.prepare("SELECT user_id FROM submissions WHERE id = ?").get(p.data.proposal_id)).toEqual({ user_id: eng.id });
    const log = auditOf("eng@avail-int.com");
    expect(log.map((e) => [e.action, e.token])).toEqual([
      ["token", "via Claude"],
      ["proposed", "via Claude"],
    ]);
    expect(JSON.parse(log[0].after)).toEqual({ oauthGranted: "Claude" });
  });

  it("librarian: their rights — review queue, drafts, the audit log; static AI Assistant tokens keep working", async () => {
    insert(tpl("d1", "Extron DTP3 R 203", "60-2"), "draft");
    const lib = user("moderator", "lib@avail-int.com");
    const { access } = await connect(lib.cookie);
    expect((await toolNames(access)).length).toBe(9);
    expect((await tool<{ total: number }>(access, "review_queue")).data.total).toBe(1);
    const draft = await tool<{ id: string; status: string }>(access, "create_draft_template", { template: tpl("", "Extron New One", "60-9") });
    expect(draft).toMatchObject({ isError: false, data: { status: "draft" } });
    expect(auditOf("lib@avail-int.com").find((e) => e.action === "created")).toMatchObject({ entity_id: draft.data.id, token: "via Claude" });
    expect((await tool(access, "audit_log", { limit: 5 })).isError).toBe(false);

    const admin = user("admin", "boss@avail-int.com");
    const t = await json<{ value: string }>(
      req("/avail/users/avail-ai-assistant/tokens", {
        method: "POST", headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "automation", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      }),
    );
    expect((await toolNames(t.value)).length).toBe(9);
  });

  it("refresh rotates both tokens; the old ones stop working", async () => {
    const eng = user("contributor", "eng@avail-int.com");
    const { access, refresh, clientId } = await connect(eng.cookie);
    const next = await json<{ access_token: string; refresh_token: string }>(form("/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }));
    expect(next.access_token).not.toBe(access);
    expect((await mcp(next.access_token, "tools/list")).status).toBe(200);
    expect((await mcp(access, "tools/list")).status).toBe(401);
    expect(await json(form("/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }))).toMatchObject({ error: "invalid_grant" });
  });
});

describe("Users: connections, revoke, disabled users", () => {
  it("admin lists a user's connections and revokes one: Claude gets 401, the log says so", async () => {
    const eng = user("contributor", "eng@avail-int.com");
    const admin = user("admin", "boss@avail-int.com");
    const { access } = await connect(eng.cookie);
    expect((await req(`/avail/users/${eng.id}/oauth`, { headers: { Cookie: eng.cookie } })).status).toBe(403);
    const list = await json<{ id: string; client: string; state: string; lastUsedAt: string | null }[]>(req(`/avail/users/${eng.id}/oauth`, { headers: { Cookie: admin.cookie } }));
    expect(list).toEqual([expect.objectContaining({ client: "Claude", state: "active" })]);
    expect(list[0].lastUsedAt).toBeTruthy();
    const users = await json<{ email: string; activeClaudeAccess: number }[]>(req("/avail/users", { headers: { Cookie: admin.cookie } }));
    expect(users.find((u) => u.email === "eng@avail-int.com")!.activeClaudeAccess).toBe(1);

    expect((await req(`/avail/oauth/grants/${list[0].id}/revoke`, { method: "POST", headers: { Cookie: admin.cookie } })).status).toBe(200);
    const after = await mcp(access, "tools/list");
    expect(after.status).toBe(401);
    expect(JSON.stringify(after.body)).toMatch(/Access for Claude was revoked/);
    const entry = auditOf("boss@avail-int.com").find((e) => e.action === "token")!;
    expect(JSON.parse(entry.after)).toEqual({ oauthRevoked: "Claude", reason: "revoked by an admin" });
  });

  it("disabling a user revokes their connections; their token is refused; signing in again is refused", async () => {
    const eng = user("contributor", "eng@avail-int.com");
    const admin = user("admin", "boss@avail-int.com");
    const { access, refresh, clientId } = await connect(eng.cookie);
    const res = await req(`/avail/users/${eng.id}/active`, { method: "PUT", headers: { Cookie: admin.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(res.status).toBe(200);
    expect((await mcp(access, "tools/list")).status).toBe(401);
    expect(await json(form("/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }))).toMatchObject({ error: "invalid_grant" });
    const list = await json<{ state: string; revokedReason: string }[]>(req(`/avail/users/${eng.id}/oauth`, { headers: { Cookie: admin.cookie } }));
    expect(list).toEqual([expect.objectContaining({ state: "revoked", revokedReason: "user disabled" })]);
    const access_ = api.db.sqlite.prepare("SELECT after FROM avail_audit_log WHERE action = 'access' ORDER BY id DESC LIMIT 1").get() as { after: string };
    expect(JSON.parse(access_.after)).toMatchObject({ active: false, claudeAccessRevoked: ["Claude"] });
    // Disabled: the session is gone, so authorize sends them to Google, which refuses a disabled account.
    const again = await req(authorizeUrl(clientId, pkce().challenge), { headers: { Cookie: eng.cookie } });
    expect(new URL(again.headers.get("Location")!).pathname).toBe("/api/auth/google/start");
  });
});

describe("linter previews follow the template's lifecycle (as on save)", () => {
  const estimated = (id: string) =>
    tpl(id, "Extron DTP4 T 203", `60-${id}`, {
      ports: [
        { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
        { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel", notes: "estimated from DTP3 T 202" },
      ],
    });

  it("lint_template and normalize_template: an upcoming product's estimates keep level A — by id, or by raw's availLifecycle", async () => {
    insert(estimated("u1"), "draft", { lifecycle: "upcoming", available_from: "2027-Q3" });
    insert(estimated("a1"), "draft");
    const lib = user("moderator", "lib@avail-int.com");
    const { access } = await connect(lib.cookie);
    expect((await tool<{ level: string }>(access, "lint_template", { template: estimated("u1") })).data.level).toBe("A");
    expect((await tool<{ level: string; warnings: string[] }>(access, "lint_template", { template: estimated("a1") })).data).toMatchObject({ level: "B" });
    const raw = (await tool<{ raw: Record<string, unknown> }>(access, "get_template", { id: "u1", history: 0 })).data.raw;
    expect(raw.availLifecycle).toEqual({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    const { id: _id, ...noId } = raw;
    expect((await tool<{ level: string }>(access, "lint_template", { template: noId })).data.level).toBe("A");
    const n = await tool<{ level_before: string; level_after: string }>(access, "normalize_template", { template: estimated("u1") });
    expect(n.data).toMatchObject({ level_before: "A", level_after: "A" });
  });
});
