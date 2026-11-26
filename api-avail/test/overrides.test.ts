/**
 * Overrides (step 2.7; src/overrides.ts, src/avail/overrides.ts, migration 9011): an accepted proposal
 * records what it changed; import:catalog keeps those values over a changed catalog file and reports
 * the difference; the details panel lists them and removes one; normalize:library keeps them;
 * export:overrides writes the overrides in force (accepted proposals and port decisions).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import type { Override } from "../../src/avail/overrides";
import type { CatalogFileText } from "../src/catalogFiles";
import { formatImportCatalogReport, importCatalog } from "../src/importCatalog";
import { normalizeLibrary } from "../src/normalizeLibrary";
import { exportOverrides, overridesInForce } from "../src/overrides";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const ID = "avail-extron-60-1885-52";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-overrides-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off" }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (method: string, p: string, body: unknown, headers: Record<string, string> = BEARER) =>
  req(p, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

function user(role: "contributor" | "moderator" | "admin" | "assistant", email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

/** A level-A catalog card. */
function card(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: "60-1885-52",
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["60-1885-52"],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC",
    rackForm: "half",
    _avail: { status: "ports-filled", portsSource: { kind: "db", from: "x" } },
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "phoenix" },
    ],
    ...over,
  };
}

function file(t: Record<string, unknown>): CatalogFileText {
  const text = JSON.stringify(t, null, 2);
  return { file: "extron/extron-dtp3-t-203.json", text, template: JSON.parse(text) };
}

const stored = () => rowToTemplate(api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(ID) as TemplateRow) as unknown as Record<string, unknown> & { ports: Record<string, unknown>[] };
const rows = () => api.db.sqlite.prepare("SELECT kind, field, port, op, value, base, source, comment, accepted_by, removed_at FROM avail_overrides ORDER BY id").all() as Record<string, unknown>[];

/** An engineer proposes powerDrawW 7 and HDCP notes on HDMI In; a librarian accepts. */
async function acceptProposal(): Promise<{ submission: string; librarian: { cookie: string } }> {
  const eng = user("contributor", "eng@avail.test");
  const lib = user("moderator", "lib@avail.test");
  const { id: _id, _avail, rackForm: _r, ...data } = card();
  const proposed = {
    ...data,
    powerDrawW: 7,
    ports: [{ ...data.ports[0], notes: "HDCP 2.3" }, data.ports[1]],
  };
  const sub = await json<{ id: string }>(
    send("POST", "/submissions", { action: "update", templateId: ID, data: proposed, submitterNote: "Data sheet p. 3: https://www.extron.com/dtp3t203.pdf", source: "manual" }, { Cookie: eng.cookie }),
  );
  const res = await send("POST", `/submissions/${sub.id}/approve`, { note: "checked" }, { Cookie: lib.cookie });
  expect(res.status).toBeLessThan(300);
  return { submission: sub.id, librarian: lib };
}

