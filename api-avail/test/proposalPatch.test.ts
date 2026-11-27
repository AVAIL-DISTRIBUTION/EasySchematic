/**
 * Proposals as edits (step 2.9; src/proposals.ts, migration 9014): two proposals to one template,
 * accepted in either order, give both changes; a conflict in one field is shown (409, then chosen),
 * not overwritten; overrides only for what the edit changes; Withdraw; a data sheet link becomes the
 * ports source; the higher limit for librarians through Claude; proposals from before keep working.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { documentLink } from "../src/proposals";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const ISSUER = "https://sch.avail.test/api";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-proposal-patch-"));
  api = createApiServer({
    ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off", API_PUBLIC_URL: ISSUER, ALLOWED_ORIGINS: "https://sch.avail.test" }),
    log: () => {},
  });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const send = (method: string, p: string, body: unknown, headers: Record<string, string>) =>
  req(p, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

function user(role: string, email: string): { id: string; cookie: string; h: Record<string, string> } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}`, h: { Cookie: `session=${sid}` } };
}

/** Audinate AVIO Input as stored. */
const avio = () => ({
  id: "avio",
  label: "Audinate AVIO Analog Input",
  shortName: "AVIO Input",
  manufacturer: "Audinate",
  modelNumber: "ADP-DAI-AU-2X0",
  deviceType: "audio-interface",
  category: "Audio Products / Dante Interfaces",
  referenceUrl: "https://www.getdante.com/products/avio",
  powerDrawW: 2,
  voltage: "PoE",
  ports: [
    { id: "in1", label: "Analog In 1", signalType: "analog-audio", direction: "input", section: "Audio Inputs", connectorType: "xlr-f" },
    { id: "in2", label: "Analog In 2", signalType: "analog-audio", direction: "input", section: "Audio Inputs", connectorType: "xlr-f" },
    { id: "net", label: "Dante", signalType: "dante", direction: "bidirectional", section: "Network", connectorType: "rj45", notes: "PoE" },
  ],
});

function insert(t: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status) VALUES (?, 'draft')").run(t.id);
}

const stored = () => rowToTemplate(api.db.sqlite.prepare("SELECT * FROM templates WHERE id = 'avio'").get() as TemplateRow) as unknown as ReturnType<typeof avio>;

/** An engineer edits the template as it is now (the editor sends the whole edited copy) and proposes it. */
async function proposeEdit(by: { h: Record<string, string> }, edit: (t: ReturnType<typeof avio>) => void, note = "data sheet") {
  const t = stored();
  const { id: _id, version: _v, ...copy } = t as ReturnType<typeof avio> & { version?: number };
  edit(copy as ReturnType<typeof avio>);
  const res = await send("POST", "/submissions", { action: "update", templateId: "avio", data: copy, submitterNote: note, source: "manual" }, by.h);
  const b = (await res.json()) as { id: string; error?: string };
  expect(b.error).toBeUndefined();
  expect(res.status).toBe(201);
  return b.id;
}

const accept = (id: string, lib: { h: Record<string, string> }, resolutions?: Record<string, string>) =>
  send("POST", `/submissions/${id}/approve`, resolutions ? { resolutions } : {}, lib.h);

/** Proposal A: model number and Dante notes. Proposal B: power draw and a new port. Both from the same version. */
async function twoProposals() {
  insert(avio());
  const eng1 = user("contributor", "eng1@avail.test");
  const eng2 = user("contributor", "eng2@avail.test");
  const lib = user("moderator", "lib@avail.test");
  const a = await proposeEdit(eng1, (t) => {
    t.modelNumber = "ADP-DAI-AU-2X0-NEW";
    t.ports[2] = { ...t.ports[2], notes: "PoE, Dante primary" };
  });
  const b = await proposeEdit(eng2, (t) => {
    t.powerDrawW = 3;
    t.ports.push({ id: "gnd", label: "Ground Lift", signalType: "gpio", direction: "input", section: "Control", connectorType: "other" });
  });
  return { a, b, lib };
}

