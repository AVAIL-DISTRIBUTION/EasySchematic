/**
 * Review queue on the API side: the database lints a catalog template with its catalog meta
 * (description, rackForm — blockOfRow), so the v0.9 room-mounted rule gives the same level in the
 * database as in the file; the proposed rules (reviewRules.ts) are simulated, never applied.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintBlock } from "../../src/avail/blockLint";
import type { QueueItem } from "../../src/avail/reviewQueue";
import type { CatalogFileText } from "../src/catalogFiles";
import { importCatalog } from "../src/importCatalog";
import { PROPOSED_RULES, proposedRules } from "../src/reviewRules";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { relintAll } from "../src/templateMeta";

let dataDir: string;
let api: ApiServer;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-review-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A DTP3 wallplate card without dimensions: room-mounted only by its description. */
const card = (over: Record<string, unknown> = {}) => ({
  id: "avail-extron-60-1902-52",
  label: "Extron DTP3 T 101",
  shortName: "DTP3 T 101",
  manufacturer: "Extron",
  modelNumber: "60-1902-52",
  deviceType: "hdbaset-extender",
  category: "AV distribution / Extenders",
  auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
  referenceUrl: "https://www.extron.com/product/dtp3t101d",
  searchTerms: ["60-1902-52"],
  powerDrawW: 4, voltage: "12V DC",
  _avail: { status: "ports-filled", description: "4K/60 DTP3 Transmitter for HDMI – Decorator-Style Wallplate", portsSource: { kind: "stencil", from: "x.vssx" } },
  ports: [
    { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
    { id: "2", label: "12V DC In", signalType: "power", direction: "input", section: "Power", connectorType: "phoenix" },
  ],
  ...over,
});

const file = (t: Record<string, unknown>, name = "extron/extron-dtp3-t-101.json"): CatalogFileText => {
  const text = JSON.stringify(t, null, 2);
  return { file: name, text, template: JSON.parse(text) };
};

describe("database lint with the catalog meta", () => {
  it("a card room-mounted by its description is level A in the file and in the database", () => {
    const t = card();
    expect(lintBlock(t).level).toBe("A");
    importCatalog(api.db.sqlite, [file(t)], { deletedList: { version: 1, templates: [] } });
    relintAll(api.db.sqlite);
    expect(api.db.sqlite.prepare("SELECT lint_level FROM avail_template_meta WHERE template_id = ?").get(t.id)).toEqual({ lint_level: "A" });
    // A rack form in the catalog meta still makes it a rack device.
    importCatalog(api.db.sqlite, [file(card({ rackForm: "half" }))], { deletedList: { version: 1, templates: [] } });
    relintAll(api.db.sqlite);
    expect(api.db.sqlite.prepare("SELECT lint_level FROM avail_template_meta WHERE template_id = ?").get(t.id)).toEqual({ lint_level: "B" });
  });
});

describe("proposed rules", () => {
  const item = (t: Record<string, unknown>, where: string): QueueItem => ({
    id: String(t.id), label: String(t.label), manufacturer: "Extron", deviceType: String(t.deviceType), category: "", level: lintBlock(t).level,
    warnings: lintBlock(t).warnings, origin: { origin: "manufacturer", kind: "stencil" }, where,
  });

  it("R2 voltage from the power notes, R3 label wording; simulated on copies, the cards stay as they are", () => {
    const noVolt = card({ voltage: undefined, ports: [card().ports[0], { ...card().ports[1], notes: "External 12VDC PSU" }] });
    const longLabel = card({ ports: [{ ...card().ports[0], label: "HDMI Output 1 (Buffered Mirror)", direction: "output", section: "Video Outputs" }, card().ports[1]] });
    expect(PROPOSED_RULES[1].apply(noVolt)!.t.voltage).toBe("12V DC");
    expect((PROPOSED_RULES[2].apply(longLabel)!.t.ports as { label: string; notes?: string }[])[0]).toMatchObject({ label: "HDMI Out 1 (Buffered Mirror)" }); // 28: fits after In/Out
    const templates = new Map([["a", noVolt], ["b", longLabel]]);
    const md = proposedRules([item(noVolt, "a"), item(longLabel, "b")], templates).join("\n");
    expect(md).toContain("| R2. Voltage from the power input's notes | 1 | 1 | 1 | 1 |");
    expect(md).toMatch(/\| R3\. .* \| 1 \| 1 \| 1 \| 1 \|/);
    expect(noVolt.voltage).toBeUndefined();
    expect(longLabel.ports[0].label).toBe("HDMI Output 1 (Buffered Mirror)");
  });

  it("R1: a slots-only chassis without a power input no longer needs power figures", () => {
    const chassis = card({ ports: [], powerDrawW: undefined, voltage: undefined, deviceType: "table-box", slots: [{ id: "s1", label: "Slot 1", slotFamily: "extron-cubby-aap" }] });
    expect(lintBlock(chassis).warnings).toContain("no powerDrawW/voltage (or poeDrawW)");
    const md = proposedRules([item(chassis, "c")], new Map([["c", chassis]])).join("\n");
    expect(md).toMatch(/\| R1\. .* \| 1 \| 1 \| 1 \| 1 \|/);
  });
});
