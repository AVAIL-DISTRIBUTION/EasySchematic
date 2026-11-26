/**
 * Library workspace routes (step 2.2): workspace.ts (GET /avail/workspace/templates, POST
 * /avail/templates/category/batch), approved_by (migration 9008), the audit entry of a decided
 * proposal (requestAudit.ts readProposalDecision).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-workspace-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

function user(role: "contributor" | "moderator" | "admin", email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

/** A level-A template. */
function tpl(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: `60-${id}`,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
    ],
    ...over,
  };
}

function insert(t: Record<string, unknown>, catalog?: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite
    .prepare("INSERT INTO avail_template_meta (template_id, status, source, lint_level, catalog) VALUES (?, 'draft', ?, 'A', ?)")
    .run(t.id, catalog ? "avail-catalog" : null, catalog ? JSON.stringify(catalog) : null);
}

const post = (p: string, body: unknown, cookie: string) =>
  req(p, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

interface WsTemplate { id: string; category: string; avail: Record<string, unknown> }

describe("GET /avail/workspace/templates", () => {
  it("is for librarians and admins", async () => {
    const eng = user("contributor", "eng@avail.test");
    expect((await req("/avail/workspace/templates", { headers: { Cookie: eng.cookie } })).status).toBe(403);
    expect((await req("/avail/workspace/templates")).status).toBe(403);
  });

  it("returns every status with level, ports source, data sheet, approver and editors", async () => {
    const lib = user("moderator", "lib@avail.test");
    insert(tpl("a"), { file: "extron/a.json", portsSource: { kind: "datasheet", from: "https://x/a.pdf" } });
    insert(tpl("b", { label: "Extron B" }));
    api.db.sqlite.prepare("UPDATE avail_template_meta SET status = 'hidden' WHERE template_id = 'b'").run();
    const res = await post("/avail/templates/status/batch", { ids: ["a"], status: "verified" }, lib.cookie);
    expect((await json(res)).updated).toEqual(["a"]);

    const ws = await req("/avail/workspace/templates", { headers: { Cookie: lib.cookie } });
    expect(ws.status).toBe(200);
    const { templates } = await json<{ templates: WsTemplate[] }>(ws);
    const a = templates.find((t) => t.id === "a")!;
    expect(a.avail).toMatchObject({
      status: "verified", level: "A", approvedBy: "lib@avail.test", approvedVia: "bulk", portsOrigin: "manufacturer",
      portsSource: "datasheet", portsFrom: "https://x/a.pdf", datasheetUrl: "https://x/a.pdf", editors: ["lib@avail.test"], lastActor: "lib@avail.test",
    });
    expect(templates.find((t) => t.id === "b")!.avail).toMatchObject({ status: "hidden", portsOrigin: "none", editors: [] });
    // Unchanged library and log: 304 on the ETag.
    const again = await req("/avail/workspace/templates", { headers: { Cookie: lib.cookie, "If-None-Match": ws.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });
});

describe("POST /avail/templates/category/batch", () => {
  it("changes the category, logs each change, reports unchanged and missing", async () => {
    const lib = user("moderator", "lib@avail.test");
    insert(tpl("a"));
    insert(tpl("b", { category: "AV distribution / Switchers" }));
    const res = await post("/avail/templates/category/batch", { ids: ["a", "b", "zz"], category: "AV distribution / Switchers" }, lib.cookie);
    expect(await json(res)).toEqual({ category: "AV distribution / Switchers", updated: ["a"], unchanged: ["b"], failed: [{ id: "zz", reason: "not_found" }] });
    const row = api.db.sqlite.prepare("SELECT category, version FROM templates WHERE id = 'a'").get() as { category: string; version: number };
    expect(row).toEqual({ category: "AV distribution / Switchers", version: 2 });
    const log = api.db.sqlite.prepare("SELECT actor, action, before, after FROM avail_audit_log WHERE entity_id = 'a'").all();
    expect(log).toEqual([
      { actor: "lib@avail.test", action: "updated", before: '{"category":"AV distribution / Extenders"}', after: '{"category":"AV distribution / Switchers"}' },
    ]);
    // Re-linted after the write.
    expect((api.db.sqlite.prepare("SELECT linted_version FROM avail_template_meta WHERE template_id = 'a'").get() as { linted_version: number }).linted_version).toBe(2);
  });

  it("refuses a non-leaf category, bad ids and engineers", async () => {
    const lib = user("moderator", "lib@avail.test");
    const eng = user("contributor", "eng@avail.test");
    expect((await post("/avail/templates/category/batch", { ids: ["a"], category: "AV distribution" }, lib.cookie)).status).toBe(400);
    expect((await post("/avail/templates/category/batch", { ids: [], category: "AV distribution / Switchers" }, lib.cookie)).status).toBe(400);
    expect((await post("/avail/templates/category/batch", { ids: ["a"], category: "AV distribution / Switchers" }, eng.cookie)).status).toBe(403);
  });
});

describe("proposals (upstream submissions)", () => {
  it("an engineer proposes, a librarian accepts or rejects; the decision goes to the audit log", async () => {
    const eng = user("contributor", "eng@avail.test");
    const lib = user("moderator", "lib@avail.test");
    insert(tpl("a"));
    insert(tpl("b", { label: "Extron B" }));
    const propose = async (id: string, data: Record<string, unknown>) =>
      json<{ id: string }>(post("/submissions", { action: "update", templateId: id, data, submitterNote: "power from the data sheet" }, eng.cookie));
    const s1 = await propose("a", tpl("a", { powerDrawW: 7 }));
    const s2 = await propose("b", tpl("b", { label: "Extron B", powerDrawW: 9 }));

    const pending = await json<{ id: string }[]>(req("/submissions/pending", { headers: { Cookie: lib.cookie } }));
    expect(pending.map((p) => p.id).sort()).toEqual([s1.id, s2.id].sort());

    expect((await post(`/submissions/${s1.id}/approve`, {}, lib.cookie)).status).toBe(200);
    expect((await post(`/submissions/${s2.id}/reject`, { note: "the data sheet says 6 W" }, lib.cookie)).status).toBe(200);

    expect((api.db.sqlite.prepare("SELECT power_draw_w FROM templates WHERE id = 'a'").get() as { power_draw_w: number }).power_draw_w).toBe(7);
    const decisions = api.db.sqlite.prepare("SELECT entity_id, actor, after FROM avail_audit_log WHERE action = 'proposal' ORDER BY id").all() as { entity_id: string; actor: string; after: string }[];
    expect(decisions.map((d) => [d.entity_id, d.actor, JSON.parse(d.after)])).toEqual([
      ["a", "lib@avail.test", { submissionId: s1.id, decision: "accepted", submitter: "eng@avail.test" }],
      ["b", "lib@avail.test", { submissionId: s2.id, decision: "rejected", note: "the data sheet says 6 W", submitter: "eng@avail.test" }],
    ]);
    // The accepted edit itself is logged as a template update by the request audit.
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM avail_audit_log WHERE entity_id = 'a' AND action = 'updated'").get()).toEqual({ n: 1 });
  });
});
