/**
 * Remote MCP server (step 2.6, api-avail/src/mcp.ts): POST /mcp with an AI Assistant token —
 * the protocol (initialize, tools/list, notifications, errors), every tool, refusal without a
 * token, the role's rights, and the audit log (creating calls logged with the token, reads not).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { resetMcpCache, TOOLS } from "../src/mcp";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const CLAUDE = "avail-ai-assistant";
let dataDir: string;
let api: ApiServer;
let token: string;
let admin: { id: string; cookie: string };

function user(role: string, email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-mcp-"));
  api = createApiServer({
    ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off", ALLOWED_ORIGINS: "https://sch.avail.test", API_PUBLIC_URL: "https://sch.avail.test/api" }),
    log: () => {},
  });
  resetMcpCache();
  admin = user("admin", "boss@avail.test");
  const res = await req(`/avail/users/${CLAUDE}/tokens`, {
    method: "POST",
    headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "claude.ai connector", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
  });
  token = ((await res.json()) as { value: string }).value;
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const port = (id: string, label: string, signalType: string, direction: string, section: string, connectorType: string) => ({ id, label, signalType, direction, section, connectorType });
const tpl = (id: string, label: string, modelNumber: string, over: Record<string, unknown> = {}) => ({
  ...(id ? { id } : {}), label, manufacturer: label.split(" ")[0], modelNumber, deviceType: "hdbaset-extender", category: "AV distribution / Extenders",
  referenceUrl: "https://www.extron.com/product/x",
  ports: [port("1", "HDMI In", "hdmi", "input", "Video Inputs", "hdmi"), port("2", "12V DC In", "power", "input", "Power", "phoenix")],
  ...over,
});

function insert(t: Record<string, unknown>, status = "verified", level: string | null = "A", catalog?: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite
    .prepare("INSERT INTO avail_template_meta (template_id, status, source, lint_level, linted_version, catalog) VALUES (?, ?, ?, ?, (SELECT version FROM templates WHERE id = ?), ?)")
    .run(t.id, status, catalog ? "avail-catalog" : "easyschematic.live", level, t.id, catalog ? JSON.stringify(catalog) : null);
}

let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) {
  const res = await req("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { code: number; message: string } } | null, res };
}

/** tools/call → the parsed JSON answer, and isError. */
async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  if (body?.error) throw new Error(`${body.error.code} ${body.error.message}`);
  const r = body!.result as { content: { type: string; text: string }[]; isError?: boolean };
  return { data: JSON.parse(r.content[0].text) as T, isError: r.isError ?? false };
}

const claudeLog = () =>
  api.db.sqlite.prepare("SELECT entity, entity_id, action, after, token FROM avail_audit_log WHERE actor = 'claude@avail.invalid' ORDER BY id").all() as {
    entity: string; entity_id: string; action: string; after: string | null; token: string | null;
  }[];

