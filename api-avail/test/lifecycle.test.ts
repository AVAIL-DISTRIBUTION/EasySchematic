/**
 * Product lifecycle (migration 9012, src/avail/lifecycle.ts): POST /avail/templates/lifecycle/batch
 * (librarian, admin; audit; re-lint and demotion), availLifecycle in the library, lifecycle in the
 * workspace data, import:catalog from the card's _avail.lifecycle (the librarian's value stays while
 * the file's lifecycle does not change), the linter's estimates rule (standard v0.12) in the database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import type { CatalogFileText } from "../src/catalogFiles";
import { formatImportCatalogReport, importCatalog } from "../src/importCatalog";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { relintAll } from "../src/templateMeta";

const ADMIN_TOKEN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-lifecycle-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));
const post = (p: string, body: unknown, cookie: string) =>
  req(p, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

function user(role: string, email: string): { id: string; cookie: string } {
  const id = crypto.randomUUID();
  const sid = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)").run(id, email, email.split("@")[0], role);
  api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sid, id);
  return { id, cookie: `session=${sid}` };
}

/** A level-A template; `estimated` puts "estimated from …" in a port's notes. */
function tpl(id: string, over: Record<string, unknown> = {}, estimated = false) {
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
      {
        id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel",
        ...(estimated ? { notes: "estimated from DTP3 T 202" } : {}),
      },
    ],
    ...over,
  };
}

function insert(t: Record<string, unknown>, status = "draft", lifecycle?: { lifecycle: string; available_from?: string; eol_date?: string }) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite
    .prepare(
      `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, lifecycle, available_from, eol_date)
       VALUES (?, ?, 'A', 1, ?, ?, ?)`,
    )
    .run(t.id, status, lifecycle?.lifecycle ?? "active", lifecycle?.available_from ?? null, lifecycle?.eol_date ?? null);
}

const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("migration 9012", () => {
  it("adds lifecycle (default active, checked), available_from, eol_date", () => {
    insert(tpl("a"));
    expect(meta("a")).toMatchObject({ lifecycle: "active", available_from: null, eol_date: null });
    expect(() => api.db.sqlite.prepare("UPDATE avail_template_meta SET lifecycle = 'retired' WHERE template_id = 'a'").run()).toThrow(/CHECK/);
  });
});