describe("two proposals to one template", () => {
  for (const order of ["A then B", "B then A"] as const) {
    it(`accepted ${order}: both changes are there`, async () => {
      const { a, b, lib } = await twoProposals();
      for (const id of order === "A then B" ? [a, b] : [b, a]) expect((await accept(id, lib)).status).toBe(200);
      const t = stored();
      expect(t.modelNumber).toBe("ADP-DAI-AU-2X0-NEW");
      expect(t.powerDrawW).toBe(3);
      expect(t.ports.find((p) => p.id === "net")!.notes).toBe("PoE, Dante primary");
      expect(t.ports.map((p) => p.id)).toEqual(["in1", "in2", "net", "gnd"]);
      expect(t.voltage).toBe("PoE");
    });
  }

  it("overrides are recorded only for what each proposal changes", async () => {
    const { a, b, lib } = await twoProposals();
    await accept(a, lib);
    await accept(b, lib);
    const rows = api.db.sqlite.prepare("SELECT kind, field, port, op, submission_id FROM avail_overrides ORDER BY id").all();
    expect(rows).toEqual([
      { kind: "field", field: "modelNumber", port: null, op: null, submission_id: a },
      { kind: "port", field: null, port: "Dante", op: "set", submission_id: a },
      { kind: "field", field: "powerDrawW", port: null, op: null, submission_id: b },
      { kind: "port", field: null, port: "Ground Lift", op: "add", submission_id: b },
    ]);
  });
});

describe("a conflict is shown, not overwritten", () => {
  async function conflicting() {
    insert(avio());
    const eng1 = user("contributor", "eng1@avail.test");
    const eng2 = user("contributor", "eng2@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const a = await proposeEdit(eng1, (t) => {
      t.powerDrawW = 2.5;
    });
    const b = await proposeEdit(eng2, (t) => {
      t.powerDrawW = 3;
      t.ports[0] = { ...t.ports[0], notes: "balanced" };
    });
    expect((await accept(a, lib)).status).toBe(200);
    return { b, lib };
  }

  it("Accept answers 409 with at creation / now / proposed; the pending list shows it; nothing written", async () => {
    const { b, lib } = await conflicting();
    const res = await accept(b, lib);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; conflicts: unknown[] };
    expect(body.error).toMatch(/changed since this proposal was made: powerDrawW/);
    expect(body.conflicts).toEqual([{ key: "field:powerDrawW", label: "powerDrawW", base: 2, current: 2.5, proposed: 3 }]);
    expect(stored().powerDrawW).toBe(2.5);
    expect(stored().ports[0]).not.toHaveProperty("notes");
    const pending = await json<{ id: string; conflicts: { key: string }[]; changes: string[] }[]>(req("/avail/proposals/pending", { headers: lib.h }));
    expect(pending).toEqual([expect.objectContaining({ id: b, changes: ["powerDrawW", 'port "Analog In 1": notes'], conflicts: [expect.objectContaining({ key: "field:powerDrawW" })] })]);
  });

  it("choosing the current value keeps it and applies the rest; choosing the proposed one takes it", async () => {
    const { b, lib } = await conflicting();
    expect((await accept(b, lib, { "field:powerDrawW": "current" })).status).toBe(200);
    expect(stored().powerDrawW).toBe(2.5);
    expect(stored().ports[0].notes).toBe("balanced");
    // No override for the value that was kept.
    expect(api.db.sqlite.prepare("SELECT field FROM avail_overrides WHERE submission_id = ? AND kind = 'field'").all(b)).toEqual([]);
  });

  it("the proposed side", async () => {
    const { b, lib } = await conflicting();
    expect((await accept(b, lib, { "field:powerDrawW": "proposed" })).status).toBe(200);
    expect(stored().powerDrawW).toBe(3);
  });
});

