/**
 * normalize:library — the block normalizer over our vendors' raw/draft templates:
 * writes only level improvements, keeps statuses, reports transitions and reasons.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { formatNormalizeReport, normalizeLibrary, reasonKey } from "../src/normalizeLibrary";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { syncLintLevels } from "../src/templateMeta";

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-normalize-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A community-style block: FIX now, B after normalization. */
function community(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: `WYRESTORM NHD-${id}`,
    manufacturer: "WYRESTORM",
    modelNumber: `NHD-${id}`,
    deviceType: "avoip-encoder",
    category: "Video",
    ports: [
      { id: "1", label: "POWER", signalType: "power", direction: "input", section: "Back of unit", connectorType: "barrel" },
      { id: "2", label: "LAN", signalType: "ethernet", direction: "input", section: "Back of unit", connectorType: "rj45" },
      { id: "3", label: "HDMI INPUT", signalType: "hdmi", direction: "input", section: "Back of unit", connectorType: "hdmi" },
    ],
    ...over,
  };
}

function insert(t: Record<string, unknown>, status?: string) {
  const row = templateToRow(t as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  syncLintLevels(api.db.sqlite);
  if (status) api.db.sqlite.prepare("UPDATE avail_template_meta SET status = ? WHERE template_id = ?").run(status, t.id);
}

const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown>;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("normalizeLibrary", () => {
  it("raises FIX → B and writes it; status stays, version and lint move", () => {
    insert(community("a"));
    insert(community("d"), "draft");
    expect(meta("a")).toMatchObject({ lint_level: "FIX", status: "raw" });

    const r = normalizeLibrary(api.db.sqlite);
    expect(r).toMatchObject({ processed: 2, improved: 2, transitions: { "FIX→B": 2 } });
    expect(r.byVendor.WyreStorm).toMatchObject({ processed: 2, written: 2, fixToB: 2 });
    expect(row("a")).toMatchObject({ manufacturer: "WyreStorm", label: "WyreStorm NHD-a", category: "AV distribution / AVoIP", version: 2 });
    expect(JSON.parse(row("a").ports as string).map((p: { section: string }) => p.section)).toEqual(["Video Inputs", "Network", "Power"]);
    expect(meta("a")).toMatchObject({ status: "raw", lint_level: "B", linted_version: 2, updated_by: "normalize" });
    expect(meta("d")).toMatchObject({ status: "draft", lint_level: "B" });
  });

  it("does not write when the level stays the same", () => {
    // A port without connectorType keeps it FIX whatever the normalizer does.
    const t = community("s");
    t.ports.push({ id: "4", label: "HDMI OUT", signalType: "hdmi", direction: "output", section: "Back of unit", connectorType: "" });
    insert(t);
    const before = row("s");
    const r = normalizeLibrary(api.db.sqlite);
    expect(r).toMatchObject({ processed: 1, improved: 0, sameLevelNotWritten: 1, transitions: { "FIX→FIX": 1 } });
    expect(row("s")).toEqual(before);
    expect(r.topReasons).toContainEqual({ reason: "E нет connectorType", count: 1 });
  });

  it("leaves verified and hidden templates and other vendors alone", () => {
    insert(community("v"), "verified");
    insert(community("h"), "hidden");
    insert(community("o", { manufacturer: "Blackmagic Design", label: "Blackmagic X" }));
    const snapshot = ["v", "h", "o"].map(row);
    const r = normalizeLibrary(api.db.sqlite);
    expect(r.processed).toBe(0);
    expect(["v", "h", "o"].map(row)).toEqual(snapshot);
  });

  it("dry run reports the same but writes nothing", () => {
    insert(community("a"));
    const before = row("a");
    const version = api.db.sqlite.prepare("SELECT version FROM library_meta").get();
    const r = normalizeLibrary(api.db.sqlite, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, improved: 1, byVendor: { WyreStorm: { fixToB: 1, written: 0 } } });
    expect(row("a")).toEqual(before);
    expect(api.db.sqlite.prepare("SELECT version FROM library_meta").get()).toEqual(version);
  });

  it("a second run changes nothing", () => {
    insert(community("a"));
    normalizeLibrary(api.db.sqlite);
    const after = row("a");
    const r = normalizeLibrary(api.db.sqlite);
    expect(r).toMatchObject({ improved: 0, transitions: { "B→B": 1 }, sameLevelNotWritten: 0 });
    expect(row("a")).toEqual(after);
  });

  it("report text", () => {
    insert(community("a"));
    const text = formatNormalizeReport(normalizeLibrary(api.db.sqlite, { dryRun: true }));
    expect(text).toContain("пробный запуск");
    expect(text).toContain("Переходы: FIX→B 1");
    expect(text).toMatch(/WyreStorm +1 +1 +0 +0/);
    expect(text).toContain("Топ-10 оставшихся причин:");
  });

  it("reasonKey masks ports and values", () => {
    expect(reasonKey("E", "«HDMI In»: нет connectorType")).toBe("E нет connectorType");
    expect(reasonKey("E", "«X»: секция «Rear» вне словаря")).toBe("E секция «…» вне словаря");
    expect(reasonKey("W", "label не начинается с производителя (Extron)")).toBe("W label не начинается с производителя (…)");
    expect(reasonKey("W", "нет powerDrawW/voltage (или poeDrawW)")).toBe("W нет powerDrawW/voltage (или poeDrawW)");
  });
});
