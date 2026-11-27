/**
 * No prices from the catalog into the database: import:catalog drops unitCost
 * (src/importCatalog.ts), clear:catalog-prices empties the ones an earlier load left
 * (src/clearCatalogPrices.ts) with one audit entry per run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { writeRunAudit } from "../src/audit";
import type { CatalogFileText } from "../src/catalogFiles";
import { clearCatalogPrices, clearPricesRunCounts, formatClearCatalogPricesReport } from "../src/clearCatalogPrices";
import { AVAIL_CATALOG_SOURCE, importCatalog } from "../src/importCatalog";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import type { DeletedTemplatesFile } from "../src/vendorResponses";

const ADMIN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-catalog-prices-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const NO_DELETED: DeletedTemplatesFile = { version: 1, templates: [] };

function card(over: Record<string, unknown> = {}) {
  return {
    id: "avail-extron-60-1885-52", label: "Extron DTP3 T 203", shortName: "DTP3 T 203", manufacturer: "Extron", modelNumber: "60-1885-52",
    deviceType: "hdbaset-extender", category: "AV distribution / Extenders", auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    referenceUrl: "https://www.extron.com/product/dtp3t203", searchTerms: ["60-1885-52"], heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC", rackForm: "half",
    _avail: { status: "ports-filled", portsSource: { kind: "datasheet", from: "x" } },
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
    ],
    ...over,
  };
}
const file = (t: Record<string, unknown>): CatalogFileText => {
  const text = JSON.stringify(t, null, 2);
  return { file: "extron/extron-dtp3-t-203.json", text, template: JSON.parse(text) };
};
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown>;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("catalog prices", () => {
  it("import:catalog does not write a price from the file (nor a nested one into meta.catalog)", () => {
    importCatalog(api.db.sqlite, [file(card({ unitCost: 999, _avail: { status: "ports-filled", msrp: 5 } }))], { deletedList: NO_DELETED });
    expect(row("avail-extron-60-1885-52").unit_cost).toBeNull();
    expect(JSON.parse(meta("avail-extron-60-1885-52").catalog as string)).not.toHaveProperty("msrp");
  });

  it("a price left by an earlier load is not a data change: verified stays verified", () => {
    importCatalog(api.db.sqlite, [file(card())], { deletedList: NO_DELETED });
    api.db.sqlite.prepare("UPDATE templates SET unit_cost = 100 WHERE id = ?").run("avail-extron-60-1885-52");
    api.db.sqlite.prepare("UPDATE avail_template_meta SET status = 'verified', source_hash = 'old' WHERE template_id = ?").run("avail-extron-60-1885-52");
    const r = importCatalog(api.db.sqlite, [file(card())], { deletedList: NO_DELETED });
    expect(r.rows[0]).toMatchObject({ action: "updated", status: "verified", note: "data already matched the file" });
  });

  it("clear:catalog-prices empties catalog prices only; dry run writes nothing; one audit entry", () => {
    importCatalog(api.db.sqlite, [file(card())], { deletedList: NO_DELETED });
    api.db.sqlite.prepare("UPDATE templates SET unit_cost = 100 WHERE id = ?").run("avail-extron-60-1885-52");
    api.db.sqlite.prepare("UPDATE avail_template_meta SET status = 'verified' WHERE template_id = ?").run("avail-extron-60-1885-52");
    const other = templateToRow({ id: "community", label: "Other X", deviceType: "speaker", category: "", ports: [], unitCost: 50 } as never);
    const cols = Object.keys(other);
    api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(other);

    const dry = clearCatalogPrices(api.db.sqlite, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, byManufacturer: { Extron: 1 }, otherWithPrice: 1 });
    expect(row("avail-extron-60-1885-52").unit_cost).toBe(100);
    expect(formatClearCatalogPricesReport(dry)).toContain("Would clear unitCost on 1 catalog templates");

    const version = row("avail-extron-60-1885-52").version as number;
    const r = clearCatalogPrices(api.db.sqlite);
    expect(r.cleared.map((x) => x.id)).toEqual(["avail-extron-60-1885-52"]);
    expect(row("avail-extron-60-1885-52")).toMatchObject({ unit_cost: null, version: version + 1 });
    expect(meta("avail-extron-60-1885-52")).toMatchObject({ status: "verified", source: AVAIL_CATALOG_SOURCE });
    expect(row("community").unit_cost).toBe(50);
    writeRunAudit(api.db.sqlite, { command: "clear:catalog-prices", counts: clearPricesRunCounts(r) });
    const audit = api.db.sqlite.prepare("SELECT * FROM avail_audit_log WHERE action = 'run'").all() as Record<string, unknown>[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].after as string)).toMatchObject({ command: "clear:catalog-prices", counts: { cleared: 1, otherWithPrice: 1 } });
    expect(clearCatalogPrices(api.db.sqlite).cleared).toEqual([]);
  });
});