describe("withdraw, document source, limits, older proposals", () => {
  it("the author withdraws a pending proposal; nobody else can; it leaves the queue", async () => {
    insert(avio());
    const eng = user("contributor", "eng@avail.test");
    const other = user("contributor", "other@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const id = await proposeEdit(eng, (t) => {
      t.powerDrawW = 4;
    });
    expect((await send("POST", `/avail/proposals/${id}/withdraw`, {}, other.h)).status).toBe(403);
    expect((await send("POST", `/avail/proposals/${id}/withdraw`, {}, eng.h)).status).toBe(200);
    expect((await send("POST", `/avail/proposals/${id}/withdraw`, {}, eng.h)).status).toBe(409);
    expect(await json<unknown[]>(req("/submissions/pending", { headers: lib.h }))).toEqual([]);
    const mine = await json<{ id: string; status: string }[]>(req("/submissions/mine", { headers: eng.h }));
    expect(mine).toEqual([expect.objectContaining({ id, status: "withdrawn" })]);
    const log = api.db.sqlite.prepare("SELECT actor, after FROM avail_audit_log WHERE action = 'proposal'").get() as { actor: string; after: string };
    expect(log.actor).toBe("eng@avail.test");
    expect(JSON.parse(log.after)).toMatchObject({ decision: "withdrawn" });
  });

  it("a comment linking the data sheet makes it the ports source when the ports change", async () => {
    insert(avio());
    const eng = user("contributor", "eng@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const url = "https://www.getdante.com/wp-content/uploads/AVIO-Analog-Input-Datasheet.pdf";
    const id = await proposeEdit(eng, (t) => {
      t.ports[0] = { ...t.ports[0], connectorType: "xlr-f", notes: "mic / line" };
    }, `Per the data sheet ${url}.`);
    expect((await accept(id, lib)).status).toBe(200);
    const catalog = JSON.parse((api.db.sqlite.prepare("SELECT catalog FROM avail_template_meta WHERE template_id = 'avio'").get() as { catalog: string }).catalog);
    expect(catalog).toMatchObject({ portsSource: { kind: "datasheet", from: url }, datasheetUrl: url });
    const ws = await json<{ templates: { id: string; avail: { portsOrigin: string } }[] }>(req("/avail/workspace/templates", { headers: lib.h }));
    expect(ws.templates.find((t) => t.id === "avio")!.avail.portsOrigin).toBe("manufacturer");
    expect(documentLink("see https://example.com/page and https://x.com/spec-sheet/ocs100.")).toBe("https://x.com/spec-sheet/ocs100");
    expect(documentLink("no link")).toBeNull();
  });

  it("limits: 30 an hour for an engineer and a librarian in the browser; 200 for a librarian through Claude", async () => {
    insert(avio());
    const eng = user("contributor", "eng@avail-int.test");
    const lib = user("moderator", "lib@avail.test");
    const fill = (userId: string, n: number) => {
      const ins = api.db.sqlite.prepare("INSERT INTO submissions (id, user_id, action, template_id, data, status) VALUES (?, ?, 'update', 'avio', '{}', 'approved')");
      for (let i = 0; i < n; i++) ins.run(crypto.randomUUID(), userId);
    };
    fill(eng.id, 30);
    fill(lib.id, 30);
    const body = { templateId: "avio", patch: { powerDrawW: 9 }, comment: "x" };
    expect((await send("POST", "/avail/proposals", body, eng.h)).status).toBe(429);
    expect((await send("POST", "/avail/proposals", body, lib.h)).status).toBe(429);
    // Through Claude (OAuth) the librarian may go on.
    const access = await oauthToken(lib.cookie);
    const res = await send("POST", "/avail/proposals", body, { Authorization: `Bearer ${access}` });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "pending", changes: ["powerDrawW"] });
  });

  it("a proposal made before (no stored edit) is accepted as its whole template, as before", async () => {
    insert(avio());
    const eng = user("contributor", "eng@avail.test");
    const lib = user("moderator", "lib@avail.test");
    const id = await proposeEdit(eng, (t) => {
      t.powerDrawW = 5;
    });
    api.db.sqlite.prepare("DELETE FROM avail_proposals WHERE submission_id = ?").run(id);
    const pending = await json<{ id: string; legacy: boolean }[]>(req("/avail/proposals/pending", { headers: lib.h }));
    expect(pending).toEqual([{ id, templateId: "avio", legacy: true }]);
    expect((await accept(id, lib)).status).toBe(200);
    expect(stored().powerDrawW).toBe(5);
  });
});

/** A librarian connects Claude (OAuth) and gets an access token. */
async function oauthToken(cookie: string): Promise<string> {
  const reg = await json<{ client_id: string }>(
    send("POST", "/oauth/register", { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }, {}),
  );
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256",
  });
  const page = await (await req(`/oauth/authorize?${q}`, { headers: { Cookie: cookie } })).text();
  const pending = /name="pending" value="([^"]+)"/.exec(page)![1];
  const allow = await req("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: `pending=${pending}&decision=allow` });
  const code = new URL(allow.headers.get("Location")!).searchParams.get("code")!;
  const tok = await json<{ access_token: string }>(
    req("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: reg.client_id, code_verifier: verifier }).toString(),
    }),
  );
  return tok.access_token;
}
