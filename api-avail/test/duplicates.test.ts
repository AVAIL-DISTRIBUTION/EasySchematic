/**
 * Duplicate control on the API (step 2.4): the 409 guard on create / save / accepted proposal
 * (duplicateGuard.ts, through the app so CORS applies), variants allowed, POST /avail/templates/merge
 * with the audit log, the workspace's duplicate info, report:duplicates' files.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { duplicateGroups } from "../../src/avail/duplicates";
import { DUPLICATE_COLUMNS, duplicateRows } from "../../src/avail/duplicatesReport";
import { loadCandidates } from "../src/duplicates";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { readXlsx } from "../src/xlsx";
import { writeXlsx } from "../src/xlsxWrite";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const ORIGIN = "https://sch.avail.test";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-dup-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off", ALLOWED_ORIGINS: ORIGIN }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (method: string, p: string, body: unknown, headers: Record<string, string> = BEARER) =>
  req(p, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

function user(role: "contributor" | "moderator" | "admin", email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

const tpl = (id: string, label: string, modelNumber: string) => ({
  id, label, manufacturer: "Extron", modelNumber, deviceType: "hdbaset-extender", category: "AV distribution / Extenders",
  referenceUrl: "https://www.extron.com/product/x",
  ports: [{ id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" }],
});

function insert(t: Record<string, unknown>, status = "draft", catalog?: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite
    .prepare("INSERT INTO avail_template_meta (template_id, status, source, catalog) VALUES (?, ?, ?, ?)")
    .run(t.id, status, catalog ? "avail-catalog" : "easyschematic.live", catalog ? JSON.stringify(catalog) : null);
}

describe("409 on a duplicate", () => {
  it("create: same manufacturer + part number → 409 with a link; through the app, so CORS applies", async () => {
    insert(tpl("x", "Extron DTP3 T 203", "60-1885-52"));
    const res = await send("POST", "/templates", tpl("", "Extron DTP3 T 203 again", "60 1885 52"), { ...BEARER, Origin: ORIGIN });
    expect(res.status).toBe(409);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await json(res)).toMatchObject({ duplicateOf: { id: "x", label: "Extron DTP3 T 203" }, link: "/library?template=x" });
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM templates").get()).toEqual({ n: 1 });
  });

  it("a different variant, a hidden one, or another part number is allowed", async () => {
    insert(tpl("w", "Extron DTP3 T 203 White", "60-1885-53"));
    insert(tpl("h", "Extron Old", "60-1-1"), "hidden");
    expect((await send("POST", "/templates", tpl("", "Extron DTP3 T 203 Black", "60-1885-53"))).status).toBe(201);
    expect((await send("POST", "/templates", tpl("", "Extron New", "60-1-1"))).status).toBe(201);
    expect((await send("POST", "/templates", tpl("", "Extron Other", "60-9-9"))).status).toBe(201);
  });

  it("save: an unchanged part number passes (existing duplicates stay editable), a changed one is checked", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    expect((await send("PUT", "/templates/b", { ...tpl("b", "Extron B v2", "60-1") })).status).toBe(200);
    insert(tpl("c", "Extron C", "60-3"));
    const res = await send("PUT", "/templates/c", tpl("c", "Extron C", "60-1"));
    expect(res.status).toBe(409);
    expect((await json<{ duplicateOf: { id: string } }>(res)).duplicateOf.id).toMatch(/^[ab]$/);
  });

  it("an accepted proposal that would create a duplicate → 409", async () => {
    insert(tpl("x", "Extron DTP3 T 203", "60-1885-52"));
    const eng = user("contributor", "eng@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const sub = await json<{ id: string }>(send("POST", "/submissions", { action: "create", data: tpl("", "Extron DTP3 T 203 (copy)", "60-1885-99") }, { Cookie: eng.cookie }));
    // The librarian's edited data carries the duplicate part number.
    const res = await send("POST", `/submissions/${sub.id}/approve`, { data: tpl("", "Extron DTP3 T 203 (copy)", "60-1885-52") }, { Cookie: lib.cookie });
    expect(res.status).toBe(409);
    expect((await send("POST", `/submissions/${sub.id}/approve`, {}, { Cookie: lib.cookie })).status).toBe(200);
  });
});

describe("Merge into…", () => {
  it("the others become hidden 'duplicate of <primary>', with the audit log; again → unchanged", async () => {
    insert(tpl("p", "Extron TLS 300M", "60-5"));
    insert(tpl("d1", "Extron TLS 300M", "60-5"), "raw");
    insert(tpl("d2", "EXTRON TLS-300M", ""), "draft");
    const lib = user("moderator", "lib@avail.test");
    const eng = user("contributor", "eng@avail.test");
    expect((await send("POST", "/avail/templates/merge", { primary: "p", ids: ["d1"] }, { Cookie: eng.cookie })).status).toBe(403);
    const r = await json(send("POST", "/avail/templates/merge", { primary: "p", ids: ["d1", "d2", "p", "nope"] }, { Cookie: lib.cookie }));
    expect(r).toEqual({ primary: "p", updated: ["d1", "d2"], unchanged: [], failed: [{ id: "p", reason: "primary" }, { id: "nope", reason: "not_found" }] });
    expect(api.db.sqlite.prepare("SELECT status, status_reason FROM avail_template_meta WHERE template_id = 'd1'").get()).toEqual({ status: "hidden", status_reason: "duplicate of p" });
    const audit = api.db.sqlite.prepare("SELECT actor, entity_id, action, before, after FROM avail_audit_log WHERE entity_id = 'd2'").get() as Record<string, string>;
    expect(audit).toMatchObject({ actor: "lib@avail.test", action: "status", before: '{"status":"draft"}' });
    expect(JSON.parse(audit.after)).toEqual({ status: "hidden", reason: "duplicate of p", duplicateOf: "p", duplicateOfLabel: "Extron TLS 300M" });
    expect((await json(send("POST", "/avail/templates/merge", { primary: "p", ids: ["d1"] }, { Cookie: lib.cookie }))).unchanged).toEqual(["d1"]);
  });

  it("the workspace shows each template's group: primary and size; hidden ones drop out", async () => {
    insert(tpl("p", "Extron TLS 300M", "60-5"), "draft", { file: "extron/tls.json", portsSource: { kind: "datasheet" } });
    insert(tpl("d", "Extron TLS 300M", "60-5"), "raw");
    insert(tpl("solo", "Extron Solo", "60-6"));
    const ws = await json<{ templates: { id: string; avail: { duplicate: unknown } }[] }>(req("/avail/workspace/templates", { headers: BEARER }));
    const dup = (id: string) => ws.templates.find((t) => t.id === id)!.avail.duplicate;
    expect([dup("p"), dup("d"), dup("solo")]).toEqual([{ primary: "p", size: 2 }, { primary: "p", size: 2 }, null]);
  });
});

describe("report:duplicates", () => {
  it("groups from the database; the xlsx reads back", () => {
    insert(tpl("p", "Extron TLS 300M", "60-5"), "verified");
    insert(tpl("d", "Extron TLS 300M", ""), "raw");
    const g = duplicateGroups(loadCandidates(api.db.sqlite));
    expect(g.map((x) => [x.primary, x.members.length])).toEqual([["p", 2]]);
    const sheet = [...readXlsx(writeXlsx("Duplicates", [...DUPLICATE_COLUMNS], duplicateRows(g))).values()][0];
    expect(sheet[0][0]).toBe("Group");
    expect(sheet.slice(1).map((r) => [r[1], r[2]])).toEqual([["primary", "p"], ["duplicate", "d"]]);
  });
});
