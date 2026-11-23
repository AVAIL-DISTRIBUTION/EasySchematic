/**
 * Template status (avail_template_meta, migration 9001) and the /avail/templates/…/status
 * routes registered on the upstream app.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { lintRow } from "../src/templateMeta";

const ADMIN_TOKEN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-status-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "if-empty" }), log: () => {} });
});

afterAll(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));

function session(role: "user" | "moderator" | "admin", email = `${role}@avail.test`): string {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)").run(userId, email, role);
  api.db.sqlite
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .run(sessionId, userId);
  return `session=${sessionId}`;
}

function put(id: string, body: unknown, headers: Record<string, string> = {}) {
  return req(`/avail/templates/${encodeURIComponent(id)}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function firstTemplateId(): string {
  return (api.db.sqlite.prepare("SELECT id FROM templates ORDER BY sort_order LIMIT 1").get() as { id: string }).id;
}

describe("avail_template_meta", () => {
  it("is created by our migration, upstream tables untouched", () => {
    const cols = (api.db.sqlite.prepare("PRAGMA table_info(avail_template_meta)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["template_id", "status", "source", "upstream_id", "lint_level", "updated_by", "updated_at"]);
    const templateCols = (api.db.sqlite.prepare("PRAGMA table_info(templates)").all() as { name: string }[]).map((c) => c.name);
    expect(templateCols.some((c) => c.includes("status") || c.includes("avail"))).toBe(false);
  });

  it("rejects unknown statuses at the database level", () => {
    expect(() =>
      api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status) VALUES (?, 'approved')").run(firstTemplateId()),
    ).toThrow(/CHECK/);
  });

  it("goes away with its template (ON DELETE CASCADE)", () => {
    const db = api.db.sqlite;
    db.prepare("INSERT INTO templates (id, device_type, label, ports) VALUES ('tmp-del', 'switcher', 'Tmp', '[]')").run();
    db.prepare("INSERT INTO avail_template_meta (template_id, status) VALUES ('tmp-del', 'draft')").run();
    db.prepare("DELETE FROM templates WHERE id = 'tmp-del'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM avail_template_meta WHERE template_id = 'tmp-del'").get()).toEqual({ n: 0 });
  });
});

describe("GET /avail/templates/status", () => {
  it("lists every library template; without a meta row the status is raw", async () => {
    const res = await req("/avail/templates/status");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { templateId: string; status: string }[];
    expect(list.length).toBe(api.seed.seeded);
    expect(list[0]).toMatchObject({ status: "raw", source: null, lintLevel: null });
  });

  it("filters by status and rejects unknown ones", async () => {
    expect(((await (await req("/avail/templates/status?status=verified")).json()) as unknown[]).length).toBe(0);
    expect((await req("/avail/templates/status?status=approved")).status).toBe(400);
  });

  it("one template; 404 for an unknown id", async () => {
    const id = firstTemplateId();
    expect(await (await req(`/avail/templates/${id}/status`)).json()).toMatchObject({ templateId: id, status: "raw" });
    expect((await req("/avail/templates/nope/status")).status).toBe(404);
  });
});

describe("PUT /avail/templates/:id/status", () => {
  it("anonymous and regular users are refused", async () => {
    const id = firstTemplateId();
    expect((await put(id, { status: "verified" })).status).toBe(403);
    expect((await put(id, { status: "verified" }, { Cookie: session("user") })).status).toBe(403);
    expect((await put(id, { status: "verified" }, { Authorization: "Bearer wrong-token-0123456789" })).status).toBe(403);
  });

  it("a moderator sets the status; lint level is recomputed, author recorded", async () => {
    const id = firstTemplateId();
    const res = await put(id, { status: "draft" }, { Cookie: session("moderator", "eng@avail-int.com") });
    expect(res.status).toBe(200);
    const row = api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as never;
    expect(await res.json()).toMatchObject({ templateId: id, status: "draft", updatedBy: "eng@avail-int.com", lintLevel: lintRow(row) });
    const list = (await (await req("/avail/templates/status?status=draft")).json()) as { templateId: string }[];
    expect(list.map((m) => m.templateId)).toEqual([id]);
  });

  it("an admin session and the ADMIN_TOKEN bearer can too", async () => {
    const id = firstTemplateId();
    expect(await (await put(id, { status: "verified" }, { Cookie: session("admin") })).json()).toMatchObject({
      status: "verified",
      updatedBy: "admin@avail.test",
    });
    expect(await (await put(id, { status: "hidden" }, { Authorization: `Bearer ${ADMIN_TOKEN}` })).json()).toMatchObject({
      status: "hidden",
      updatedBy: "admin-token",
    });
  });

  it("keeps source and upstream id of an imported template", async () => {
    const id = firstTemplateId();
    api.db.sqlite.prepare("UPDATE avail_template_meta SET source = 'easyschematic.live', upstream_id = 'up-1' WHERE template_id = ?").run(id);
    const meta = await (await put(id, { status: "raw" }, { Authorization: `Bearer ${ADMIN_TOKEN}` })).json();
    expect(meta).toMatchObject({ status: "raw", source: "easyschematic.live", upstreamId: "up-1" });
  });

  it("validates the body and the template", async () => {
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    expect((await put(firstTemplateId(), { status: "approved" }, auth)).status).toBe(400);
    expect((await put(firstTemplateId(), "{not json", auth)).status).toBe(400);
    expect((await put("nope", { status: "draft" }, auth)).status).toBe(404);
  });

  it("CORS: our routes sit behind the upstream credentialed CORS", async () => {
    const res = await req(`/avail/templates/${firstTemplateId()}/status`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PUT" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});