describe("sign-in", () => {
  it("no token, a session cookie, an unknown or revoked token: 401", async () => {
    const none = await rpc("tools/list", undefined, {});
    expect(none.status).toBe(401);
    expect(none.res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(none.body).toMatchObject({ error: expect.stringMatching(/AI Assistant access token/) });
    const lib = user("moderator", "lib@avail.test");
    expect((await rpc("tools/list", undefined, { Cookie: lib.cookie })).status).toBe(401);
    expect((await rpc("tools/list", undefined, { Authorization: "Bearer avail_ai_nope" })).status).toBe(401);
    const id = (api.db.sqlite.prepare("SELECT id FROM avail_access_tokens").get() as { id: string }).id;
    await req(`/avail/tokens/${id}/revoke`, { method: "POST", headers: { Cookie: admin.cookie } });
    const revoked = await rpc("tools/list");
    expect(revoked.status).toBe(401);
    expect(revoked.body).toMatchObject({ error: expect.stringMatching(/was revoked/) });
  });

  it("a token whose user is no longer an AI Assistant: 401; a foreign Origin: 403", async () => {
    expect((await rpc("tools/list", undefined, { Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
    api.db.sqlite.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").run(CLAUDE);
    expect((await rpc("tools/list")).status).toBe(401);
  });
});

describe("protocol", () => {
  it("initialize negotiates the version; notifications get 202; GET is 405; unknown method and tool are errors", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body!.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "avail-library" } });
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body!.result!.protocolVersion).toBe("2025-06-18");
    const note = await req("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect((await req("/mcp", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await rpc("ping")).body!.result).toEqual({});
    expect((await rpc("resources/list")).body!.error!.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "approve_template", arguments: {} })).body!.error!.code).toBe(-32602);
    expect((await rpc("tools/list", undefined, { Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2000-01-01" })).status).toBe(400);
  });

  it("tools/list: the nine tools, English descriptions, read-only ones marked; nothing that approves or hides", async () => {
    const { body } = await rpc("tools/list");
    const tools = (body!.result as { tools: { name: string; description: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "search_templates", "get_template", "lint_template", "normalize_template", "create_draft_template", "propose_change", "review_queue", "possible_duplicates", "audit_log",
    ]);
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["create_draft_template", "propose_change"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeLessThan(300);
      expect(t.description).toMatch(/^[\x20-\x7E]+$/);
    }
    expect(TOOLS).toHaveLength(9);
  });

  it("a batch gets a batch", async () => {
    const res = await req("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]),
    });
    expect(await res.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
  });
});

describe("reading tools", () => {
  beforeEach(() => {
    insert(tpl("e1", "Extron DTP3 T 203", "60-1"), "verified", "A", { file: "extron/a.json", portsSource: { kind: "datasheet", from: "https://x/a.pdf" }, datasheetUrl: "https://x/a.pdf" });
    insert(tpl("e2", "Extron DTP3 R 203", "60-2", { ports: [port("1", "HDMI Out", "hdmi", "output", "Video Outputs", "hdmi")] }), "draft", "B");
    insert(tpl("e3", "Extron SW4 HD", "60-3", { deviceType: "switcher", category: "AV distribution / Switchers" }), "draft", "A");
    insert(tpl("e4", "Extron SW4 HD", "60-3", { deviceType: "switcher", category: "AV distribution / Switchers" }), "raw", "A");
    insert(tpl("b1", "Biamp Parle TCM-XA", "911-1", { deviceType: "wired-mic", category: "Microphones / Array microphones" }), "verified", "A");
    insert(tpl("h1", "Extron Old", "60-9"), "hidden", "A");
  });

  it("search_templates: filters combine, pagination, hidden only on request, compact items", async () => {
    const ids = async (a: Record<string, unknown>) => (await tool<{ total: number; items: { id: string }[] }>("search_templates", a)).data.items.map((i) => i.id).sort();
    expect(await ids({})).toEqual(["b1", "e1", "e2", "e3", "e4"]);
    expect(await ids({ vendor: "extron", status: "draft" })).toEqual(["e2", "e3"]);
    expect(await ids({ category: "AV distribution / Switchers" })).toEqual(["e3", "e4"]);
    expect(await ids({ category: "Microphones" })).toEqual(["b1"]);
    expect(await ids({ device_type: "switcher", level: "A" })).toEqual(["e3", "e4"]);
    expect(await ids({ level: "B" })).toEqual(["e2"]);
    expect(await ids({ ports_source: "manufacturer" })).toEqual(["e1"]);
    expect(await ids({ text: "tcm" })).toEqual(["b1"]);
    expect(await ids({ status: "hidden" })).toEqual(["h1"]);
    expect(await ids({ lint_rule: "power port" })).toEqual(["e2"]);
    const p = await tool<{ total: number; offset: number; items: Record<string, unknown>[] }>("search_templates", { limit: 2, offset: 1 });
    expect([p.data.total, p.data.offset, p.data.items.length]).toEqual([5, 1, 2]);
    const e1 = (await tool<{ items: Record<string, unknown>[] }>("search_templates", { text: "60-1" })).data.items[0];
    expect(e1).toEqual({ id: "e1", label: "Extron DTP3 T 203", part: "60-1", category: "AV distribution / Extenders", type: "hdbaset-extender", status: "verified", level: "A", ports: "manufacturer", lifecycle: "active" });
    await expect(tool("search_templates", { level: "Z" })).rejects.toThrow(/-32602 level must be one of A, B, FIX/);
  });

  it("lifecycle: search_templates filter, in the items and in get_template", async () => {
    api.db.sqlite.prepare("UPDATE avail_template_meta SET lifecycle = 'upcoming', available_from = '2027-Q3' WHERE template_id = 'e2'").run();
    api.db.sqlite.prepare("UPDATE avail_template_meta SET lifecycle = 'eol' WHERE template_id = 'b1'").run();
    resetMcpCache();
    const search = async (a: Record<string, unknown>) => (await tool<{ items: Record<string, unknown>[] }>("search_templates", a)).data.items;
    expect(await search({ lifecycle: "upcoming" })).toEqual([expect.objectContaining({ id: "e2", lifecycle: "upcoming", available_from: "2027-Q3" })]);
    expect((await search({ lifecycle: "eol" })).map((i) => i.id)).toEqual(["b1"]);
    expect((await search({ lifecycle: "active" })).map((i) => i.id).sort()).toEqual(["e1", "e3", "e4"]);
    await expect(tool("search_templates", { lifecycle: "retired" })).rejects.toThrow(/-32602 lifecycle must be one of upcoming, active, eol/);
    expect((await tool<Record<string, unknown>>("get_template", { id: "e2" })).data.lifecycle).toEqual({ state: "upcoming", available_from: "2027-Q3" });
    expect((await tool<Record<string, unknown>>("get_template", { id: "e1" })).data.lifecycle).toEqual({ state: "active" });
  });

  it("get_template: card, ports by section, lint, ports source, links, duplicates, history", async () => {
    await req("/avail/templates/e3/status", { method: "PUT", headers: { Cookie: admin.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ status: "raw" }) });
    resetMcpCache();
    const { data } = await tool<Record<string, unknown>>("get_template", { id: "e1" });
    expect(data).toMatchObject({
      id: "e1", label: "Extron DTP3 T 203", manufacturer: "Extron", part: "60-1", status: "verified", level: "A",
      ports_source: { origin: "manufacturer", kind: "datasheet", from: "https://x/a.pdf" },
      links: { product: "https://www.extron.com/product/x", datasheet: "https://x/a.pdf", library: "https://sch.avail.test/library?template=e1" },
      ports: { "Video Inputs": [{ label: "HDMI In", dir: "input", signal: "hdmi", connector: "hdmi" }], Power: [{ label: "12V DC In", dir: "input", signal: "power", connector: "phoenix" }] },
    });
    expect(data.lint).toHaveProperty("errors");
    const e3 = (await tool<{ possible_duplicates: { id: string }[]; history: { actor: string; action: string; changes: string[] }[] }>("get_template", { id: "e3" })).data;
    expect(e3.possible_duplicates.map((d) => d.id)).toEqual(["e4"]);
    expect(e3.history[0]).toMatchObject({ actor: "boss@avail.test", action: "status" });
    const missing = await tool("get_template", { id: "nope" });
    expect(missing).toEqual({ data: { error: "Template not found: nope" }, isError: true });
  });

  it("review_queue: drafts at level A; possible_duplicates: groups, primary first", async () => {
    expect((await tool<{ items: { id: string }[] }>("review_queue")).data.items.map((i) => i.id)).toEqual(["e3"]);
    expect((await tool<{ total: number }>("review_queue", { vendor: "Biamp" })).data.total).toBe(0);
    const d = (await tool<{ total: number; items: { primary: string; members: { id: string }[] }[] }>("possible_duplicates")).data;
    expect(d.total).toBe(1);
    expect(d.items[0].members.map((m) => m.id)).toEqual([d.items[0].primary, ...["e3", "e4"].filter((x) => x !== d.items[0].primary)]);
  });

  it("audit_log: filters and compact entries", async () => {
    await req("/avail/templates/e2/status", { method: "PUT", headers: { Cookie: admin.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ status: "hidden" }) });
    const { data } = await tool<{ items: Record<string, unknown>[] }>("audit_log", { entity: "template", entity_id: "e2" });
    expect(data.items).toEqual([{ id: expect.any(Number), entity: "template", entity_id: "e2", label: "Extron DTP3 R 203", at: expect.any(String), actor: "boss@avail.test", action: "status", changes: ["status: draft → hidden"] }]);
    expect((await tool<{ items: unknown[] }>("audit_log", { actor: "nobody@avail.test" })).data.items).toEqual([]);
    expect((await tool<{ items: { action: string }[] }>("audit_log", { entity: "user", limit: 1 })).data.items[0].action).toBe("token");
  });

  it("reading is not logged", async () => {
    await tool("search_templates", { text: "dtp3" });
    await tool("get_template", { id: "e1" });
    await tool("review_queue");
    await tool("possible_duplicates");
    await tool("audit_log");
    await tool("lint_template", { template: tpl("", "Extron X", "60-8") });
    await tool("normalize_template", { template: tpl("", "EXTRON X", "60-8") });
    expect(claudeLog()).toEqual([]);
  });
});

describe("checking without saving", () => {
  it("lint_template and normalize_template change nothing", async () => {
    insert(tpl("e1", "Extron DTP3 T 203", "60-1"));
    const before = api.db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(version) AS v FROM templates").get();
    const lint = (await tool<{ level: string; errors: string[]; warnings: string[] }>("lint_template", { template: tpl("", "Extron X", "60-8", { ports: [] }) })).data;
    expect(lint.level).toBe("FIX");
    expect(lint.errors.join(" ")).toMatch(/no ports/);
    const norm = (await tool<{ level_before: string; level_after: string; changes: string[]; manual: string[]; template: Record<string, unknown> }>("normalize_template", {
      template: { ...tpl("", "EXTRON X", "60-8"), color: "#ff0000" },
    })).data;
    expect(norm.changes.length).toBeGreaterThan(0);
    expect(norm.template).not.toHaveProperty("color");
    expect(Object.keys(norm).sort()).toEqual(["changes", "level_after", "level_before", "manual", "template"]);
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(version) AS v FROM templates").get()).toEqual(before);
    await expect(tool("lint_template", {})).rejects.toThrow(/-32602 template must be an object/);
  });
});

describe("creating: drafts and proposals", () => {
  it("create_draft_template: a draft with a link, logged with the token; a duplicate is refused with a link", async () => {
    insert(tpl("e1", "Extron DTP3 T 203", "60-1"));
    const { data, isError } = await tool<{ id: string; status: string; level: string; link: string }>("create_draft_template", { template: tpl("", "Extron DTP3 R 203", "60-2") });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ status: "draft", link: `https://sch.avail.test/library?template=${data.id}` });
    expect(api.db.sqlite.prepare("SELECT status, source FROM avail_template_meta WHERE template_id = ?").get(data.id)).toEqual({ status: "draft", source: "ai-assistant" });
    expect(claudeLog().map((e) => [e.entity, e.entity_id, e.action, e.token])).toEqual([["template", data.id, "created", "claude.ai connector"]]);

    const dup = await tool<{ error: string; duplicate_of: Record<string, string> }>("create_draft_template", { template: tpl("", "Extron DTP3 T 203 again", "60 1") });
    expect(dup.isError).toBe(true);
    expect(dup.data.error).toMatch(/already exists: Extron DTP3 T 203/);
    expect(dup.data.duplicate_of).toEqual({ id: "e1", label: "Extron DTP3 T 203", link: "https://sch.avail.test/library?template=e1" });
    const bad = await tool<{ error: string }>("create_draft_template", { template: { label: "x" } });
    expect(bad.isError).toBe(true);
  });

  it("propose_change: a pending proposal with the comment, logged with the token; comment required; unknown template refused", async () => {
    insert(tpl("e1", "Extron DTP3 T 203", "60-1"));
    const edited = { ...tpl("e1", "Extron DTP3 T 203", "60-1"), powerDrawW: 6, version: 3, avail: { status: "verified" } };
    const { data } = await tool<{ proposal_id: string; status: string }>("propose_change", { template_id: "e1", template: edited, comment: "Power 6 W per data sheet p. 2" });
    expect(data.status).toBe("pending");
    const sub = api.db.sqlite.prepare("SELECT action, template_id, status, submitter_note, data FROM submissions WHERE id = ?").get(data.proposal_id) as Record<string, string>;
    expect(sub).toMatchObject({ action: "update", template_id: "e1", status: "pending", submitter_note: "Power 6 W per data sheet p. 2" });
    expect(JSON.parse(sub.data)).not.toHaveProperty("avail");
    expect(claudeLog().map((e) => [e.entity_id, e.action, JSON.parse(e.after!), e.token])).toEqual([
      ["e1", "proposed", { proposal: data.proposal_id, comment: "Power 6 W per data sheet p. 2", changes: ["powerDrawW"] }, "claude.ai connector"],
    ]);
    // The library is unchanged until a librarian accepts it.
    expect(api.db.sqlite.prepare("SELECT power_draw_w FROM templates WHERE id = 'e1'").get()).toEqual({ power_draw_w: null });
    await expect(tool("propose_change", { template_id: "e1", template: edited })).rejects.toThrow(/-32602 comment is required/);
    expect(await tool("propose_change", { template_id: "nope", template: edited, comment: "x" })).toEqual({ data: { error: "Template not found: nope" }, isError: true });
  });
});

