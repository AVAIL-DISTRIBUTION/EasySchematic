/**
 * Roles, access and the audit log (step 2.1): users.ts, requestAudit.ts, audit.ts, migration 9007.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refuseDisabledSignIn } from "../src/requestAudit";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { LAST_ADMIN_ERROR, SYSTEM_ACCOUNT_ERROR } from "../src/users";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-users-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

/** A user with a session; returns its id and the cookie. */
function user(role: "contributor" | "moderator" | "admin", email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role, last_login_at) VALUES (?, ?, ?, ?, datetime('now'))").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

const put = (p: string, body: unknown, cookie?: string) =>
  req(p, { method: "PUT", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : BEARER) }, body: JSON.stringify(body) });

const audit = () => api.db.sqlite.prepare("SELECT * FROM avail_audit_log ORDER BY id").all() as Record<string, unknown>[];

describe("users (admin)", () => {
  it("lists users with AVAIL roles, last sign-in and access; admins only", async () => {
    const admin = user("admin", "boss@avail.test");
    const lib = user("moderator", "lib@avail.test");
    user("contributor", "eng@avail.test");
    const res = await req("/avail/users", { headers: { Cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const list = await json<{ email: string; role: string; active: boolean; lastLoginAt: string | null }[]>(res);
    expect(list.map((u) => [u.email, u.role, u.active])).toEqual([
      ["boss@avail.test", "admin", true],
      // The AI Assistant service account (migration 9010).
      ["claude@avail.invalid", "assistant", true],
      ["eng@avail.test", "engineer", true],
      ["lib@avail.test", "librarian", true],
    ]);
    expect(list[0].lastLoginAt).toBeTruthy();
    expect((await req("/avail/users", { headers: { Cookie: lib.cookie } })).status).toBe(403);
  });

  it("changes a role and logs it", async () => {
    const admin = user("admin", "boss@avail.test");
    const eng = user("contributor", "eng@avail.test");
    const res = await put(`/avail/users/${eng.id}/role`, { role: "librarian" }, admin.cookie);
    expect(await json(res)).toMatchObject({ email: "eng@avail.test", role: "librarian" });
    expect((api.db.sqlite.prepare("SELECT role FROM users WHERE id = ?").get(eng.id) as { role: string }).role).toBe("moderator");
    expect(audit()).toEqual([
      expect.objectContaining({
        actor: "boss@avail.test", actor_id: admin.id, entity: "user", entity_id: eng.id, entity_label: "eng@avail.test",
        action: "role", before: '{"role":"engineer"}', after: '{"role":"librarian"}',
      }),
    ]);
    expect((await put(`/avail/users/${eng.id}/role`, { role: "superuser" }, admin.cookie)).status).toBe(400);
  });

  it("the last active admin can be neither demoted nor disabled", async () => {
    const admin = user("admin", "boss@avail.test");
    let res = await put(`/avail/users/${admin.id}/role`, { role: "engineer" }, admin.cookie);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(LAST_ADMIN_ERROR);
    expect((await put(`/avail/users/${admin.id}/active`, { active: false }, admin.cookie)).status).toBe(409);
    // Upstream's own route goes through the same guard.
    expect((await put(`/users/${admin.id}/role`, { role: "contributor" }, admin.cookie)).status).toBe(409);
    expect((await put(`/users/${admin.id}/ban`, { banned: true }, admin.cookie)).status).toBe(409);
    // With a second admin, the first can step down.
    const second = user("admin", "second@avail.test");
    res = await put(`/avail/users/${admin.id}/role`, { role: "librarian" }, second.cookie);
    expect(res.status).toBe(200);
    expect(audit()).toHaveLength(1);
  });

  it("disabling signs the user out at once; their old cookie is anonymous; enabling again works", async () => {
    const admin = user("admin", "boss@avail.test");
    const eng = user("contributor", "eng@avail.test");
    expect((await req("/auth/me", { headers: { Cookie: eng.cookie } })).status).toBe(200);
    const res = await put(`/avail/users/${eng.id}/active`, { active: false }, admin.cookie);
    expect(await json(res)).toMatchObject({ active: false });
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(eng.id)).toEqual({ n: 0 });
    expect((await req("/auth/me", { headers: { Cookie: eng.cookie } })).status).toBe(401);
    // A session made after disabling (e.g. a sign-in) is dropped on the first request.
    const sid = crypto.randomUUID();
    api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, eng.id);
    expect((await req("/auth/me", { headers: { Cookie: `session=${sid}` } })).status).toBe(401);
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(eng.id)).toEqual({ n: 0 });
    await put(`/avail/users/${eng.id}/active`, { active: true }, admin.cookie);
    expect(audit().map((a) => [a.action, a.before, a.after])).toEqual([
      ["access", '{"active":true}', '{"active":false}'],
      ["access", '{"active":false}', '{"active":true}'],
    ]);
  });

  it("a disabled user's Google sign-in ends on ?error=account_disabled without a session", async () => {
    const eng = user("contributor", "eng@avail.test");
    api.db.sqlite.prepare("UPDATE users SET banned = 1 WHERE id = ?").run(eng.id);
    const sid = (api.db.sqlite.prepare("SELECT id FROM sessions WHERE user_id = ?").get(eng.id) as { id: string }).id;
    const upstreamPage = new Response('<meta http-equiv="refresh" content="1;url=https://sch.avail.test/#/x">', {
      headers: { "Set-Cookie": `session=${sid}; Path=/; HttpOnly` },
    });
    const res = await refuseDisabledSignIn(api.db.sqlite, upstreamPage);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://sch.avail.test/?error=account_disabled");
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(eng.id)).toEqual({ n: 0 });
  });
});