describe("overrides from an accepted proposal", () => {
  it("Accept records each changed field and port with the source, the comment and who accepted; logged", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    const { submission } = await acceptProposal();
    const source = `proposal ${submission} by eng@avail.test`;
    expect(rows()).toEqual([
      { kind: "field", field: "powerDrawW", port: null, op: null, value: "7", base: "6", source, comment: "Data sheet p. 3: https://www.extron.com/dtp3t203.pdf — Review note: checked", accepted_by: "lib@avail.test", removed_at: null },
      { kind: "port", field: null, port: "HDMI In", op: "set", value: '{"notes":"HDCP 2.3"}', base: '{"notes":null}', source, comment: expect.any(String), accepted_by: "lib@avail.test", removed_at: null },
    ]);
    const log = api.db.sqlite.prepare("SELECT actor, entity_id, after FROM avail_audit_log WHERE action = 'override'").all() as { actor: string; entity_id: string; after: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "lib@avail.test", entity_id: ID });
    expect(JSON.parse(log[0].after)).toMatchObject({ added: ["powerDrawW = 7", 'port "HDMI In": notes = "HDCP 2.3"'], source });
  });

  it("a rejected proposal records nothing", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    const eng = user("contributor", "eng@avail.test");
    const { id: _id, _avail, rackForm: _r, ...data } = card();
    const sub = await json<{ id: string }>(send("POST", "/submissions", { action: "update", templateId: ID, data: { ...data, powerDrawW: 9 }, submitterNote: "x", source: "manual" }, { Cookie: eng.cookie }));
    expect((await send("POST", `/submissions/${sub.id}/reject`, { note: "no" })).status).toBeLessThan(300);
    expect(rows()).toEqual([]);
  });

  it("proposal → catalog file changes the same field → import:catalog: the value stays, the difference is in the report", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    const { submission } = await acceptProposal();
    expect(stored().powerDrawW).toBe(7);

    // The catalog file changes the overridden field (8), an overridden port's notes stay, and another field (heightMm).
    const changed = card({ powerDrawW: 8, heightMm: 26 });
    const r = importCatalog(api.db.sqlite, [file(changed)]);
    expect(r.rows[0]).toMatchObject({ action: "updated", id: ID });
    const t = stored();
    expect(t.powerDrawW).toBe(7);
    expect(t.heightMm).toBe(26);
    expect(t.ports[0].notes).toBe("HDCP 2.3");
    expect(r.overridden).toEqual([{ file: "extron/extron-dtp3-t-203.json", id: ID, label: "Extron DTP3 T 203", applied: 2 }]);
    expect(r.conflicts).toEqual([
      { file: "extron/extron-dtp3-t-203.json", id: ID, label: "Extron DTP3 T 203", text: `catalog changed a field overridden by proposal ${submission} by eng@avail.test: powerDrawW — catalog 8, kept 7` },
    ]);
    expect(formatImportCatalogReport(r, "library/catalog")).toContain(`catalog changed a field overridden by proposal ${submission}`);

    // Same file again: nothing to do, nothing to report.
    const again = importCatalog(api.db.sqlite, [file(changed)]);
    expect(again.rows[0].action).toBe("unchanged");
    expect(again.conflicts).toEqual([]);
  });

  it("a catalog file that still has the value from before the proposal is no conflict", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    await acceptProposal();
    const r = importCatalog(api.db.sqlite, [file(card({ heightMm: 27 }))]);
    expect(r.conflicts).toEqual([]);
    expect(stored()).toMatchObject({ powerDrawW: 7, heightMm: 27 });
  });

  it("details panel: list (librarian, admin, AI Assistant), Remove override (librarian, admin) — then the catalog's value wins", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    const { librarian } = await acceptProposal();
    const eng = user("contributor", "eng2@avail.test");
    const ai = user("assistant", "ai@avail.test");
    expect((await req(`/avail/templates/${ID}/overrides`, { headers: { Cookie: eng.cookie } })).status).toBe(403);
    const list = (await json<{ overrides: { key: string; text: string; source: string; comment: string; acceptedBy: string; fromFile: boolean }[] }>(req(`/avail/templates/${ID}/overrides`, { headers: { Cookie: ai.cookie } }))).overrides;
    expect(list.map((o) => o.text)).toEqual(["powerDrawW = 7", 'port "HDMI In": notes = "HDCP 2.3"']);
    expect(list[0]).toMatchObject({ acceptedBy: "lib@avail.test", fromFile: false, comment: expect.stringContaining("https://www.extron.com/dtp3t203.pdf") });

    expect((await send("POST", `/avail/templates/${ID}/overrides/remove`, { key: list[0].key }, { Cookie: ai.cookie })).status).toBe(403);
    expect((await send("POST", `/avail/templates/${ID}/overrides/remove`, { key: "db:999" }, { Cookie: librarian.cookie })).status).toBe(404);
    expect((await send("POST", `/avail/templates/${ID}/overrides/remove`, { key: list[0].key }, { Cookie: librarian.cookie })).status).toBe(200);
    expect(stored().powerDrawW).toBe(7); // the template keeps its value
    const log = api.db.sqlite.prepare("SELECT actor, before, after FROM avail_audit_log WHERE action = 'override' ORDER BY id DESC LIMIT 1").get() as { actor: string; before: string; after: string };
    expect(log.actor).toBe("lib@avail.test");
    expect(JSON.parse(log.before)).toMatchObject({ override: "powerDrawW = 7" });
    expect(JSON.parse(log.after)).toEqual({ removed: true });

    const r = importCatalog(api.db.sqlite, [file(card({ powerDrawW: 9 }))]);
    expect(r.conflicts).toEqual([]);
    expect(stored().powerDrawW).toBe(9);
    expect(stored().ports[0].notes).toBe("HDCP 2.3");
  });

  it("a second proposal on the same port merges into one override", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    await acceptProposal();
    const eng = user("contributor", "eng3@avail.test");
    const t = stored();
    const { id: _id, version: _v, ...data } = t;
    const sub = await json<{ id: string }>(
      send("POST", "/submissions", { action: "update", templateId: ID, data: { ...data, ports: [{ ...t.ports[0], connectorType: "hdmi-a" }, t.ports[1]] }, submitterNote: "panel photo", source: "manual" }, { Cookie: eng.cookie }),
    );
    expect((await send("POST", `/submissions/${sub.id}/approve`, {})).status).toBeLessThan(300);
    const active = overridesInForce(api.db.sqlite, []).filter((o) => o.kind === "port");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ port: "HDMI In", value: { notes: "HDCP 2.3", connectorType: "hdmi-a" }, base: { notes: null, connectorType: "hdmi" } });
  });

  it("normalize:library keeps an override the normalizer would change", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    // A librarian decided the port label in caps (unusual, but decided).
    api.db.sqlite
      .prepare(`INSERT INTO avail_overrides (template_id, manufacturer, model_number, label, kind, port, op, value, source, comment, accepted_by)
                VALUES (?, 'Extron', '60-1885-52', 'Extron DTP3 T 203', 'port', 'HDMI In', 'set', '{"label":"HDMI IN"}', 'proposal p1', 'as printed on the panel', 'lib@avail.test')`)
      .run(ID);
    api.db.sqlite.prepare("UPDATE templates SET ports = json_set(ports, '$[0].label', 'HDMI IN') WHERE id = ?").run(ID);
    normalizeLibrary(api.db.sqlite);
    expect(stored().ports[0].label).toBe("HDMI IN");
  });
});

