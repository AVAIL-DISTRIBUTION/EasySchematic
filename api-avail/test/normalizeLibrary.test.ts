/**
 * normalize:library — the block normalizer over our vendors' raw/draft templates:
 * writes only level improvements, keeps statuses, reports transitions and reasons.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { formatNormalizeReport, normalizeLibrary, reasonKey, SIGNAL_RULE_REASON } from "../src/normalizeLibrary";
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
    expect(r.byVendor.Wyrestorm).toMatchObject({ processed: 2, written: 2, fixToB: 2 });
    expect(row("a")).toMatchObject({ manufacturer: "Wyrestorm", label: "Wyrestorm NHD-a", category: "AV distribution / AVoIP", version: 2 });
    expect(JSON.parse(row("a").ports as string).map((p: { section: string }) => p.section)).toEqual(["Video Inputs", "Network", "Power"]);
    expect(meta("a")).toMatchObject({ status: "raw", lint_level: "B", linted_version: 2, updated_by: "normalize" });
    expect(meta("d")).toMatchObject({ status: "draft", lint_level: "B" });
  });

  it("writes a change that leaves fewer E+W even when the level stays the same", () => {
    // A port without connectorType keeps it FIX whatever the normalizer does, but sections get fixed.
    const t = community("s");
    // analog audio: several usual connectors, the normalizer does not pick one
    t.ports.push({ id: "4", label: "AUDIO OUT", signalType: "analog-audio", direction: "output", section: "Back of unit", connectorType: "" });
    insert(t);
    const r = normalizeLibrary(api.db.sqlite);
    expect(r).toMatchObject({ processed: 1, improved: 1, fewerIssuesSameLevel: 1, sameLevelNotWritten: 0, transitions: { "FIX→FIX": 1 } });
    expect(row("s")).toMatchObject({ version: 2 });
    expect(meta("s")).toMatchObject({ lint_level: "FIX", linted_version: 2 });
    expect(r.topReasons).toContainEqual({ reason: "E no connectorType", count: 1 });
    expect(formatNormalizeReport(r)).toContain("fewer E+W at the same level 1");
  });

  it("does not write when E+W does not go down", () => {
    // The only issue is one the normalizer cannot fix: a port without a connector.
    const t = community("n");
    insert(t);
    normalizeLibrary(api.db.sqlite);
    const stable = row("n");
    const r = normalizeLibrary(api.db.sqlite);
    expect(r).toMatchObject({ improved: 0 });
    expect(row("n")).toEqual(stable);
  });

  it("reports unresolved sections by signalType + direction", () => {
    const t = community("u");
    t.ports.push({ id: "5", label: "Ref", signalType: "custom", direction: "input", section: "Rear", connectorType: "bnc" });
    t.ports.push({ id: "6", label: "WC", signalType: "custom", direction: "input", section: "", connectorType: "bnc" });
    insert(t);
    const r = normalizeLibrary(api.db.sqlite, { dryRun: true });
    expect(r.unresolvedSections).toEqual([{ reason: "custom + input", count: 2 }]);
    expect(formatNormalizeReport(r)).toContain("Unresolved port sections by signalType + direction (top 30):\n   1. custom + input: 2");
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

  it("verified with community ports: R4 only, then draft with the reason; others stay verified", () => {
    const relay = (id: string) => ({
      id,
      label: `Extron IPCP Pro ${id}`,
      manufacturer: "Extron",
      modelNumber: `60-${id}`,
      deviceType: "control-processor",
      category: "Control Systems / Control Processors",
      ports: [
        { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" },
        { id: "r", label: "Relay 1", signalType: "gpio", direction: "bidirectional", section: "Relays", connectorType: "phoenix" },
      ],
    });
    insert(relay("c"), "verified");
    insert(relay("m"), "verified");
    insert(relay("n"), "verified");
    api.db.sqlite.prepare("UPDATE avail_template_meta SET source = 'easyschematic.live' WHERE template_id IN ('c', 'n')").run();
    api.db.sqlite.prepare("UPDATE avail_template_meta SET source = 'avail-library' WHERE template_id = 'm'").run();
    api.db.sqlite.prepare("UPDATE templates SET manufacturer = 'Blackmagic Design' WHERE id = 'n'").run();
    const untouched = ["m", "n"].map(row);

    const dry = normalizeLibrary(api.db.sqlite, { dryRun: true });
    expect(dry.verifiedToDraft).toEqual([{ id: "c", label: "Extron IPCP Pro c", level: expect.any(String), changes: 2 }]);
    expect(meta("c").status).toBe("verified");

    const r = normalizeLibrary(api.db.sqlite);
    expect(r.verifiedToDraft.map((x) => x.id)).toEqual(["c"]);
    expect(meta("c")).toMatchObject({ status: "draft", status_reason: SIGNAL_RULE_REASON });
    expect(meta("c").status_changed_at).toBeTruthy();
    const ports = JSON.parse(String(row("c").ports)) as { id: string; signalType: string; direction: string }[];
    expect(ports.find((p) => p.id === "r")).toMatchObject({ signalType: "contact-closure", direction: "output" });
    expect(row("c").version).toBe(2);
    expect(["m", "n"].map(row)).toEqual(untouched);
    expect(meta("m").status).toBe("verified");
    expect(formatNormalizeReport(r)).toContain("Verified with community ports changed by the signal-type rule (R4) → draft: 1\n  Extron IPCP Pro c (c): 2 changes");
    expect(normalizeLibrary(api.db.sqlite).verifiedToDraft).toEqual([]);
  });

  it("dry run reports the same but writes nothing", () => {
    insert(community("a"));
    const before = row("a");
    const version = api.db.sqlite.prepare("SELECT version FROM library_meta").get();
    const r = normalizeLibrary(api.db.sqlite, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, improved: 1, byVendor: { Wyrestorm: { fixToB: 1, written: 0 } } });
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
    expect(text).toContain("dry run, nothing written");
    expect(text).toContain("Transitions: FIX→B 1");
    expect(text).toMatch(/Wyrestorm +1 +1 +0 +0/);
    expect(text).toContain("Top 10 remaining reasons:");
  });

  it("reasonKey masks ports and values", () => {
    expect(reasonKey("E", '"HDMI In": no connectorType')).toBe("E no connectorType");
    expect(reasonKey("E", '"X": section "Rear" is not in the vocabulary')).toBe('E section "…" is not in the vocabulary');
    expect(reasonKey("W", "label does not start with the manufacturer (Extron)")).toBe("W label does not start with the manufacturer (…)");
    expect(reasonKey("W", "no powerDrawW/voltage (or poeDrawW)")).toBe("W no powerDrawW/voltage (or poeDrawW)");
  });
});
