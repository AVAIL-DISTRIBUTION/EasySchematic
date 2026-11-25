/**
 * Product catalog import (src/importCatalog.ts, step 1.9): only level A files, match by
 * manufacturer + part number, new → draft, _avail and rackForm into avail_template_meta.catalog,
 * curated library and deleted-templates.json respected, SQT-1-style removal by part number,
 * idempotency; import:upstream leaves catalog rows alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import type { CatalogFileText } from "../src/catalogFiles";
import { lintBlock } from "../../src/avail/blockLint";
import { AVAIL_CATALOG_SOURCE, formatImportCatalogReport, importCatalog, parseMinLevel, partKey } from "../src/importCatalog";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import type { DeletedTemplatesFile } from "../src/vendorResponses";

const ADMIN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-import-catalog-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A level-A catalog card with ports. */
function card(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
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
    _avail: { status: "ports-filled", description: "DTP3 transmitter", portsSource: { kind: "db", from: "x" } },
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
    ],
    ...over,
  };
}

function file(t: Record<string, unknown>, name = "extron/extron-dtp3-t-203.json"): CatalogFileText {
  const text = JSON.stringify(t, null, 2);
  return { file: name, text, template: JSON.parse(text) };
}

function insertLocal(t: Record<string, unknown>, status?: string, source?: string) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  if (status) api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, ?)").run(t.id, status, source ?? null);
}

const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const NO_DELETED: DeletedTemplatesFile = { version: 1, templates: [] };