const template = (id: string, label = "Extron DTP3 T 203") => ({
  id,
  label,
  manufacturer: "Extron",
  modelNumber: "60-1885-52",
  deviceType: "hdbaset-extender",
  category: "AV distribution / Extenders",
  referenceUrl: "https://www.extron.com/product/dtp3t203",
  ports: [{ id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" }],
});

describe("system accounts (.invalid)", () => {
  it("are listed as system; their role and access cannot be changed, nothing is logged", async () => {
    const admin = user("admin", "boss@avail.test");
    const sys = user("contributor", "vendor-responses@avail.invalid");
    const list = await json<{ email: string; system: boolean }[]>(req("/avail/users", { headers: { Cookie: admin.cookie } }));
    expect(list.map((u) => [u.email, u.system])).toEqual([
      ["boss@avail.test", false],
      ["claude@avail.invalid", true],
      ["vendor-responses@avail.invalid", true],
    ]);
    for (const res of [
      await put(`/avail/users/${sys.id}/role`, { role: "librarian" }, admin.cookie),
      await put(`/avail/users/${sys.id}/active`, { active: false }, admin.cookie),
      await put(`/users/${sys.id}/role`, { role: "moderator" }),
    ]) {
      expect(res.status).toBe(409);
      expect((await json(res)).error).toBe(SYSTEM_ACCOUNT_ERROR);
    }
    expect(api.db.sqlite.prepare("SELECT role, banned FROM users WHERE id = ?").get(sys.id)).toEqual({ role: "contributor", banned: 0 });
    expect(audit()).toEqual([]);
  });
});

describe("audit log of templates", () => {
  it("created, updated (changed fields only), status, deleted — with the actor", async () => {
    const lib = user("moderator", "lib@avail.test");
    const headers = { "Content-Type": "application/json", Cookie: lib.cookie };
    // POST gives the template its own id.
    const created = await req("/templates", { method: "POST", headers, body: JSON.stringify(template("t-1")) });
    expect(created.status).toBe(201);
    const id = (await json<{ id: string }>(created)).id;
    expect((await req(`/templates/${id}`, { method: "PUT", headers, body: JSON.stringify(template(id, "Extron DTP3 T 203 v2")) })).status).toBeLessThan(400);
    expect((await put(`/avail/templates/${id}/status`, { status: "draft" }, lib.cookie)).status).toBe(200);
    expect((await req(`/templates/${id}`, { method: "DELETE", headers: BEARER })).status).toBeLessThan(400);
    const log = audit().map((a) => ({ actor: a.actor, action: a.action, before: a.before ? JSON.parse(a.before as string) : null, after: a.after ? JSON.parse(a.after as string) : null }));
    expect(log.map((l) => [l.actor, l.action])).toEqual([
      ["lib@avail.test", "created"],
      ["lib@avail.test", "updated"],
      ["lib@avail.test", "status"],
      ["admin-token", "deleted"],
    ]);
    expect(log[0].after).toMatchObject({ label: "Extron DTP3 T 203", manufacturer: "Extron" });
    expect(log[1]).toMatchObject({ before: { label: "Extron DTP3 T 203" }, after: { label: "Extron DTP3 T 203 v2" } });
    expect(log[2]).toMatchObject({ before: { status: "raw" }, after: { status: "draft" } });
    expect(log[3].before).toMatchObject({ label: "Extron DTP3 T 203 v2" });
  });

  it("GET /avail/audit: librarians and admins, newest first, filters and paging", async () => {
    const admin = user("admin", "boss@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const eng = user("contributor", "eng@avail.test");
    await put(`/avail/users/${eng.id}/role`, { role: "librarian" }, admin.cookie);
    await put(`/avail/users/${eng.id}/role`, { role: "engineer" }, admin.cookie);
    await req("/templates", { method: "POST", headers: { "Content-Type": "application/json", ...BEARER }, body: JSON.stringify(template("t-2")) });
    expect((await req("/avail/audit", { headers: { Cookie: eng.cookie } })).status).toBe(403);
    const all = await json<{ id: number; action: string; entity: string; after: unknown }[]>(req("/avail/audit", { headers: { Cookie: lib.cookie } }));
    expect(all.map((a) => a.action)).toEqual(["created", "role", "role"]);
    expect(all[1].after).toEqual({ role: "engineer" });
    const users = await json<unknown[]>(req(`/avail/audit?entity=user&entityId=${eng.id}`, { headers: { Cookie: admin.cookie } }));
    expect(users).toHaveLength(2);
    const page = await json<{ action: string }[]>(req(`/avail/audit?before=${all[0].id}&limit=1`, { headers: { Cookie: admin.cookie } }));
    expect(page.map((a) => a.action)).toEqual(["role"]);
    expect((await req("/avail/audit?entity=other", { headers: BEARER })).status).toBe(400);
  });
});

describe("audit log of CLI runs", () => {
  it("one summary entry per run: command, arguments, commit, totals; readable as entity=run", async () => {
    const { writeRunAudit, runningCommit } = await import("../src/audit");
    writeRunAudit(api.db.sqlite, { command: "import:catalog", args: ["--min-level", "A"], counts: { created: 5, updated: 3, hidden: undefined } }, "abc123");
    const rows = audit();
    expect(rows).toEqual([
      expect.objectContaining({ actor: "system", entity: "run", entity_id: "import:catalog", entity_label: "npm run import:catalog --min-level A", action: "run" }),
    ]);
    expect(JSON.parse(rows[0].after as string)).toEqual({ command: "import:catalog", args: ["--min-level", "A"], commit: "abc123", counts: { created: 5, updated: 3 } });
    const list = await json<{ entity: string }[]>(req("/avail/audit?entity=run", { headers: BEARER }));
    expect(list).toHaveLength(1);
    expect(runningCommit({ AVAIL_COMMIT: "deadbeef" })).toBe("deadbeef");
  });

  it("approve:catalog counts approved and left for review", async () => {
    const { approveRunCounts, catalogRunCounts } = await import("../src/runCounts");
    expect(approveRunCounts({ dryRun: false, rows: [{ result: "approved" }, { result: "source db" }, { result: "approved" }] } as never)).toEqual({ approved: 2, leftForReview: 1 });
    expect(
      catalogRunCounts({
        counts: { inserted: 2, updated: 1, unchanged: 4, "below-min": 9 },
        superseded: [{ action: "hidden" }, { action: "listed" }],
        removed: [{}],
      } as never),
    ).toEqual({ created: 2, updated: 1, hidden: 1, deleted: 1, unchanged: 4, belowMin: 9 });
  });
});
