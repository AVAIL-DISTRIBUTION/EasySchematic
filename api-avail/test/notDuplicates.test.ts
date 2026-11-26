/**
 * "Not duplicates" decisions (api-avail/src/notDuplicates.ts, migration 9009): marking pairs with a
 * comment (librarian / admin), the audit log, the workspace groups and details, the 409 guard,
 * report:duplicates, automatic removal when a template's manufacturer or part number changes, Undo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { duplicateGroups } from "../../src/avail/duplicates";
import { formatDuplicates } from "../../src/avail/duplicatesReport";
import { loadCandidates } from "../src/duplicates";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { dropStaleNotDuplicates, loadNotDuplicates } from "../src/notDuplicates";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const ORIGIN = "https://sch.avail.test";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-notdup-"));
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

type Audit = { actor: string; entity_id: string; action: string; before: string | null; after: string | null };
const audit = () => api.db.sqlite.prepare("SELECT actor, entity_id, action, before, after FROM avail_audit_log WHERE action = 'not-duplicate' ORDER BY id").all() as Audit[];
const pairs = () => api.db.sqlite.prepare("SELECT id_a, id_b, comment, created_by FROM avail_not_duplicates ORDER BY id_a, id_b").all();
type WsT = { id: string; avail: { duplicate: { primary: string; size: number } | null; notDuplicates: { id: string; label: string; comment: string; by: string }[] } };
const workspace = async () => (await json<{ templates: WsT[] }>(req("/avail/workspace/templates", { headers: BEARER }))).templates;

describe("Not duplicates", () => {
  it("librarian or admin only, a comment and 2+ templates required", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    const eng = user("contributor", "eng@avail.test");
    expect((await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b"], comment: "x" }, { Cookie: eng.cookie })).status).toBe(403);
    expect((await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b"], comment: "  " })).status).toBe(400);
    expect((await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "a"], comment: "x" })).status).toBe(400);
    expect((await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "nope"], comment: "x" })).status).toBe(404);
    expect(pairs()).toEqual([]);
  });

  it("marks every pair of the selection, logs both sides with the comment; again → unchanged", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    insert(tpl("c", "Extron C", "60-1"));
    const lib = user("moderator", "lib@avail.test");
    const r = await json(send("POST", "/avail/templates/not-duplicates", { ids: ["c", "a", "b"], comment: "Different housings, see data sheets" }, { Cookie: lib.cookie }));
    expect(r).toEqual({ pairs: [["a", "b"], ["a", "c"], ["b", "c"]], unchanged: [] });
    expect(pairs()).toHaveLength(3);
    const log = audit();
    expect(log).toHaveLength(6);
    expect(log[0]).toMatchObject({ actor: "lib@avail.test", entity_id: "a", before: null });
    expect(JSON.parse(log[0].after!)).toEqual({ notDuplicateOf: "b", notDuplicateOfLabel: "Extron B", comment: "Different housings, see data sheets" });
    expect(log[1].entity_id).toBe("b");
    expect(await json(send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b"], comment: "again" }, { Cookie: lib.cookie }))).toEqual({ pairs: [], unchanged: [["a", "b"]] });
  });

  it("a marked pair is no longer a duplicate: workspace group, details, report", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    insert(tpl("c", "Extron C", "60-1"));
    insert(tpl("x", "Extron X", "60-7"));
    insert(tpl("y", "Extron Y", "60-7"));
    await send("POST", "/avail/templates/not-duplicates", { ids: ["x", "y"], comment: "PoE and non-PoE models" });
    // Only a–b decided: c still duplicates both, so the group of three stays.
    await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b"], comment: "AV and IP versions" });
    const ws = await workspace();
    const get = (id: string) => ws.find((t) => t.id === id)!.avail;
    expect([get("x").duplicate, get("y").duplicate]).toEqual([null, null]);
    expect(get("a").duplicate).toMatchObject({ size: 3 });
    expect(get("x").notDuplicates).toEqual([{ id: "y", label: "Extron Y", comment: "PoE and non-PoE models", by: "admin-token", at: expect.any(String) }]);
    expect(get("c").notDuplicates).toEqual([]);
    const groups = duplicateGroups(loadCandidates(api.db.sqlite), loadNotDuplicates(api.db.sqlite));
    expect(groups.map((g) => g.members.map((m) => m.id).sort())).toEqual([["a", "b", "c"]]);
    expect(formatDuplicates(groups, { source: "x", date: "2026-11-26", total: 5, notDuplicates: 2 })).toContain('Pairs marked "not duplicates" by a librarian, left out: 2.');
  });

  it("the 409 guard skips a marked pair", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-2"));
    insert(tpl("c", "Extron C", "60-1"));
    // c takes a's part number in another spelling: the guard checks it and refuses while a and c are duplicates.
    expect((await send("PUT", "/templates/c", tpl("c", "Extron C", "60 1"))).status).toBe(409);
    await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "c"], comment: "Different products, same catalogue number" });
    expect((await send("PUT", "/templates/c", tpl("c", "Extron C", "60 1"))).status).toBe(200);
    // The same part number in another spelling is not a change: the decision stays.
    expect(pairs()).toHaveLength(1);
    expect((await send("PUT", "/templates/b", tpl("b", "Extron B", "60-1"))).status).toBe(409);
  });

  it("a changed manufacturer or part number drops the pair's decision, logged by system", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    insert(tpl("c", "Extron C", "60-1"));
    await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b", "c"], comment: "three products" });
    // A label edit keeps the decisions.
    expect((await send("PUT", "/templates/a", tpl("a", "Extron A v2", "60-1"))).status).toBe(200);
    expect(pairs()).toHaveLength(3);
    expect((await send("PUT", "/templates/b", tpl("b", "Extron B", "60-9"))).status).toBe(200);
    expect(pairs()).toEqual([{ id_a: "a", id_b: "c", comment: "three products", created_by: "admin-token" }]);
    const removed = audit().filter((e) => e.actor === "system");
    expect(removed.map((e) => e.entity_id).sort()).toEqual(["a", "b", "b", "c"]);
    expect(JSON.parse(removed[0].after!)).toMatchObject({ removed: "b changed its manufacturer or model number", changes: { b: { modelNumber: ["60-1", "60-9"] } } });
    expect(JSON.parse(removed[0].before!)).toMatchObject({ comment: "three products" });
    // A deleted template's decisions go too (no log entry for the template that is gone).
    api.db.sqlite.prepare("DELETE FROM templates WHERE id = 'c'").run();
    expect(dropStaleNotDuplicates(api.db.sqlite)).toEqual([["a", "c"]]);
    expect(pairs()).toEqual([]);
    expect(audit().filter((e) => e.actor === "system").map((e) => e.entity_id).slice(-1)).toEqual(["a"]);
  });

  it("Undo removes the decision with a log entry; the pair is a duplicate again", async () => {
    insert(tpl("a", "Extron A", "60-1"));
    insert(tpl("b", "Extron B", "60-1"));
    const lib = user("moderator", "lib@avail.test");
    await send("POST", "/avail/templates/not-duplicates", { ids: ["a", "b"], comment: "different" }, { Cookie: lib.cookie });
    expect((await workspace()).find((t) => t.id === "a")!.avail.duplicate).toBeNull();
    expect(await json(send("POST", "/avail/templates/not-duplicates/undo", { a: "b", b: "a" }, { Cookie: lib.cookie }))).toEqual({ removed: ["a", "b"] });
    expect(pairs()).toEqual([]);
    const last = audit().slice(-2);
    expect(last.map((e) => [e.actor, e.entity_id, JSON.parse(e.after!)])).toEqual([
      ["lib@avail.test", "a", { removed: "undone" }],
      ["lib@avail.test", "b", { removed: "undone" }],
    ]);
    expect(JSON.parse(last[0].before!)).toMatchObject({ notDuplicateOf: "b", comment: "different", by: "lib@avail.test" });
    expect((await workspace()).find((t) => t.id === "a")!.avail.duplicate).toMatchObject({ size: 2 });
    expect((await send("POST", "/avail/templates/not-duplicates/undo", { a: "a", b: "b" }, { Cookie: lib.cookie })).status).toBe(404);
  });
});
