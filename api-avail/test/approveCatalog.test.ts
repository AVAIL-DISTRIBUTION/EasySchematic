/**
 * approve:catalog (src/approveCatalog.ts, step 1.11): draft catalog templates at level A whose
 * ports come from the manufacturer's documents become verified (approved_via bulk-source);
 * community ports, no source and level below A stay draft; verified, hidden and the curated
 * library are untouched. Migration 9006 keeps every meta column. The library route marks the
 * ports origin.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveCatalog, formatApproveCatalogReport } from "../src/approveCatalog";
import type { CatalogFileText } from "../src/catalogFiles";
import { importCatalog } from "../src/importCatalog";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import type { DeletedTemplatesFile } from "../src/vendorResponses";

const ADMIN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-approve-catalog-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const NO_DELETED: DeletedTemplatesFile = { version: 1, templates: [] };

/** A level-A catalog card; `n` makes the id, model and part number unique. */
function card(n: number, portsSource: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
  return {
    id: `avail-extron-60-1885-${n}`,
    label: `Extron DTP3 T ${200 + n}`,
    shortName: `DTP3 T ${200 + n}`,
    manufacturer: "Extron",
    modelNumber: `60-1885-${n}`,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: [`60-1885-${n}`],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC",
    _avail: { status: "ports-filled", ...(portsSource ? { portsSource } : {}) },
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "12V DC In", signalType: "power", direction: "input", section: "Power", connectorType: "phoenix" },
    ],
    ...over,
  };
}

function file(t: { id: string }, name: string): CatalogFileText {
  const text = JSON.stringify(t, null, 2);
  return { file: name, text, template: JSON.parse(text) };
}

const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

function load() {
  const files = [
    file(card(1, { kind: "stencil", from: "DTP - DTP3 Transmitters Eng.vssx" }), "extron/a-stencil.json"),
    file(card(2, { kind: "datasheet", from: "https://www.extron.com/x.pdf" }), "extron/b-datasheet.json"),
    file(card(3, { kind: "db", from: "community-id" }), "extron/c-db.json"),
    file(card(4, { kind: "variant", from: "extron/b-datasheet.json" }), "extron/d-variant-datasheet.json"),
    file(card(5, { kind: "variant", from: "extron/c-db.json" }), "extron/e-variant-db.json"),
    file(card(6, undefined), "extron/f-no-source.json"),
    // Level B: no searchTerms.
    file(card(7, { kind: "stencil", from: "x.vssx" }, { searchTerms: [] }), "extron/g-level-b.json"),
    file(card(8, { kind: "library", from: "extron-dtp3-t-208.json" }), "extron/h-library.json"),
  ];
  const r = importCatalog(api.db.sqlite, files, { deletedList: NO_DELETED, minLevel: "B" });
  expect(r.counts.inserted).toBe(8);
}

describe("migration 9006", () => {
  it("approved_via accepts bulk-source; the meta columns are all there", () => {
    const cols = (api.db.sqlite.prepare("PRAGMA table_info(avail_template_meta)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "template_id", "status", "source", "upstream_id", "lint_level", "updated_by", "updated_at", "linted_version",
      "status_reason", "status_changed_at", "source_hash", "approved_via", "approved_at", "catalog", "approved_by", "lifecycle", "available_from", "eol_date",
    ]);
    load();
    expect(() => api.db.sqlite.prepare("UPDATE avail_template_meta SET approved_via = 'bulk-source' WHERE template_id = ?").run("avail-extron-60-1885-1")).not.toThrow();
    expect(() => api.db.sqlite.prepare("UPDATE avail_template_meta SET approved_via = 'other' WHERE template_id = ?").run("avail-extron-60-1885-1")).toThrow();
  });
});

describe("approve:catalog", () => {
  it("dry run approves nothing and reports what it would do", () => {
    load();
    const r = approveCatalog(api.db.sqlite, { dryRun: true });
    expect(r.rows.filter((x) => x.result === "approved").map((x) => x.id)).toEqual([
      "avail-extron-60-1885-1", "avail-extron-60-1885-2", "avail-extron-60-1885-4", "avail-extron-60-1885-8",
    ]);
    expect(meta("avail-extron-60-1885-1").status).toBe("draft");
    const text = formatApproveCatalogReport(r);
    expect(text).toContain("would approve 4, left for review 4");
    expect(text).toMatch(/source db\s+1/);
    expect(text).toMatch(/variant of db\s+1/);
    expect(text).toMatch(/no source\s+1/);
    expect(text).toMatch(/level B\s+1/);
  });

  it("approves manufacturer sources with bulk-source and the document in the reason; the rest stays draft", () => {
    load();
    const before = (api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version;
    approveCatalog(api.db.sqlite);
    expect(meta("avail-extron-60-1885-1")).toMatchObject({
      status: "verified",
      approved_via: "bulk-source",
      status_reason: "approved by source: ports from stencil (DTP - DTP3 Transmitters Eng.vssx)",
      updated_by: "approve-catalog",
    });
    expect(meta("avail-extron-60-1885-4").status_reason).toBe(
      "approved by source: ports from datasheet (https://www.extron.com/x.pdf) via variant extron/b-datasheet.json",
    );
    for (const n of [3, 5, 6, 7]) expect(meta(`avail-extron-60-1885-${n}`).status).toBe("draft");
    expect((api.db.sqlite.prepare("SELECT version FROM library_meta WHERE id = 1").get() as { version: number }).version).toBe(before + 1);
    // Second run: nothing left to approve.
    expect(approveCatalog(api.db.sqlite).rows.filter((x) => x.result === "approved")).toEqual([]);
  });

  it("verified, hidden and curated templates are not touched", () => {
    load();
    api.db.sqlite.prepare("UPDATE avail_template_meta SET status = 'hidden' WHERE template_id = ?").run("avail-extron-60-1885-1");
    api.db.sqlite.prepare("UPDATE avail_template_meta SET status = 'verified', approved_via = 'review' WHERE template_id = ?").run("avail-extron-60-1885-2");
    api.db.sqlite.prepare("UPDATE avail_template_meta SET source = 'avail-library' WHERE template_id = ?").run("avail-extron-60-1885-8");
    const r = approveCatalog(api.db.sqlite);
    expect(r.rows.map((x) => x.id)).not.toContain("avail-extron-60-1885-1");
    expect(meta("avail-extron-60-1885-1").status).toBe("hidden");
    expect(meta("avail-extron-60-1885-2")).toMatchObject({ status: "verified", approved_via: "review" });
    expect(meta("avail-extron-60-1885-8")).toMatchObject({ status: "draft", source: "avail-library" });
  });

  it("the library marks each template's ports origin and level", async () => {
    load();
    const res = await api.fetch(new Request("http://api.internal/avail/library/summary"));
    const list = (await res.json()) as { id: string; availPortsOrigin: string; availLevel?: string }[];
    const by = (n: number) => list.find((t) => t.id === `avail-extron-60-1885-${n}`)!;
    expect(by(1).availPortsOrigin).toBe("manufacturer");
    expect(by(3).availPortsOrigin).toBe("community");
    expect(by(4).availPortsOrigin).toBe("manufacturer");
    expect(by(5).availPortsOrigin).toBe("community");
    expect(by(6).availPortsOrigin).toBe("none");
    expect(by(7).availLevel).toBe("B");
  });
});