describe("POST /avail/templates/lifecycle/batch", () => {
  it("is for librarians and admins; checks the lifecycle, its date and the ids", async () => {
    insert(tpl("a"));
    const engineer = user("contributor", "eng@avail.test");
    const lib = user("moderator", "lib@avail.test");
    expect((await post("/avail/templates/lifecycle/batch", { ids: ["a"], lifecycle: "eol" }, engineer.cookie)).status).toBe(403);
    const bad = async (body: unknown) => {
      const res = await post("/avail/templates/lifecycle/batch", body, lib.cookie);
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    expect(await bad({ ids: ["a"], lifecycle: "retired" })).toEqual({ status: 400, error: "lifecycle must be one of upcoming, active, eol" });
    expect((await bad({ ids: ["a"], lifecycle: "upcoming", availableFrom: "Q3 2027" })).error).toMatch(/availableFrom must be/);
    expect((await bad({ ids: ["a"], lifecycle: "upcoming", eolDate: "2027" })).error).toBe("eolDate is only for eol");
    expect((await bad({ ids: ["a"], lifecycle: "active", eolDate: "2027" })).error).toBe("active takes no date");
    expect((await bad({ ids: [], lifecycle: "eol" })).error).toMatch(/ids must be 1 to 500/);
  });

  it("sets the lifecycle, writes the audit log, rolls the library version; unchanged and missing reported", async () => {
    insert(tpl("a"));
    insert(tpl("b"), "draft", { lifecycle: "upcoming", available_from: "2027-Q3" });
    const lib = user("moderator", "lib@avail.test");
    const version = () => (api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version;
    const v0 = version();
    const res = await post("/avail/templates/lifecycle/batch", { ids: ["a", "b", "nope"], lifecycle: "upcoming", availableFrom: "2027 q3" }, lib.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lifecycle: { lifecycle: "upcoming", availableFrom: "2027-Q3" },
      updated: ["a"],
      unchanged: ["b"],
      failed: [{ id: "nope", reason: "not_found" }],
      demoted: [],
    });
    expect(meta("a")).toMatchObject({ lifecycle: "upcoming", available_from: "2027-Q3", eol_date: null, status: "draft" });
    expect(version()).toBe(v0 + 1);
    const log = api.db.sqlite.prepare("SELECT actor, entity_id, action, before, after FROM avail_audit_log WHERE action = 'lifecycle'").all() as Record<string, string>[];
    expect(log).toEqual([
      {
        actor: "lib@avail.test", entity_id: "a", action: "lifecycle",
        before: JSON.stringify({ lifecycle: "active" }), after: JSON.stringify({ lifecycle: "upcoming", availableFrom: "2027-Q3" }),
      },
    ]);

    // EoL clears the upcoming date; the date of EoL is optional.
    await post("/avail/templates/lifecycle/batch", { ids: ["a"], lifecycle: "eol", eolDate: "2026-06" }, lib.cookie);
    expect(meta("a")).toMatchObject({ lifecycle: "eol", available_from: null, eol_date: "2026-06" });
  });

  it("re-lints: estimates are fine for upcoming; a verified template with estimates set active becomes draft", async () => {
    insert(tpl("est", {}, true), "verified", { lifecycle: "upcoming", available_from: "2027-Q3" });
    relintAll(api.db.sqlite);
    expect(meta("est").lint_level).toBe("A");
    const res = await req("/avail/templates/lifecycle/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ ids: ["est"], lifecycle: "active" }),
    });
    expect(((await res.json()) as { demoted: string[] }).demoted).toEqual(["est"]);
    expect(meta("est")).toMatchObject({ lifecycle: "active", lint_level: "B", status: "draft" });
    expect(String(meta("est").status_reason)).toMatch(/Standard level B/);
    const actions = (api.db.sqlite.prepare("SELECT action FROM avail_audit_log WHERE entity_id = 'est' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(["lifecycle", "status"]);
  });
});

describe("library and workspace", () => {
  it("GET /templates carries availLifecycle for upcoming and EoL only; the workspace has lifecycle for every template", async () => {
    insert(tpl("a"));
    insert(tpl("u"), "draft", { lifecycle: "upcoming", available_from: "2027-Q3" });
    insert(tpl("e"), "draft", { lifecycle: "eol" });
    const lib = (await (await req("/templates")).json()) as { id: string; availLifecycle?: unknown }[];
    const by = new Map(lib.map((t) => [t.id, t.availLifecycle]));
    expect(by.get("a")).toBeUndefined();
    expect(by.get("u")).toEqual({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    expect(by.get("e")).toEqual({ lifecycle: "eol" });

    const librarian = user("moderator", "lib@avail.test");
    const ws = (await (await req("/avail/workspace/templates", { headers: { Cookie: librarian.cookie } })).json()) as {
      templates: { id: string; avail: Record<string, unknown> }[];
    };
    const info = new Map(ws.templates.map((t) => [t.id, t.avail]));
    expect(info.get("a")).toMatchObject({ lifecycle: "active", availableFrom: null, eolDate: null });
    expect(info.get("u")).toMatchObject({ lifecycle: "upcoming", availableFrom: "2027-Q3", eolDate: null });
    expect(info.get("e")).toMatchObject({ lifecycle: "eol", eolDate: null });
  });
});

describe("import:catalog", () => {
  const file = (t: Record<string, unknown>): CatalogFileText => {
    const text = JSON.stringify(t, null, 2);
    return { file: "extron/extron-dtp3-t-203.json", text, template: JSON.parse(text) };
  };
  const card = (avail: Record<string, unknown>, estimated = false) => ({ ...tpl("avail-extron-1", { modelNumber: "60-1" }, estimated), _avail: { status: "ports-filled", ...avail } });

  it("sets the card's lifecycle; keeps the librarian's while the file's lifecycle does not change", async () => {
    const r1 = importCatalog(api.db.sqlite, [file(card({ lifecycle: "upcoming", availableFrom: "2027-Q3" }, true))]);
    expect(meta("avail-extron-1")).toMatchObject({ lifecycle: "upcoming", available_from: "2027-Q3" });
    // Estimates of an upcoming product: level A, loaded.
    expect(r1.rows[0]).toMatchObject({ action: "inserted", level: "A" });
    expect(r1.lifecycle).toEqual([{ file: "extron/extron-dtp3-t-203.json", id: "avail-extron-1", label: "Extron DTP3 T 203", from: "Active", to: "Upcoming, available from 2027-Q3" }]);
    expect(formatImportCatalogReport(r1, "library/catalog")).toContain("Lifecycle set from the catalog: 1");

    // A librarian moves it to EoL; another change of the file (not its lifecycle) keeps that.
    const lib = user("moderator", "lib@avail.test");
    await post("/avail/templates/lifecycle/batch", { ids: ["avail-extron-1"], lifecycle: "eol" }, lib.cookie);
    const r2 = importCatalog(api.db.sqlite, [file({ ...card({ lifecycle: "upcoming", availableFrom: "2027-Q3" }, true), weightKg: 0.4 })]);
    expect(r2.rows[0].action).toBe("updated");
    expect(r2.lifecycle).toEqual([]);
    expect(meta("avail-extron-1")).toMatchObject({ lifecycle: "eol" });

    // The file's lifecycle changes: the file wins (released: active; the estimate is now a warning).
    const r3 = importCatalog(api.db.sqlite, [file({ ...card({ lifecycle: "active" }, true), weightKg: 0.4 })]);
    expect(meta("avail-extron-1")).toMatchObject({ lifecycle: "active", available_from: null });
    expect(r3.rows[0]).toMatchObject({ level: "B" });
  });

  it("a card without lifecycle is active", () => {
    importCatalog(api.db.sqlite, [file(card({}))]);
    expect(meta("avail-extron-1")).toMatchObject({ lifecycle: "active" });
  });
});