describe("import:catalog", () => {
  it("creates a draft from a level A file; _avail and rackForm go to meta.catalog", () => {
    const r = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52"))], { deletedList: NO_DELETED });
    expect(r.counts.inserted).toBe(1);
    expect(row("avail-extron-60-1885-52")).toMatchObject({ model_number: "60-1885-52", height_mm: 25 });
    const m = meta("avail-extron-60-1885-52")!;
    expect(m).toMatchObject({ status: "draft", source: AVAIL_CATALOG_SOURCE, upstream_id: "avail-extron-60-1885-52", lint_level: "A" });
    expect(JSON.parse(m.catalog as string)).toEqual({
      file: "extron/extron-dtp3-t-203.json", rackForm: "half", status: "ports-filled", description: "DTP3 transmitter", portsSource: { kind: "db", from: "x" },
    });
    expect(Object.keys(JSON.parse(row("avail-extron-60-1885-52")!.ports as string)[0])).not.toContain("_avail");
  });

  it("loads A and B by default; FIX (a file without ports) stays in the catalog", () => {
    const b = card("avail-extron-b", { modelNumber: "60-b", label: "Extron DTP3 T 203 B", searchTerms: [] });
    expect(lintBlock(b).level).toBe("B");
    const r = importCatalog(
      api.db.sqlite,
      [file(card("avail-extron-1", { ports: [] }), "extron/fix.json"), file(b, "extron/b.json"), file(card("avail-extron-60-1885-52"))],
      { deletedList: NO_DELETED },
    );
    expect(r.minLevel).toBe("B");
    expect(r.rows.map((x) => [x.level, x.action])).toEqual([["FIX", "below-min"], ["B", "inserted"], ["A", "inserted"]]);
    expect(r.loadedByLevel).toEqual({ A: 1, B: 1 });
    expect(meta("avail-extron-b")).toMatchObject({ status: "draft", lint_level: "B" });
    expect(row("avail-extron-1")).toBeUndefined();
    expect(formatImportCatalogReport(r, "library/catalog")).toContain("In the database from the catalog: A 1, B 1");
  });

  it("--min-level A keeps B in the catalog", () => {
    const b = card("avail-extron-b", { modelNumber: "60-b", label: "Extron DTP3 T 203 B", searchTerms: [] });
    const r = importCatalog(api.db.sqlite, [file(b, "extron/b.json")], { deletedList: NO_DELETED, minLevel: "A" });
    expect(r.rows[0]).toMatchObject({ action: "below-min", note: "level B: stays in the catalog (minimum A)" });
    expect(row("avail-extron-b")).toBeUndefined();
    expect(parseMinLevel(undefined)).toBe("B");
    expect(parseMinLevel("a")).toBe("A");
    expect(() => parseMinLevel("FIX")).toThrow("--min-level must be A or B");
  });

  it("a verified template whose catalog file is at level B goes to draft", () => {
    insertLocal(card("v"), "verified");
    const r = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52", { searchTerms: [] }))], { deletedList: NO_DELETED });
    expect(r.rows[0]).toMatchObject({ action: "updated", level: "B", status: "draft", previousStatus: "verified" });
  });

  it("updates the template with the same manufacturer + part number, keeping its id", () => {
    insertLocal({ ...card("old-id"), label: "Extron DTP3 T 203 old", ports: [] }, "raw", "easyschematic.live");
    const r = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52"))], { deletedList: NO_DELETED });
    expect(r.rows[0]).toMatchObject({ action: "updated", id: "old-id", status: "draft", previousStatus: "raw" });
    expect(row("old-id")).toMatchObject({ label: "Extron DTP3 T 203", version: 2 });
    expect(row("avail-extron-60-1885-52")).toBeUndefined();
  });

  it("an alternative part number matches too; another part number does not", () => {
    insertLocal({ ...card("kit"), modelNumber: "70-1-01" }, "raw");
    const f = card("avail-extron-60-1", { modelNumber: "60-1", _avail: { altPartNumber: "70-1-01" } });
    expect(importCatalog(api.db.sqlite, [file(f)], { deletedList: NO_DELETED }).rows[0]).toMatchObject({ action: "updated", id: "kit" });
    expect(partKey("Extron", " 60-1 ")).toBe("extron|60-1");
  });

  it("verified stays verified when nothing changed, goes to draft with a reason when the file changed", () => {
    insertLocal(card("v"), "verified");
    const same = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52"))], { deletedList: NO_DELETED });
    expect(same.rows[0]).toMatchObject({ action: "updated", status: "verified", note: "data already matched the file" });
    const changed = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52", { weightKg: 0.4 }))], { deletedList: NO_DELETED });
    expect(changed.rows[0]).toMatchObject({ action: "updated", status: "draft", previousStatus: "verified" });
    expect(meta("v")!.status_reason).toBe("Catalog file changed (library/catalog/extron/extron-dtp3-t-203.json); verify again");
  });

  it("hidden stays hidden", () => {
    insertLocal(card("h"), "hidden");
    expect(importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52", { weightKg: 1 }))], { deletedList: NO_DELETED }).rows[0]).toMatchObject({ status: "hidden" });
  });

  it("never touches the curated library", () => {
    insertLocal(card("lib"), "verified", "avail-library");
    const r = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52", { weightKg: 1 }))], { deletedList: NO_DELETED });
    expect(r.rows[0]).toMatchObject({ action: "curated" });
    expect(row("lib")!.weight_kg).toBe(0.3);
    // Not in the database yet, but library/avail has the part number.
    const r2 = importCatalog(api.db.sqlite, [file(card("avail-extron-9", { modelNumber: "60-9" }))], {
      deletedList: NO_DELETED,
      curated: [{ id: "extron-x", manufacturer: "Extron", modelNumber: "60-9" }],
    });
    expect(r2.rows[0].action).toBe("curated");
  });

  it("respects deleted-templates.json and removes entries with a part number (Biamp SQT-1)", () => {
    insertLocal({ ...card("sqt"), manufacturer: "Biamp", label: "Biamp SQT-1", modelNumber: "SQT-1" }, "raw");
    insertLocal({ ...card("sqt2"), manufacturer: "Biamp", label: "Biamp Sonet", modelNumber: "910-00071" }, "raw");
    const deletedList: DeletedTemplatesFile = {
      version: 1,
      templates: [{ id: "avail-biamp-910-00071", vendor: "Biamp", model: "SQT-1", partNumber: "910-00071", reason: "not ours" }],
    };
    const sqtCard = card("avail-biamp-910-00071", { manufacturer: "Biamp", label: "Biamp SQT-1", modelNumber: "910-00071" });
    const r = importCatalog(api.db.sqlite, [file(sqtCard, "biamp/biamp-sqt-1.json")], { deletedList });
    expect(r.removed.map((x) => x.id).sort()).toEqual(["sqt", "sqt2"]);
    expect(row("sqt")).toBeUndefined();
    expect(meta("sqt2")).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ action: "deleted" });
    expect(row("avail-biamp-910-00071")).toBeUndefined();
  });

  it("is idempotent", () => {
    const f = file(card("avail-extron-60-1885-52"));
    importCatalog(api.db.sqlite, [f], { deletedList: NO_DELETED });
    const v = (api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version;
    const second = importCatalog(api.db.sqlite, [f], { deletedList: NO_DELETED });
    expect(second.counts).toMatchObject({ unchanged: 1, inserted: 0, updated: 0 });
    expect(second.superseded).toEqual([]);
    expect((api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version).toBe(v);
  });

  it("hides raw templates of a model the catalog brought, lists verified and draft", () => {
    const biamp = (id: string, label: string, modelNumber: string) => ({ ...card(id), manufacturer: "Biamp", label, modelNumber });
    insertLocal(biamp("base", "Biamp Desono C-IC6", "C-IC6"), "raw");
    insertLocal(biamp("other-colour", "Biamp Desono C-IC6 White", "C-IC6-W"), "raw");
    insertLocal(biamp("checked", "Biamp Desono C-IC6", "C-IC6 old"), "verified");
    insertLocal(biamp("work", "Biamp Desono C-IC6 Black", "X"), "draft");
    insertLocal(biamp("own-file", "Biamp Desono C-IC6 Grey", "910-3"), "raw"); // its own catalog file, still below A
    insertLocal(biamp("unrelated", "Biamp Desono C-IC6LP", "C-IC6LP"), "raw");
    const black = file(card("avail-biamp-910-1", { manufacturer: "Biamp", label: "Biamp Desono C-IC6 Black", modelNumber: "910-1" }), "biamp/biamp-desono-c-ic6-black.json");
    const grey = file(card("avail-biamp-910-3", { manufacturer: "Biamp", label: "Biamp Desono C-IC6 Grey", modelNumber: "910-3", ports: [] }), "biamp/biamp-desono-c-ic6-grey.json");
    const r = importCatalog(api.db.sqlite, [black, grey], { deletedList: NO_DELETED });
    expect(r.superseded.map((x) => [x.id, x.action]).sort()).toEqual([
      ["base", "hidden"], ["checked", "listed"], ["other-colour", "hidden"], ["work", "listed"],
    ]);
    expect(meta("base")).toMatchObject({ status: "hidden", status_reason: "superseded by catalog (library/catalog/biamp/biamp-desono-c-ic6-black.json)" });
    expect(meta("checked")!.status).toBe("verified");
    expect(meta("own-file")!.status).toBe("raw");
    expect(meta("unrelated")!.status).toBe("raw");
    // Second run: nothing more to hide.
    expect(importCatalog(api.db.sqlite, [black, grey], { deletedList: NO_DELETED }).superseded.filter((x) => x.action === "hidden")).toEqual([]);
  });

  it("dry run writes nothing", () => {
    const r = importCatalog(api.db.sqlite, [file(card("avail-extron-60-1885-52"))], { dryRun: true, deletedList: NO_DELETED });
    expect(r.counts.inserted).toBe(1);
    expect(row("avail-extron-60-1885-52")).toBeUndefined();
  });

  it("two files on one template: the second is a duplicate", () => {
    insertLocal(card("one"), "raw");
    const a = file(card("avail-extron-a"), "extron/a.json");
    const b = file(card("avail-extron-b", { label: "Extron DTP3 T 203 B" }), "extron/b.json");
    expect(importCatalog(api.db.sqlite, [a, b], { deletedList: NO_DELETED }).rows.map((x) => x.action)).toEqual(["updated", "duplicate"]);
  });
});
