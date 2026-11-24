/**
 * Phase 1.7 on the API side: export:worklist, relintAll with the slot context, Sony decisions in
 * the apply:vendor-decisions report, the normalize:library report of slot families without cards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { formatNormalizeReport, normalizeLibrary } from "../src/normalizeLibrary";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { relintAll } from "../src/templateMeta";
import { applyVendorDecisions, formatVendorCleanupReport } from "../src/vendorCleanup";
import { buildWorklist, worklistCsv } from "../src/worklist";

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-slots-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const POWER = { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };
function insert(t: Record<string, unknown>, status = "raw") {
  const row = templateToRow({ category: "", ports: [POWER], ...t } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status) VALUES (?, ?)").run(t.id, status);
}
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("export:worklist", () => {
  it("B and FIX templates of our vendors, top 3 issues, sorted by vendor then FIX first; CSV with BOM and quoting", () => {
    insert({ id: "ex-fix", label: "Extron Z, \"quoted\"", manufacturer: "Extron", deviceType: "switcher" });
    insert({ id: "ex-b", label: "Extron A", manufacturer: "Extron", modelNumber: "60-1", deviceType: "switcher", category: "AV distribution / Switchers", ports: [{ ...POWER }] });
    insert({ id: "bi", label: "Biamp X", manufacturer: "Biamp", deviceType: "audio-dsp" });
    insert({ id: "jbl", label: "JBL Y", manufacturer: "JBL", deviceType: "speaker" });
    insert({ id: "hid", label: "Extron Hidden", manufacturer: "Extron", deviceType: "switcher" }, "hidden");
    const rows = buildWorklist(api.db.sqlite);
    expect(rows.map((r) => [r.vendor, r.templateId, r.level])).toEqual([
      ["Biamp", "bi", "FIX"],
      ["Extron", "ex-fix", "FIX"],
      ["Extron", "ex-b", "B"],
    ]);
    expect(rows[1].issue1.startsWith("E ")).toBe(true);
    const csv = worklistCsv(rows);
    expect(csv.startsWith("﻿Vendor,Model,Part number,Device type,Category,Level,Status,E,W,Issue 1,Issue 2,Issue 3,Template id\r\n")).toBe(true);
    expect(csv).toContain('"Extron Z, ""quoted"""');
  });
});

describe("relintAll and the slot context", () => {
  it("a chassis whose slot has no card is B; adding a card brings it to A on relint; status is not touched", () => {
    const host = {
      id: "host", label: "Yamaha CL5", shortName: "CL5", manufacturer: "Yamaha", modelNumber: "CL5", deviceType: "audio-mixer",
      category: "Audio Products / Mixers", auxiliaryData: [{ text: "{{deviceType}}", position: "header" }], referenceUrl: "https://usa.yamaha.com",
      searchTerms: ["cl5"], heightMm: 1, widthMm: 1, depthMm: 1, weightKg: 1, powerDrawW: 1, voltage: "100-240V",
      slots: [{ id: "s1", label: "MY 1", slotFamily: "yamaha-my" }],
    };
    insert(host, "draft");
    relintAll(api.db.sqlite);
    expect(meta("host")).toMatchObject({ lint_level: "B", status: "draft" });
    insert({ id: "card", label: "Yamaha MY16-AE", manufacturer: "Yamaha", deviceType: "expansion-card", slotFamily: "yamaha-my", ports: [] });
    expect(relintAll(api.db.sqlite)).toBeGreaterThan(0);
    expect(meta("host")).toMatchObject({ lint_level: "A", status: "draft" });
  });
});

describe("Sony in apply:vendor-decisions", () => {
  it("every Sony template gets a decision in the report: kept, retyped, deleted", () => {
    insert({ id: "brc", label: "Sony BRC-X400", manufacturer: "Sony", modelNumber: "BRC-X400", deviceType: "camera" });
    insert({ id: "srg", label: "Sony SRG-A40", manufacturer: "Sony", modelNumber: "SRG-A40", deviceType: "ptz-camera" });
    insert({ id: "pxw", label: "Sony PXW-FX9", manufacturer: "Sony", modelNumber: "PXW-FX9", deviceType: "camera" });
    const dry = applyVendorDecisions(api.db.sqlite, { dryRun: true });
    expect(dry.scopeDecisions.map((d) => [d.label, d.action])).toEqual([
      ["Sony BRC-X400", "retyped → ptz-camera"],
      ["Sony PXW-FX9", "deleted: deviceType camera is outside the Sony scope"],
      ["Sony SRG-A40", "kept"],
    ]);
    expect(formatVendorCleanupReport(dry)).toContain("Sony        Sony BRC-X400 [camera]: retyped → ptz-camera");
    applyVendorDecisions(api.db.sqlite);
    expect(api.db.sqlite.prepare("SELECT device_type, category FROM templates WHERE id = 'brc'").get()).toEqual({
      device_type: "ptz-camera",
      category: "Videocameras / PTZ cameras",
    });
    expect(api.db.sqlite.prepare("SELECT 1 FROM templates WHERE id = 'pxw'").get()).toBeUndefined();
  });
});

describe("normalize:library report: slots and cards", () => {
  it("lists our vendors' slot families no card fits (after renames) and card families no chassis takes", () => {
    insert({ id: "core", label: "QSC Core 510i", manufacturer: "QSC", deviceType: "audio-dsp", slots: [{ id: "a", label: "A", slotFamily: "CIML4" }, { id: "b", label: "B", slotFamily: "COL4" }] });
    insert({ id: "sd", label: "Generic SDHC Card (32 GB)", manufacturer: "Generic", deviceType: "storage-media", slotFamily: "sd-card", ports: [] });
    const r = normalizeLibrary(api.db.sqlite, { dryRun: true });
    expect(r.slotFamiliesWithoutCards).toEqual([{ family: "qsc-core-io", vendor: "QSC", hosts: 1 }]);
    expect(r.cardFamiliesWithoutHosts).toEqual([{ family: "sd-card", cards: 1 }]);
    expect(formatNormalizeReport(r)).toContain("  QSC            qsc-core-io: 1");
  });
});
