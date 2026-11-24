/**
 * Curated library import (src/importAvail.ts): new templates come in as draft, verified
 * is never set by the import, an unchanged file is not touched, a changed file moves a
 * verified template back to draft, hidden stays hidden, library/hidden.json, idempotency.
 * Also: the real library/avail/ files all load at level A.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { parseHiddenList } from "../../src/avail/libraryFiles";
import { AVAIL_LIBRARY_SOURCE, fileHash, formatImportAvailReport, importAvailLibrary, type AvailLibraryFile } from "../src/importAvail";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = "test-admin-token-0123456789";

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-import-avail-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A level-A template. */
function tpl(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: "60-1885-52",
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

function file(t: Record<string, unknown>, name = "extron-dtp3-t-203.json"): AvailLibraryFile {
  const text = JSON.stringify(t, null, 2) + "\n";
  return { file: name, text, template: JSON.parse(text) };
}

function insertLocal(t: Record<string, unknown>) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}

const meta = (id: string) =>
  api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const libraryVersion = () => (api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version;

async function setStatus(id: string, status: string) {
  const res = await api.fetch(
    new Request(`http://localhost/avail/templates/${id}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  );
  expect(res.status).toBe(200);
}

describe("importAvailLibrary", () => {
  it("inserts a new template as draft with source, hash and lint level", () => {
    const f = file(tpl("avail-dtp3"));
    const r = importAvailLibrary(api.db.sqlite, [f]);
    expect(r).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
    expect(row("avail-dtp3")).toMatchObject({ label: "Extron DTP3 T 203", version: 1 });
    expect(meta("avail-dtp3")).toMatchObject({
      status: "draft",
      source: AVAIL_LIBRARY_SOURCE,
      upstream_id: "avail-dtp3",
      lint_level: "A",
      linted_version: 1,
      source_hash: fileHash(f.text),
      updated_by: "import:avail",
    });
  });

  it("is idempotent: a second run with the same files changes nothing", () => {
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    const v = libraryVersion();
    const before = { row: row("avail-dtp3"), meta: meta("avail-dtp3") };
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    expect(r).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect({ row: row("avail-dtp3"), meta: meta("avail-dtp3") }).toEqual(before);
    expect(libraryVersion()).toBe(v);
  });

  it("never sets verified; a verified template whose file did not change is not touched, even if edited since", async () => {
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    await setStatus("avail-dtp3", "verified");
    // Edited in the editor afterwards (still level A).
    api.db.sqlite.prepare("UPDATE templates SET search_terms = '[\"edited\"]', version = version + 1 WHERE id = 'avail-dtp3'").run();
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    expect(r.unchanged).toBe(1);
    expect(meta("avail-dtp3")).toMatchObject({ status: "verified" });
    expect(row("avail-dtp3")!.search_terms).toBe('["edited"]');
  });

  it("a changed file updates a verified template and moves it to draft with a reason", async () => {
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    await setStatus("avail-dtp3", "verified");
    const v = libraryVersion();
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3", { weightKg: 0.31 }))]);
    expect(r.rows[0]).toMatchObject({ action: "updated", status: "draft", previousStatus: "verified" });
    expect(row("avail-dtp3")).toMatchObject({ weight_kg: 0.31, version: 2 });
    expect(meta("avail-dtp3")).toMatchObject({
      status: "draft",
      linted_version: 2,
      status_reason: "Library file changed (library/avail/extron-dtp3-t-203.json); verify again",
    });
    expect(meta("avail-dtp3")!.status_changed_at).toBeTruthy();
    expect(libraryVersion()).toBeGreaterThan(v);
  });

  it("a verified template keeps its status when only the file formatting changed", async () => {
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    await setStatus("avail-dtp3", "verified");
    const t = tpl("avail-dtp3");
    const reformatted: AvailLibraryFile = { file: "extron-dtp3-t-203.json", text: JSON.stringify(t), template: t };
    const r = importAvailLibrary(api.db.sqlite, [reformatted]);
    expect(r.rows[0]).toMatchObject({ action: "updated", status: "verified", note: "data already matched the file" });
    expect(meta("avail-dtp3")).toMatchObject({ status: "verified", source_hash: fileHash(reformatted.text) });
    expect(row("avail-dtp3")!.version).toBe(1);
  });

  it("takes over a raw template with the same id (existing schematics keep their link) and makes it draft", () => {
    insertLocal({ ...tpl("upstream-uuid"), label: "Extron DTP3 T 203 (raw)", category: "Switching" });
    api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source, upstream_id) VALUES ('upstream-uuid', 'raw', 'easyschematic.live', 'upstream-uuid')").run();
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("upstream-uuid"))]);
    expect(r.rows[0]).toMatchObject({ action: "updated", status: "draft", previousStatus: "raw", id: "upstream-uuid" });
    expect(row("upstream-uuid")).toMatchObject({ label: "Extron DTP3 T 203", category: "AV distribution / Extenders" });
    expect(meta("upstream-uuid")).toMatchObject({ source: AVAIL_LIBRARY_SOURCE, upstream_id: "upstream-uuid" });
  });

  it("matches a template with another id by manufacturer + model", () => {
    insertLocal({ ...tpl("other-id"), searchTerms: [] });
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    expect(r.rows[0]).toMatchObject({ action: "updated", id: "other-id" });
    expect(row("avail-dtp3")).toBeUndefined();
    // Next time it is found by the file id recorded in meta.
    expect(importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]).unchanged).toBe(1);
  });

  it("a hidden template gets the data and stays hidden", async () => {
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]);
    await setStatus("avail-dtp3", "hidden");
    importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3", { weightKg: 0.5 }))]);
    expect(meta("avail-dtp3")).toMatchObject({ status: "hidden" });
    expect(row("avail-dtp3")).toMatchObject({ weight_kg: 0.5 });
  });

  it("dry run writes nothing", () => {
    const r = importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))], { dryRun: true, hidden: [{ id: "x", reason: "dup" }] });
    expect(r.inserted).toBe(1);
    expect(row("avail-dtp3")).toBeUndefined();
    expect(formatImportAvailReport(r, "library/avail")).toContain("dry run, nothing written");
  });

  it("invalid files are reported, not loaded", () => {
    const bad: AvailLibraryFile = { file: "x.json", text: "{}", template: {} };
    const r = importAvailLibrary(api.db.sqlite, [bad]);
    expect(r).toMatchObject({ invalid: 1, inserted: 0 });
  });

  it("library/hidden.json: listed templates become hidden with the reason; missing ones are reported", () => {
    insertLocal({ ...tpl("dup-2"), modelNumber: "AD4Q" });
    const hidden = [{ id: "dup-2", reason: "duplicate of dup-1" }, { id: "nope", reason: "gone" }];
    const r = importAvailLibrary(api.db.sqlite, [], { hidden });
    expect(r.hidden).toEqual([{ id: "dup-2", action: "hidden" }, { id: "nope", action: "missing" }]);
    expect(meta("dup-2")).toMatchObject({ status: "hidden", status_reason: "library/hidden.json: duplicate of dup-1" });
    expect(importAvailLibrary(api.db.sqlite, [], { hidden }).hidden[0]).toEqual({ id: "dup-2", action: "already-hidden" });
  });

  it("library/hidden.json: a template it hid earlier and no longer lists goes back to raw", () => {
    insertLocal({ ...tpl("ad4q-1"), modelNumber: "AD4Q-1" });
    insertLocal({ ...tpl("ad4q-2"), modelNumber: "AD4Q-2" });
    importAvailLibrary(api.db.sqlite, [], { hidden: [{ id: "ad4q-2", reason: "dup" }] });
    expect(meta("ad4q-2")).toMatchObject({ status: "hidden" });
    // The decision is swapped: hide the other instance.
    const r = importAvailLibrary(api.db.sqlite, [], { hidden: [{ id: "ad4q-1", reason: "dup, less complete" }] });
    expect(r.hidden).toEqual([{ id: "ad4q-1", action: "hidden" }, { id: "ad4q-2", action: "unhidden" }]);
    expect(meta("ad4q-1")).toMatchObject({ status: "hidden" });
    expect(meta("ad4q-2")).toMatchObject({ status: "raw", status_reason: "library/hidden.json: no longer listed" });
    // A template hidden by a moderator (other reason) is not touched.
    insertLocal({ ...tpl("mod-hidden"), modelNumber: "MH" });
    api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, status_reason) VALUES ('mod-hidden', 'hidden', NULL)").run();
    importAvailLibrary(api.db.sqlite, [], { hidden: [{ id: "ad4q-1", reason: "dup" }] });
    expect(meta("mod-hidden")).toMatchObject({ status: "hidden" });
  });

  it("the report lists every file with its action", () => {
    const text = formatImportAvailReport(importAvailLibrary(api.db.sqlite, [file(tpl("avail-dtp3"))]), "library/avail");
    expect(text).toContain("Files: 1; inserted 1, updated 0, unchanged 0, invalid 0");
    expect(text).toMatch(/inserted\s+A\s+new → draft\s+extron-dtp3-t-203\.json/);
  });
});

describe("the repository's curated library", () => {
  const dir = path.join(repo, "library/avail");
  const files: AvailLibraryFile[] = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const text = readFileSync(path.join(dir, f), "utf8");
      return { file: f, text, template: JSON.parse(text) };
    });

  it("loads into a fresh database: all draft, all level A, the API accepts them; a second run is a no-op", async () => {
    expect(files.length).toBeGreaterThan(0);
    const hidden = parseHiddenList(JSON.parse(readFileSync(path.join(repo, "library/hidden.json"), "utf8")));
    const r = importAvailLibrary(api.db.sqlite, files, { hidden });
    expect(r.invalid).toBe(0);
    expect(r.inserted).toBe(files.length);
    for (const x of r.rows) expect({ file: x.file, level: x.level, status: x.status }).toEqual({ file: x.file, level: "A", status: "draft" });
    // Every template is served back by the upstream API as it is stored.
    for (const x of r.rows) {
      const res = await api.fetch(new Request(`http://localhost/templates/${encodeURIComponent(x.id)}`));
      expect(res.status, x.file).toBe(200);
    }
    expect(importAvailLibrary(api.db.sqlite, files, { hidden }).unchanged).toBe(files.length);
  });

  it("every file passes upstream's PUT /templates/:id validation (the Edit flow saves through it) and stays level A", async () => {
    importAvailLibrary(api.db.sqlite, files);
    // A real library has cards for the curated chassis' slots (else: W "no card in the library fits").
    const families = new Set(files.flatMap((f) => ((f.template as { slots?: { slotFamily: string }[] }).slots ?? []).map((s) => s.slotFamily)));
    for (const fam of families) {
      insertLocal({ id: `card-${fam}`, label: `Card ${fam}`, deviceType: "expansion-card", category: "", slotFamily: fam, ports: [] });
    }
    for (const f of files) {
      const { id, ...body } = f.template as { id: string };
      const res = await api.fetch(
        new Request(`http://localhost/templates/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status, `${f.file}: ${await res.clone().text()}`).toBe(200);
      expect(meta(id), f.file).toMatchObject({ lint_level: "A", status: "draft" });
    }
  });
});