describe("propose_change: partial edits (patch)", () => {
  /** OCS 100C as stored: thermalBtuh, voltage, four ports. */
  const ocs = () => ({
    id: "ocs", label: "Extron OCS 100C", manufacturer: "Extron", modelNumber: "60-1664-01", deviceType: "control-expansion",
    category: "Control Systems / IP Link Control Proc", referenceUrl: "https://www.extron.com/product/ocs100",
    powerDrawW: 0.8, voltage: "24V DC (included PC 1224)", thermalBtuh: 2.6, heightMm: 114, widthMm: 114, depthMm: 36, weightKg: 0.1,
    ports: [
      { id: "relay", label: "Relay (SPDT)", signalType: "contact-closure", direction: "output", section: "Relays", connectorType: "other" },
      { id: "occ", label: "Occupancy Out", signalType: "sensor", direction: "output", section: "Control", connectorType: "other" },
      { id: "photo", label: "Occupancy + Photocell Out", signalType: "sensor", direction: "output", section: "Control", connectorType: "other" },
      { id: "pwr", label: "24V DC In", signalType: "power", direction: "input", section: "Power", connectorType: "other" },
    ],
  });
  const proposalData = (id: string) =>
    JSON.parse((api.db.sqlite.prepare("SELECT data FROM submissions WHERE id = ?").get(id) as { data: string }).data) as Record<string, unknown> & { ports: { id: string }[] };
  const stored = () => api.db.sqlite.prepare("SELECT voltage, thermal_btuh, ports FROM templates WHERE id = 'ocs'").get() as { voltage: string; thermal_btuh: number; ports: string };

  it("get_template gives raw: the template as stored, every field and the port ids", async () => {
    insert(ocs());
    const { data } = await tool<{ raw: Record<string, unknown> & { ports: { id: string }[] } }>("get_template", { id: "ocs", history: 0 });
    expect(data.raw).toMatchObject({ id: "ocs", thermalBtuh: 2.6, voltage: "24V DC (included PC 1224)", heightMm: 114 });
    expect(data.raw.ports.map((p) => p.id)).toEqual(["relay", "occ", "photo", "pwr"]);
    expect(data.raw).not.toHaveProperty("avail");
  });

  it("get_template gives raw and the lifecycle together; raw sent back proposes no lifecycle change", async () => {
    insert(ocs());
    api.db.sqlite.prepare("UPDATE avail_template_meta SET lifecycle = 'upcoming', available_from = '2027-Q3' WHERE template_id = 'ocs'").run();
    resetMcpCache();
    const { data } = await tool<{ lifecycle: unknown; raw: Record<string, unknown> & { ports: { id: string }[] } }>("get_template", { id: "ocs", history: 0 });
    expect(data.lifecycle).toEqual({ state: "upcoming", available_from: "2027-Q3" });
    expect(data.raw).toMatchObject({ id: "ocs", thermalBtuh: 2.6, availLifecycle: { lifecycle: "upcoming", availableFrom: "2027-Q3" } });
    expect(data.raw.ports.map((p) => p.id)).toEqual(["relay", "occ", "photo", "pwr"]);
    // The whole raw back with one change: the proposal changes only that field, not the lifecycle.
    const p = await tool<{ proposal_id: string; changes: string[] }>("propose_change", { template_id: "ocs", template: { ...data.raw, voltage: "24V DC" }, comment: "Spec: 24 VDC" });
    expect(p.data.changes).toEqual(["voltage"]);
    expect(proposalData(p.data.proposal_id)).not.toHaveProperty("availLifecycle");
  });

  it("one field: the rest stays (regression: thermalBtuh lost on OCS 100C); accepted → only that field changed", async () => {
    insert(ocs());
    const { data, isError } = await tool<{ proposal_id: string; changes: string[] }>("propose_change", { template_id: "ocs", patch: { voltage: "24V DC" }, comment: "Spec 5611-D6: 24 VDC" });
    expect(isError).toBe(false);
    expect(data.changes).toEqual(["voltage"]);
    const d = proposalData(data.proposal_id);
    const { id: _id, ...rest } = ocs();
    expect(d).toEqual({ ...rest, voltage: "24V DC" });
    const lib = user("moderator", "lib@avail.test");
    const ok = await req(`/submissions/${data.proposal_id}/approve`, { method: "POST", headers: { Cookie: lib.cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(ok.status).toBeLessThan(300);
    expect(stored()).toMatchObject({ voltage: "24V DC", thermal_btuh: 2.6 });
    expect(JSON.parse(stored().ports)).toEqual(ocs().ports);
  });

  it("ports by id: update, add and remove; unknown ids are refused", async () => {
    insert(ocs());
    const patch = {
      ports: {
        update: [{ id: "occ", notes: "Blue wire" }],
        add: [{ id: "usb", label: "USB-C Config", signalType: "usb", direction: "bidirectional", section: "Control", connectorType: "usb-c" }],
        remove: ["photo"],
      },
    };
    const { data } = await tool<{ proposal_id: string; changes: string[] }>("propose_change", { template_id: "ocs", patch, comment: "Spec 5611-D6" });
    expect(data.changes).toEqual(['port "Occupancy Out": notes', 'port "USB-C Config" added', 'port "Occupancy + Photocell Out" removed']);
    const d = proposalData(data.proposal_id);
    expect(d.ports.map((p) => p.id)).toEqual(["relay", "occ", "pwr", "usb"]);
    expect(d).toMatchObject({ thermalBtuh: 2.6, voltage: "24V DC (included PC 1224)" });
    expect(await tool("propose_change", { template_id: "ocs", patch: { ports: { update: [{ id: "nope", notes: "x" }] } }, comment: "x" })).toMatchObject({ isError: true });
    expect(await tool("propose_change", { template_id: "ocs", patch: { ports: { add: [{ id: "occ", label: "Dup" }] } }, comment: "x" })).toMatchObject({ isError: true });
    await expect(tool("propose_change", { template_id: "ocs", patch: {}, template: ocs(), comment: "x" })).rejects.toThrow(/-32602 Send either patch/);
  });

  it("an edit that changes nothing is refused with a clear text: empty patch, same value, the same whole template, the API too", async () => {
    insert(ocs());
    const refused = { data: { error: "The proposal changes nothing: it matches the current template. Change at least one field or port." }, isError: true };
    expect(await tool("propose_change", { template_id: "ocs", patch: {}, comment: "x" })).toEqual(refused);
    expect(await tool("propose_change", { template_id: "ocs", patch: { thermalBtuh: 2.6, ports: { update: [{ id: "occ", label: "Occupancy Out" }] } }, comment: "x" })).toEqual(refused);
    expect(await tool("propose_change", { template_id: "ocs", template: { ...ocs(), version: 7, avail: { status: "draft" }, hostname: "" }, comment: "x" })).toEqual(refused);
    const eng = user("contributor", "eng@avail.test");
    const { id: _id, ...data } = ocs();
    const res = await req("/submissions", { method: "POST", headers: { Cookie: eng.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", templateId: "ocs", data, submitterNote: "x" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: refused.data.error });
    expect(api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get()).toEqual({ n: 0 });
    // A whole template that leaves a field out is a real change (the field would be removed): it is listed.
    const { thermalBtuh: _t, ...without } = ocs();
    const { data: d } = await tool<{ changes: string[] }>("propose_change", { template_id: "ocs", template: without, comment: "x" });
    expect(d.changes).toEqual(["thermalBtuh"]);
  });
});

describe("the role's rights hold through MCP", () => {
  it("a token of a disabled user is refused; tools cannot approve (the route behind them refuses the role)", async () => {
    insert(tpl("e1", "Extron DTP3 T 203", "60-1"), "draft");
    // The draft route is for AI Assistant / librarian / admin; status changes stay librarian-only.
    const res = await req("/avail/templates/e1/status", { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ status: "verified" }) });
    expect(res.status).toBe(403);
    const bot = user("assistant", "bot@avail.test");
    const r = await req(`/avail/users/${bot.id}/tokens`, {
      method: "POST",
      headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bot", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    });
    const botToken = ((await r.json()) as { value: string }).value;
    expect((await rpc("ping", undefined, { Authorization: `Bearer ${botToken}` })).status).toBe(200);
    await req(`/avail/users/${bot.id}/active`, { method: "PUT", headers: { Cookie: admin.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect((await rpc("ping", undefined, { Authorization: `Bearer ${botToken}` })).status).toBe(401);
  });
});
