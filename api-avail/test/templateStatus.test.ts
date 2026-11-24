/**
 * Template status (avail_template_meta, migrations 9001–9002), lint levels kept current
 * on every save, the /avail/templates/…/status routes and the status-filtered library
 * behind GET /templates.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { libraryStatuses } from "../src/routes";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { syncLintLevels } from "../src/templateMeta";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
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
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

function session(role: "user" | "moderator" | "admin", email = `${role}-${crypto.randomUUID()}@avail.test`): string {
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

/** A template that passes every rule of the standard (level A). */
function cleanTemplate(id: string) {
  return {
    id,
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: `60-1885-${id.length}`,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12 VDC",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "DTP3 Out", signalType: "hdbaset", direction: "output", section: "Video Outputs", connectorType: "rj45" },
      { id: "3", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
    ],
  };
}

function insertTemplate(t: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}

const meta = (id: string) =>
  api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;
const firstSeededId = () => (api.db.sqlite.prepare("SELECT id FROM templates ORDER BY sort_order LIMIT 1").get() as { id: string }).id;

describe("avail_template_meta", () => {
  it("is created by our migrations, upstream tables untouched", () => {
    const cols = (api.db.sqlite.prepare("PRAGMA table_info(avail_template_meta)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "template_id", "status", "source", "upstream_id", "lint_level", "updated_by", "updated_at", "linted_version",
      "status_reason", "status_changed_at", "source_hash",
    ]);
    const templateCols = (api.db.sqlite.prepare("PRAGMA table_info(templates)").all() as { name: string }[]).map((c) => c.name);
    expect(templateCols.some((c) => c.includes("status") || c.includes("avail") || c.includes("lint"))).toBe(false);
  });

  it("at startup every template gets a meta row: raw with its lint level", () => {
    const { n, missing } = api.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS n, SUM(m.template_id IS NULL OR m.lint_level IS NULL OR m.linted_version <> t.version) AS missing
           FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id`,
      )
      .get() as { n: number; missing: number };
    expect(n).toBe(api.seed.seeded);
    expect(missing).toBe(0);
    expect(meta(firstSeededId())).toMatchObject({ status: "raw", updated_by: "lint" });
  });

  it("rejects unknown statuses and goes away with its template", () => {
    const db = api.db.sqlite;
    expect(() => db.prepare("UPDATE avail_template_meta SET status = 'approved' WHERE template_id = ?").run(firstSeededId())).toThrow(/CHECK/);
    db.prepare("INSERT INTO templates (id, device_type, label, ports) VALUES ('tmp-del', 'switcher', 'Tmp', '[]')").run();
    db.prepare("INSERT INTO avail_template_meta (template_id, status) VALUES ('tmp-del', 'draft')").run();
    db.prepare("DELETE FROM templates WHERE id = 'tmp-del'").run();
    expect(meta("tmp-del")).toBeUndefined();
  });
});

describe("lint_level follows every save", () => {
  it("upstream PUT /templates/:id re-lints the template", async () => {
    insertTemplate(cleanTemplate("relint-1"));
    await put("relint-1", { status: "draft" }, BEARER); // creates the meta row with the current lint
    expect(meta("relint-1")).toMatchObject({ lint_level: "A", linted_version: 1 });

    const { id: _id, ...body } = cleanTemplate("relint-1");
    const res = await req("/templates/relint-1", {
      method: "PUT",
      headers: { ...BEARER, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, category: "Audio" }),
    });
    expect(res.status).toBe(200);
    expect(meta("relint-1")).toMatchObject({ lint_level: "FIX", linted_version: 2, status: "draft" });
  });

  it("a verified template that falls below level A on save becomes draft, with reason and time", async () => {
    insertTemplate(cleanTemplate("stale-v"));
    expect((await put("stale-v", { status: "verified" }, BEARER)).status).toBe(200);
    expect(meta("stale-v")).toMatchObject({ status: "verified", status_reason: null });
    const etagBefore = (await req("/templates")).headers.get("ETag");

    const { id: _id, ...body } = cleanTemplate("stale-v");
    const res = await req("/templates/stale-v", {
      method: "PUT",
      headers: { ...BEARER, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, searchTerms: [] }), // W "no searchTerms": level B
    });
    expect(res.status).toBe(200);
    const m = meta("stale-v")!;
    expect(m).toMatchObject({ status: "draft", lint_level: "B", linted_version: 2, updated_by: "lint" });
    expect(m.status_reason).toBe("Standard level B after save (version 2); verified needs level A");
    expect(m.status_changed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The status change rolls the library ETag; the API reports the reason.
    expect((await req("/templates")).headers.get("ETag")).not.toBe(etagBefore);
    expect(await json(req("/avail/templates/stale-v/status"))).toMatchObject({
      status: "draft",
      statusReason: "Standard level B after save (version 2); verified needs level A",
      statusChangedAt: m.status_changed_at,
    });

    // A person setting the status again clears the automatic reason.
    expect(await json(put("stale-v", { status: "hidden" }, BEARER))).toMatchObject({ status: "hidden", statusReason: null });
  });

  it("a verified template still at level A after save stays verified", async () => {
    insertTemplate(cleanTemplate("still-a"));
    await put("still-a", { status: "verified" }, BEARER);
    const { id: _id, ...body } = cleanTemplate("still-a");
    await req("/templates/still-a", {
      method: "PUT",
      headers: { ...BEARER, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, searchTerms: ["changed"] }),
    });
    expect(meta("still-a")).toMatchObject({ status: "verified", lint_level: "A", linted_version: 2, status_reason: null });
  });

  it("draft and raw templates keep their status whatever the level", () => {
    insertTemplate({ ...cleanTemplate("raw-fix"), category: "Audio" });
    expect(syncLintLevels(api.db.sqlite).demoted).toEqual([]);
    expect(meta("raw-fix")).toMatchObject({ status: "raw", lint_level: "FIX" });
  });

  it("upstream POST /templates: the new template is raw with its lint level", async () => {
    const { id: _id, ...body } = cleanTemplate("x");
    const res = await req("/templates", {
      method: "POST",
      headers: { ...BEARER, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, modelNumber: "NEW-1" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(meta(id)).toMatchObject({ status: "raw", lint_level: "A" });
  });
});

describe("GET /avail/templates/status", () => {
  it("lists every library template with status and lint level", async () => {
    const list = await json<{ templateId: string; status: string; lintLevel: string }[]>(req("/avail/templates/status"));
    expect(list.length).toBeGreaterThanOrEqual(api.seed.seeded);
    expect(list.find((m) => m.templateId === firstSeededId())).toMatchObject({ status: "raw", lintLevel: expect.stringMatching(/^(A|B|FIX)$/) });
  });

  it("filters by status and rejects unknown ones", async () => {
    expect((await req("/avail/templates/status?status=approved")).status).toBe(400);
    const raw = await json<unknown[]>(req("/avail/templates/status?status=raw"));
    expect(raw.length).toBeGreaterThan(0);
  });

  it("one template; 404 for an unknown id", async () => {
    expect(await json(req(`/avail/templates/${firstSeededId()}/status`))).toMatchObject({ status: "raw" });
    expect((await req("/avail/templates/nope/status")).status).toBe(404);
  });
});

describe("PUT /avail/templates/:id/status", () => {
  it("anonymous and regular users are refused", async () => {
    const id = firstSeededId();
    expect((await put(id, { status: "draft" })).status).toBe(403);
    expect((await put(id, { status: "draft" }, { Cookie: session("user") })).status).toBe(403);
    expect((await put(id, { status: "draft" }, { Authorization: "Bearer wrong-token-0123456789" })).status).toBe(403);
  });

  it("a moderator sets draft; author recorded", async () => {
    const id = firstSeededId();
    const res = await put(id, { status: "draft" }, { Cookie: session("moderator", "eng@avail-int.com") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ templateId: id, status: "draft", updatedBy: "eng@avail-int.com" });
  });

  it("verified only at level A: otherwise 400 with the errors and warnings", async () => {
    const id = firstSeededId();
    const res = await put(id, { status: "verified" }, BEARER);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { level: string; errors: string[]; warnings: string[] };
    expect(body.level).not.toBe("A");
    expect(body.errors.length + body.warnings.length).toBeGreaterThan(0);
    expect(meta(id)).toMatchObject({ status: "draft" });

    insertTemplate(cleanTemplate("level-a"));
    expect(await json(put("level-a", { status: "verified" }, { Cookie: session("admin", "boss@avail-int.com") }))).toMatchObject({
      status: "verified",
      lintLevel: "A",
      updatedBy: "boss@avail-int.com",
    });
  });

  it("hidden by the ADMIN_TOKEN bearer; keeps source and upstream id", async () => {
    insertTemplate({ ...cleanTemplate("imported"), modelNumber: "IMP-1" });
    await put("imported", { status: "raw" }, BEARER);
    api.db.sqlite.prepare("UPDATE avail_template_meta SET source = 'easyschematic.live', upstream_id = 'up-1' WHERE template_id = 'imported'").run();
    expect(await json(put("imported", { status: "hidden" }, BEARER))).toMatchObject({
      status: "hidden",
      updatedBy: "admin-token",
      source: "easyschematic.live",
      upstreamId: "up-1",
    });
  });

  it("validates the body and the template", async () => {
    expect((await put(firstSeededId(), { status: "approved" }, BEARER)).status).toBe(400);
    expect((await put(firstSeededId(), "{not json", BEARER)).status).toBe(400);
    expect((await put("nope", { status: "draft" }, BEARER)).status).toBe(404);
  });

  it("CORS: our routes sit behind the upstream credentialed CORS", async () => {
    const res = await req(`/avail/templates/${firstSeededId()}/status`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PUT" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});

describe("GET /templates — filtered by status", () => {
  const ids = async (query = "", headers: Record<string, string> = {}) =>
    (await json<{ id: string; availStatus: string }[]>(req(`/templates${query}`, { headers }))).map((t) => `${t.id}:${t.availStatus}`);

  beforeAll(async () => {
    for (const [id, status] of [["f-verified", "verified"], ["f-draft", "draft"], ["f-raw", "raw"], ["f-hidden", "hidden"]] as const) {
      insertTemplate({ ...cleanTemplate(id), modelNumber: `F-${id}` });
      expect((await put(id, { status }, BEARER)).status).toBe(200);
    }
  });

  it("by default: verified and draft", async () => {
    const list = await ids();
    expect(list).toEqual(expect.arrayContaining(["f-verified:verified", "f-draft:draft"]));
    expect(list.some((x) => x.endsWith(":raw") || x.endsWith(":hidden"))).toBe(false);
  });

  it("include=raw adds raw, never hidden", async () => {
    const list = await ids("?include=raw");
    expect(list).toEqual(expect.arrayContaining(["f-verified:verified", "f-draft:draft", "f-raw:raw"]));
    expect(list).not.toContain("f-hidden:hidden");
  });

  it("include=hidden: moderators and admins only", async () => {
    expect((await req("/templates?include=hidden")).status).toBe(403);
    expect((await req("/templates?include=hidden", { headers: { Cookie: session("user") } })).status).toBe(403);
    expect(await ids("?include=raw,hidden", { Cookie: session("moderator") })).toEqual(
      expect.arrayContaining(["f-raw:raw", "f-hidden:hidden"]),
    );
    expect(await ids("?include=hidden", BEARER)).toContain("f-hidden:hidden");
    expect((await req("/templates?include=everything")).status).toBe(400);
  });

  it("tells the editor it is an AVAIL library; a status change rolls the ETag", async () => {
    const res = await req("/templates");
    expect(res.headers.get("x-avail-library")).toBe("1");
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Avail-Library");
    const etag = res.headers.get("etag")!;
    expect((await req("/templates", { headers: { "If-None-Match": etag } })).status).toBe(304);
    await put("f-raw", { status: "draft" }, BEARER);
    const after = await req("/templates", { headers: { "If-None-Match": etag } });
    expect(after.status).toBe(200);
    expect((await after.json() as { id: string }[]).map((t) => t.id)).toContain("f-raw");
  });

  it("GET /templates/:id still serves any template (schematics reference raw ones)", async () => {
    expect((await req("/templates/f-hidden")).status).toBe(200);
  });

  it("libraryStatuses", () => {
    expect(libraryStatuses(undefined, false)).toEqual({ statuses: ["verified", "draft"] });
    expect(libraryStatuses("raw, raw", false)).toEqual({ statuses: ["verified", "draft", "raw"] });
    expect(libraryStatuses("hidden", false)).toMatchObject({ status: 403 });
    expect(libraryStatuses("raw,hidden", true)).toEqual({ statuses: ["verified", "draft", "raw", "hidden"] });
    expect(libraryStatuses("nope", true)).toMatchObject({ status: 400 });
  });
});

describe("POST /avail/templates/status/batch", () => {
  const batch = (body: unknown, headers: Record<string, string> = {}) =>
    req("/avail/templates/status/batch", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("moderators and admins only", async () => {
    expect((await batch({ ids: ["x"], status: "verified" })).status).toBe(403);
    expect((await batch({ ids: ["x"], status: "verified" }, { Cookie: session("user") })).status).toBe(403);
  });

  it("validates status and ids", async () => {
    const mod = { Cookie: session("moderator") };
    expect((await batch({ ids: ["x"], status: "approved" }, mod)).status).toBe(400);
    expect((await batch({ ids: [], status: "verified" }, mod)).status).toBe(400);
    expect((await batch({ ids: [1], status: "verified" }, mod)).status).toBe(400);
    expect((await batch({ ids: Array.from({ length: 501 }, (_, i) => `t${i}`), status: "verified" }, mod)).status).toBe(400);
  });

  it("approves the level-A templates and returns the others with reasons", async () => {
    insertTemplate(cleanTemplate("bulk-a1"));
    insertTemplate({ ...cleanTemplate("bulk-a2"), modelNumber: "60-1885-99" });
    insertTemplate({ ...cleanTemplate("bulk-b"), searchTerms: [] });
    const res = await batch({ ids: ["bulk-a1", "bulk-b", "bulk-a2", "nope", "bulk-a1"], status: "verified" }, { Cookie: session("moderator", "lead@avail-int.com") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; failed: { id: string; reason: string; level?: string; warnings?: string[]; label: string | null }[] };
    expect(body.updated).toEqual(["bulk-a1", "bulk-a2"]);
    expect(body.failed).toEqual([
      { id: "bulk-b", label: "Extron DTP3 T 203", reason: "not_level_a", level: "B", errors: [], warnings: ["no searchTerms"] },
      { id: "nope", label: null, reason: "not_found" },
    ]);
    expect(meta("bulk-a1")).toMatchObject({ status: "verified", updated_by: "lead@avail-int.com" });
    expect(meta("bulk-b")?.status ?? "raw").not.toBe("verified");
  });
});
