/**
 * Vendors' answers (step 1.8b, src/vendorResponses.ts): the input and docs/avail/deleted-templates.json
 * agree; deletes remove the template and its meta; updates write values as in the file and notes as
 * moderator notes; statuses kept, levels recomputed; curated templates stop the run; dry run;
 * idempotency; import:upstream never brings deleted ids back.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { AVAIL_LIBRARY_SOURCE } from "../src/importAvail";
import { importTemplates } from "../src/importUpstream";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import {
  applyVendorResponses,
  DELETED_TEMPLATES,
  deletedTemplateIds,
  formatVendorResponsesReport,
  VENDOR_NOTES_USER,
  type VendorResponses,
} from "../src/vendorResponses";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("tools/avail/incoming/vendor-responses.json and docs/avail/deleted-templates.json", () => {
  const input = JSON.parse(readFileSync(path.join(repo, "tools/avail/incoming/vendor-responses.json"), "utf8")) as VendorResponses;

  it("every delete is in the deleted list, with vendor, model and reason", () => {
    const listed = deletedTemplateIds();
    for (const d of input.delete) expect(listed.has(d.id), `${d.vendor} ${d.model}`).toBe(true);
    for (const t of DELETED_TEMPLATES.templates) {
      expect(t.vendor, t.id).toMatch(/\S/);
      expect(t.model, t.id).toMatch(/\S/);
      expect(t.reason, t.id).toMatch(/\S/);
    }
    expect(new Set(DELETED_TEMPLATES.templates.map((t) => t.id)).size).toBe(DELETED_TEMPLATES.templates.length);
  });

  it("no curated template is deleted or updated", () => {
    const dir = path.join(repo, "library/avail");
    const curated = new Set(
      readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")).id as string),
    );
    for (const d of input.delete) expect(curated.has(d.id), d.model).toBe(false);
    for (const id of Object.keys(input.update)) expect(curated.has(id), id).toBe(false);
    for (const t of DELETED_TEMPLATES.templates) expect(curated.has(t.id), t.model).toBe(false);
  });
});

let dataDir: string;
let api: ApiServer;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-vendor-responses-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const POWER = { id: "p", label: "AC Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };

function insert(t: Record<string, unknown>, status = "raw", source: string | null = "easyschematic.live") {
  const row = templateToRow({ category: "Networking / Switches", ports: [POWER], ...t } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source, upstream_id) VALUES (?, ?, ?, ?)").run(t.id, status, source, t.id);
}
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;
const notes = (id: string) => api.db.sqlite.prepare("SELECT * FROM template_notes WHERE template_id = ?").all(id) as Record<string, unknown>[];

const input: VendorResponses = {
  source: "test answers",
  delete: [
    { id: "old1", vendor: "Shure", model: "Old One", reason: "EoL equipment - delete" },
    { id: "old2", vendor: "Shure", model: "Old Two", reason: "Ignore. Remove from the database" },
    { id: "gone", vendor: "Yealink", model: "Gone", reason: "EoL equipment - delete" },
  ],
  update: {
    sw: { vendor: "Netgear-AV", model: "M4250", set: { voltage: "100-240V", powerDrawW: 258 }, note: "vendor: With full 220 W PoE load; 18.14 W without PoE" },
    mic: { vendor: "Shure", model: "Mic", set: { heightMm: 88.0 } },
  },
};
const deletedList = { version: 1, templates: input.delete.map((d) => ({ ...d })) };

describe("applyVendorResponses", () => {
  beforeEach(() => {
    insert({ id: "old1", label: "Shure Old One", manufacturer: "Shure", deviceType: "wired-mic" });
    insert({ id: "old2", label: "Shure Old Two", manufacturer: "Shure", deviceType: "wired-mic" }, "hidden");
    insert({ id: "sw", label: "Netgear-AV M4250", manufacturer: "Netgear-AV", deviceType: "network-switch", powerDrawW: 100 }, "draft");
    insert({ id: "mic", label: "Shure Mic", manufacturer: "Shure", deviceType: "wired-mic" }, "verified");
  });

  it("deletes templates with their meta, writes values as in the file, adds notes, keeps statuses", () => {
    api.db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('mod', 'mod@x.test', 'Mod', 'moderator')").run();
    api.db.sqlite.prepare("INSERT INTO template_notes (id, template_id, author_id, body) VALUES ('n1', 'old1', 'mod', 'old note')").run();
    const r = applyVendorResponses(api.db.sqlite, input, { deletedList });

    expect(row("old1")).toBeUndefined();
    expect(meta("old1")).toBeUndefined();
    expect(notes("old1")).toEqual([]);
    expect(row("old2")).toBeUndefined();
    expect(r.deleted.map((d) => d.id)).toEqual(["old1", "old2"]);
    expect(r.alreadyDeleted).toBe(1);

    expect(row("sw")).toMatchObject({ voltage: "100-240V", power_draw_w: 258, version: 2 });
    expect(row("mic")).toMatchObject({ height_mm: 88 });
    expect(meta("sw")).toMatchObject({ status: "draft", updated_by: "vendor-responses" });
    expect(meta("mic")!.status).toBe("verified");
    expect(meta("sw")!.lint_level).toMatch(/^(A|B|FIX)$/);
    expect(meta("sw")!.linted_version).toBe(2);

    expect(notes("sw")).toMatchObject([{ author_id: VENDOR_NOTES_USER.id, body: "vendor: With full 220 W PoE load; 18.14 W without PoE" }]);
    const user = api.db.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(VENDOR_NOTES_USER.id) as Record<string, unknown>;
    expect(user).toMatchObject({ banned: 1, role: "contributor" });
    expect(String(user.email)).toMatch(/\.invalid$/);

    expect(r.statusesAfter).toMatchObject({ draft: 1, verified: 1 });
    const text = formatVendorResponsesReport(r, "v.json");
    expect(text).toContain("Deleted: 2 (already gone: 1); updated: 2 (already as in the file: 0); notes added: 1");
    expect(text).toMatch(/Deleted by vendor:\n {2}Shure\s+2/);
    expect(text).toContain("Levels by vendor (our vendors):  before → after");
  });

  it("a second run changes nothing; a dry run writes nothing", () => {
    const before = api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all();
    expect(applyVendorResponses(api.db.sqlite, input, { deletedList, dryRun: true }).deleted).toHaveLength(2);
    expect(api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all()).toEqual(before);
    expect(notes("sw")).toEqual([]);

    applyVendorResponses(api.db.sqlite, input, { deletedList });
    const after = api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all();
    const again = applyVendorResponses(api.db.sqlite, input, { deletedList });
    expect(again).toMatchObject({ deleted: [], alreadyDeleted: 3, updated: [], unchanged: 2 });
    expect(api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all()).toEqual(after);
    expect(notes("sw")).toHaveLength(1);
  });

  it("a curated template in the file stops the run: nothing written, listed in the report", () => {
    insert({ id: "lib", label: "Extron Curated", manufacturer: "Extron", deviceType: "switcher" }, "verified", AVAIL_LIBRARY_SOURCE);
    const withLib: VendorResponses = { ...input, delete: [...input.delete, { id: "lib", vendor: "Extron", model: "Curated", reason: "x" }] };
    const r = applyVendorResponses(api.db.sqlite, withLib, { deletedList });
    expect(r.blocked).toEqual([{ id: "lib", model: "Extron Curated", action: "delete" }]);
    expect(row("old1")).toBeDefined();
    expect(row("lib")).toBeDefined();
    expect(row("sw")!.power_draw_w).toBe(100);
    expect(formatVendorResponsesReport(r, "v.json")).toContain("STOPPED");

    // Also by the library directory's ids, before import:avail has run.
    const r2 = applyVendorResponses(api.db.sqlite, input, { deletedList, libraryIds: ["sw"] });
    expect(r2.blocked).toEqual([{ id: "sw", model: "Netgear-AV M4250", action: "update" }]);
  });

  it("values not as expected are reported, not written; deletes missing from the deleted list are warned about", () => {
    const r = applyVendorResponses(api.db.sqlite, { delete: [], update: { mic: { vendor: "Shure", model: "Mic", set: { heightMm: "88 mm", ports: [] } } } });
    expect(r.invalid).toEqual(['Shure Mic [mic]: heightMm = "88 mm", ports = []']);
    expect(row("mic")!.height_mm).toBeNull();
    const r2 = applyVendorResponses(api.db.sqlite, input, { deletedList: { version: 1, templates: [] }, dryRun: true });
    expect(r2.notInDeletedList).toHaveLength(3);
    expect(formatVendorResponsesReport(r2, "v.json")).toContain("WARNING: deleted but not in docs/avail/deleted-templates.json");
  });
});

describe("import:upstream and deleted templates", () => {
  it("never brings back an id from docs/avail/deleted-templates.json", () => {
    const id = DELETED_TEMPLATES.templates[0].id;
    const source = [
      { id, deviceType: "wired-mic", label: `${DELETED_TEMPLATES.templates[0].vendor} ${DELETED_TEMPLATES.templates[0].model}`, manufacturer: DELETED_TEMPLATES.templates[0].vendor, ports: [POWER] },
      { id: "fresh", deviceType: "wired-mic", label: "Shure Fresh", manufacturer: "Shure", ports: [POWER] },
    ];
    const r = importTemplates(api.db.sqlite, source);
    expect(r.skipped.deleted).toBe(1);
    expect(row(id)).toBeUndefined();
    expect(row("fresh")).toBeDefined();
  });
});
