/**
 * Raw-template import (src/importUpstream.ts): vendor normalization, AVAIL category,
 * duplicates by manufacturer + model, status rules, idempotency and the report.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { templateToRow } from "../../api/src/db";
import {
  dedupeKey,
  fetchUpstreamTemplates,
  formatImportReport,
  importTemplates,
  normalizeTemplate,
  type UpstreamTemplate,
} from "../src/importUpstream";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-import-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const POWER = { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };

function up(id: string, over: Partial<UpstreamTemplate> = {}): UpstreamTemplate {
  return {
    id,
    version: 3,
    deviceType: "audio-dsp",
    category: "Audio",
    label: `Biamp ${id}`,
    manufacturer: "Biamp",
    modelNumber: `M-${id}`,
    ports: [POWER],
    ...over,
  };
}

function localTemplate(id: string, over: Record<string, unknown> = {}) {
  const row = templateToRow({ id, label: `Local ${id}`, deviceType: "switcher", category: "Switching", ports: [], ...over } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}

function setStatus(id: string, status: string) {
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, 'avail')").run(id, status);
}

const template = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;
const count = (table: string) => (api.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const libraryVersion = () => (api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version;

describe("normalization", () => {
  it("manufacturer → canonical name; category from deviceTypeDefaults, source category dropped", () => {
    expect(normalizeTemplate(up("a", { manufacturer: "Biamp Systems" }))).toMatchObject({
      manufacturer: "Biamp",
      category: "Audio Products / DSP",
    });
    expect(normalizeTemplate(up("a", { manufacturer: "Blackmagic Design", deviceType: "camera" }))).toMatchObject({
      manufacturer: "Blackmagic Design",
      category: null,
    });
    expect(normalizeTemplate(up("a", { deviceType: "no-such-type" })).category).toBeNull();
    expect(normalizeTemplate(up("a", { manufacturer: "  " }))).not.toHaveProperty("manufacturer");
  });

  it("duplicate key: canonical manufacturer + modelNumber (label without one), case and spacing ignored", () => {
    expect(dedupeKey({ manufacturer: "WYRESTORM", modelNumber: "NHD-500-TX", label: "x" })).toBe(
      dedupeKey({ manufacturer: "WyreStorm", modelNumber: " nhd-500-tx ", label: "y" }),
    );
    expect(dedupeKey({ manufacturer: "Shure", label: "MXA  920" })).toBe(dedupeKey({ manufacturer: "shure", modelNumber: "", label: "mxa 920" }));
    expect(dedupeKey({ manufacturer: "Shure", modelNumber: "A", label: "" })).not.toBe(dedupeKey({ manufacturer: "Biamp", modelNumber: "A", label: "" }));
  });
});

describe("importTemplates", () => {
  it("inserts as raw with source, upstream id and lint level", () => {
    const r = importTemplates(api.db.sqlite, [up("a")]);
    expect(r).toMatchObject({ received: 1, imported: 1, inserted: 1, updated: 0, unchanged: 0 });
    expect(template("a")).toMatchObject({ manufacturer: "Biamp", category: "Audio Products / DSP", version: 3, label: "Biamp a" });
    expect(meta("a")).toMatchObject({ status: "raw", source: "easyschematic.live", upstream_id: "a", lint_level: "B", updated_by: "import" });
  });

  it("no duplicates by manufacturer + model within the source (first wins)", () => {
    const r = importTemplates(api.db.sqlite, [up("a", { manufacturer: "Biamp", modelNumber: "TCM-X" }), up("b", { manufacturer: "biamp systems", modelNumber: "tcm-x" })]);
    expect(r).toMatchObject({ received: 2, duplicates: 1, imported: 1 });
    expect(template("b")).toBeUndefined();
  });

  it("matches a local template by manufacturer + model and keeps its id", () => {
    localTemplate("ours-1", { manufacturer: "Biamp Systems", modelNumber: "M-a" });
    const r = importTemplates(api.db.sqlite, [up("a")]);
    expect(r).toMatchObject({ inserted: 0, updated: 1 });
    expect(count("templates")).toBe(1);
    expect(template("ours-1")).toMatchObject({ manufacturer: "Biamp", label: "Biamp a" });
    expect(meta("ours-1")).toMatchObject({ status: "raw", upstream_id: "a" });
  });

  it("matches the seeded copy by id even when the source renamed it", () => {
    localTemplate("a", { manufacturer: "Biamp", modelNumber: "OLD" });
    importTemplates(api.db.sqlite, [up("a", { modelNumber: "NEW" })]);
    expect(count("templates")).toBe(1);
    expect(template("a")).toMatchObject({ model_number: "NEW" });
  });

  it("a renamed row frees its old pair for a later source template (stable on rerun)", () => {
    localTemplate("a", { manufacturer: "Biamp", modelNumber: "OLD" });
    const source = [up("a", { modelNumber: "NEW" }), up("c", { modelNumber: "OLD" })];
    expect(importTemplates(api.db.sqlite, source)).toMatchObject({ inserted: 1, updated: 1, duplicates: 0 });
    expect(importTemplates(api.db.sqlite, source)).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, duplicates: 0 });
    expect(count("templates")).toBe(2);
  });

  it("never touches verified and draft templates", () => {
    localTemplate("v", { manufacturer: "Biamp", modelNumber: "M-a", label: "Verified by us" });
    setStatus("v", "verified");
    localTemplate("d");
    setStatus("d", "draft");
    const before = { v: template("v"), d: template("d"), mv: meta("v"), md: meta("d") };
    const r = importTemplates(api.db.sqlite, [up("a"), up("d", { modelNumber: "Other" })]);
    expect(r).toMatchObject({ skippedProtected: 2, imported: 0, inserted: 0 });
    expect({ v: template("v"), d: template("d"), mv: meta("v"), md: meta("d") }).toEqual(before);
  });

  it("a later source template with a protected template's pair is a duplicate, not a copy", () => {
    localTemplate("a", { manufacturer: "Biamp", modelNumber: "KEEP" });
    setStatus("a", "verified");
    const r = importTemplates(api.db.sqlite, [up("a", { modelNumber: "RENAMED" }), up("x", { modelNumber: "KEEP" })]);
    expect(r).toMatchObject({ skippedProtected: 1, duplicates: 1, inserted: 0 });
    expect(count("templates")).toBe(1);
  });

  it("hidden templates get fresh data but stay hidden", () => {
    localTemplate("a", { manufacturer: "Biamp", modelNumber: "M-a" });
    setStatus("a", "hidden");
    const r = importTemplates(api.db.sqlite, [up("a")]);
    expect(r).toMatchObject({ updated: 1, keptHidden: 1 });
    expect(template("a")).toMatchObject({ label: "Biamp a" });
    expect(meta("a")).toMatchObject({ status: "hidden", upstream_id: "a" });
  });

  it("is idempotent: a second run changes nothing, not even updated_at or the library ETag", () => {
    const source = [up("a"), up("b", { manufacturer: "Netgear", deviceType: "network-switch", modelNumber: "GSM4230PX" }), up("c", { deviceType: "camera" })];
    expect(importTemplates(api.db.sqlite, source)).toMatchObject({ inserted: 3 });
    const snapshot = {
      templates: api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all(),
      meta: api.db.sqlite.prepare("SELECT * FROM avail_template_meta ORDER BY template_id").all(),
      version: libraryVersion(),
    };
    expect(importTemplates(api.db.sqlite, source)).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, imported: 3 });
    expect({
      templates: api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all(),
      meta: api.db.sqlite.prepare("SELECT * FROM avail_template_meta ORDER BY template_id").all(),
      version: libraryVersion(),
    }).toEqual(snapshot);
  });

  it("changed source data updates the row and rolls the library ETag", () => {
    importTemplates(api.db.sqlite, [up("a")]);
    const v = libraryVersion();
    expect(importTemplates(api.db.sqlite, [up("a", { label: "Biamp a2" })])).toMatchObject({ updated: 1 });
    expect(template("a")).toMatchObject({ label: "Biamp a2" });
    expect(libraryVersion()).toBe(v + 1);
  });

  it("skips malformed entries", () => {
    const r = importTemplates(api.db.sqlite, [null, { id: "x" }, up("a", { ports: undefined as never }), up("b")]);
    expect(r).toMatchObject({ received: 4, invalid: 3, imported: 1 });
  });

  it("dry run reports but writes nothing", () => {
    const r = importTemplates(api.db.sqlite, [up("a")], { dryRun: true });
    expect(r).toMatchObject({ inserted: 1, dryRun: true });
    expect(count("templates")).toBe(0);
    expect(count("avail_template_meta")).toBe(0);
  });

  it("report: our vendors, skipped by vendor decisions, no category, A/B/FIX", () => {
    const r = importTemplates(api.db.sqlite, [
      up("a", { manufacturer: "WYRESTORM", deviceType: "switcher" }),
      up("b", { manufacturer: "Sharp NEC", deviceType: "monitor" }),
      up("c", { manufacturer: "Blackmagic Design", deviceType: "camera" }),
      up("d", { manufacturer: "AJA", deviceType: "converter" }),
      up("e", { manufacturer: "Yamaha Pro Audio", deviceType: "frame" }),
      up("f", { manufacturer: undefined, deviceType: "frame" }),
    ]);
    expect(r.ourVendors).toMatchObject({ WyreStorm: 1, Sharp: 1, Yamaha: 1, Extron: 0 });
    expect(r.otherVendors).toEqual({ templates: 0, manufacturers: 0 });
    expect(r).toMatchObject({ imported: 3, noManufacturer: 0, noCategory: 1 });
    expect(r.skipped).toEqual({ noManufacturer: 1, notDecided: 2, scope: 0, genericExists: 0, genericPlan: 0 });
    expect(r.levels.A + r.levels.B + r.levels.FIX).toBe(3);

    const text = formatImportReport(r, "https://api.easyschematic.live/templates");
    expect(text).toContain("Imported: 3; new 3, updated 0, unchanged 0");
    expect(text).toContain("AVAIL vendors: 3");
    expect(text).toMatch(/ {2}WyreStorm +1\n/);
    expect(text).toContain("Skipped by vendor decisions: no manufacturer 1, manufacturer not decided 2, outside scope 0, Generic of the type exists 0, deleted by the Generic plan 0");
    expect(text).toContain("No category: 1");
    expect(text).toMatch(/Standard levels: A \d+ \/ B \d+ \/ FIX \d+/);
  });
});

describe("importTemplates: vendor decisions", () => {
  it("renames to the canonical spelling (rename map and aliases)", () => {
    importTemplates(api.db.sqlite, [
      up("y", { manufacturer: "Yamaha Pro Audio", label: "Yamaha Pro Audio QL1" }),
      up("ah", { manufacturer: "Allen and Heath" }),
      up("bo", { manufacturer: "Bose", deviceType: "speaker" }),
      up("ch", { manufacturer: "Chauvet", deviceType: "led-fixture" }),
      up("ng", { manufacturer: "Netgear", deviceType: "network-switch", modelNumber: "XSM4316" }),
    ]);
    expect(template("y")!.manufacturer).toBe("Yamaha");
    expect(template("ah")!.manufacturer).toBe("Allen & Heath");
    expect(template("bo")!.manufacturer).toBe("Bose Professional");
    expect(template("ch")!.manufacturer).toBe("Chauvet Professional");
    expect(template("ng")!.manufacturer).toBe("NETGEAR");
  });

  it("scope: Sony only system cameras, NETGEAR only AV Line models", () => {
    const r = importTemplates(api.db.sqlite, [
      up("s1", { manufacturer: "Sony", deviceType: "ptz-camera" }),
      up("s2", { manufacturer: "Sony", deviceType: "tv" }),
      up("n1", { manufacturer: "NETGEAR", deviceType: "network-switch", modelNumber: "GSM4230PX" }),
      up("n2", { manufacturer: "NETGEAR", deviceType: "network-switch", modelNumber: "VSM4320C", label: "NETGEAR M4350-16V4C" }),
      up("n3", { manufacturer: "NETGEAR", deviceType: "access-point", modelNumber: "WAX610", label: "NETGEAR WAX610" }),
    ]);
    expect(r.skipped.scope).toBe(2);
    expect(template("s1")).toBeDefined();
    expect(template("s2")).toBeUndefined();
    expect(template("n1")).toBeDefined();
    expect(template("n2")).toBeDefined(); // matched by the label without the manufacturer
    expect(template("n3")).toBeUndefined();
  });

  it("generic brands: one Generic <type> per type, only when none exists", () => {
    const r = importTemplates(api.db.sqlite, [
      up("sm1", { manufacturer: "Samsung", deviceType: "display", label: "Samsung QM55C", referenceUrl: "https://samsung.com/x", heightMm: 700 }),
      up("sm2", { manufacturer: "SAMSUNG", deviceType: "display", label: "Samsung QM65C" }),
      up("lg", { manufacturer: "Logitech", deviceType: "video-bar", label: "Logitech Rally Bar" }),
    ]);
    expect(r.genericCreated).toEqual(["Generic Display", "Generic Video Bar"]);
    expect(r.skipped.genericExists).toBe(1);
    expect(template("sm1")).toMatchObject({ manufacturer: "Generic", label: "Generic Display", model_number: "GEN-DISPLAY", reference_url: null, height_mm: null });
    expect(template("sm2")).toBeUndefined();
  });
});

describe("fetchUpstreamTemplates", () => {
  it("GETs the public library", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([up("a")]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchUpstreamTemplates()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.easyschematic.live/templates", expect.anything());
  });

  it("fails on HTTP errors and non-array bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(fetchUpstreamTemplates()).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(fetchUpstreamTemplates()).rejects.toThrow(/array/);
  });
});