describe("export:overrides and port decisions", () => {
  const decision: Override = {
    manufacturer: "Extron", modelNumber: "60-1797-01", label: "Extron UCS 303", kind: "port", port: "USB-C In (DP Alt, 60W PD)", op: "set",
    value: { section: "Video Inputs" }, source: "port decision", comment: "decided", acceptedBy: "AVAIL engineers",
  };

  it("exports accepted proposals and the file's port decisions; a file entry removed in the workspace leaves", async () => {
    importCatalog(api.db.sqlite, [file(card())]);
    await acceptProposal();
    const out = exportOverrides(api.db.sqlite, { about: "x", overrides: [decision] });
    expect(out.about).toBe("x");
    expect(out.overrides.map((o) => `${o.source.split(" ")[0]} ${o.label}`)).toEqual(["proposal Extron DTP3 T 203", "proposal Extron DTP3 T 203", "port Extron UCS 303"]);
    expect(out.overrides.every((o) => !("id" in o))).toBe(true);

    // The real docs/avail/overrides.json decisions: UCS 303 in the database, its decision removed in the workspace.
    importCatalog(api.db.sqlite, [{ ...file(card({ id: "avail-extron-60-1797-01", label: "Extron UCS 303", modelNumber: "60-1797-01", searchTerms: ["60-1797-01"] })), file: "extron/extron-ucs-303.json" }]);
    const lib = user("admin", "admin@avail.test");
    const list = (await json<{ overrides: { key: string; source: string; fromFile: boolean }[] }>(req("/avail/templates/avail-extron-60-1797-01/overrides", { headers: { Cookie: lib.cookie } }))).overrides;
    expect(list).toEqual([expect.objectContaining({ source: "port decision", fromFile: true, key: expect.stringMatching(/^file:\d+$/) })]);
    expect((await send("POST", "/avail/templates/avail-extron-60-1797-01/overrides/remove", { key: list[0].key }, { Cookie: lib.cookie })).status).toBe(200);
    expect((await json<{ overrides: unknown[] }>(req("/avail/templates/avail-extron-60-1797-01/overrides", { headers: { Cookie: lib.cookie } }))).overrides).toEqual([]);
    const after = exportOverrides(api.db.sqlite, { overrides: [decision] });
    expect(after.overrides.some((o) => o.label === "Extron UCS 303")).toBe(false);
  });
});
