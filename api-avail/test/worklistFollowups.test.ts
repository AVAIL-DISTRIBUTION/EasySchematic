/**
 * Worklist follow-ups (tools/avail/incoming/worklist-followups.json, src/worklistFollowups.ts):
 * the file itself, each operation, idempotency, and apply:worklist writing them after the
 * solutions (curated skipped, statuses kept, dry run, second run a no-op).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { lintBlock } from "../../src/avail/blockLint";
import { applyWorklist, formatApplyWorklistReport } from "../src/applyWorklist";
import { AVAIL_LIBRARY_SOURCE } from "../src/importAvail";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { applyFollowups, WORKLIST_FOLLOWUPS, type FollowupOp, type FollowupsFile } from "../src/worklistFollowups";

describe("tools/avail/incoming/worklist-followups.json", () => {
  const ops = WORKLIST_FOLLOWUPS.operations;

  it("every operation names a template, a model and a known op", () => {
    for (const o of ops) {
      expect(o.id, o.model).toMatch(/\S/);
      expect(o.model).toMatch(/\S/);
      expect(["portNote", "set", "splitPort", "addSlots"]).toContain(o.op);
    }
  });

  it("power markers are the ones the linter knows; one per template", () => {
    const markers = ops.filter((o): o is Extract<FollowupOp, { op: "portNote" }> => o.op === "portNote" && o.note !== "PoE: actual draw not published");
    const ids = markers.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of markers) {
      const t = { label: "X", manufacturer: "Extron", deviceType: "switcher", ports: [{ id: "a", label: o.port, signalType: "custom", direction: "input", notes: o.note }] };
      expect(lintBlock(t).errors, `${o.model}: ${o.note}`).not.toContain("no power port");
    }
  });

  it("poeDrawW only where it is empty, and only PoE class maxima", () => {
    for (const o of ops) if (o.op === "set" && o.field === "poeDrawW") {
      expect(o.onlyIfEmpty, o.model).toBe(true);
      expect([3.84, 6.49, 12.95, 25.5]).toContain(o.value);
    }
  });

  it("decisions for later are listed: Yamaha PY cards, Chief racks", () => {
    expect(WORKLIST_FOLLOWUPS.notDone.some((x) => x.startsWith("Yamaha PY64-D"))).toBe(true);
    expect(WORKLIST_FOLLOWUPS.notDone.some((x) => x.startsWith("Chief NW1F"))).toBe(true);
  });
});

const COMBO = { id: "port-3", label: "HDMI In 4 (or DTP3)", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" };
const OPS: FollowupOp[] = [
  { id: "t", model: "T", op: "portNote", port: "LAN", note: "PoE 802.3af" },
  { id: "t", model: "T", op: "portNote", port: "LAN", note: "PoE: actual draw not published" },
  { id: "t", model: "T", op: "set", field: "poeDrawW", value: 12.95, onlyIfEmpty: true },
  { id: "t", model: "T", op: "set", field: "modelNumber", value: "60-2072-52" },
  {
    id: "t", model: "T", op: "splitPort", port: COMBO.label, exclusiveGroup: "input-4",
    into: [
      { label: "HDMI In 4", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" },
      { label: "DTP3 In 4", signalType: "hdbaset", direction: "input", connectorType: "rj45", section: "Video Inputs" },
    ],
  },
  { id: "t", model: "T", op: "addSlots", family: "qsfp", labels: ["Port 17", "Port 18"] },
];

describe("applyFollowups", () => {
  const base = () => ({
    id: "t", label: "T", modelNumber: "60-2072-53", poeDrawW: undefined as number | undefined,
    ports: [{ id: "lan", label: "LAN", signalType: "ethernet", direction: "bidirectional", notes: "IP control" }, COMBO, { id: "x", label: "Out", signalType: "hdmi", direction: "output" }],
    slots: [{ id: "s1", label: "Port 17", slotFamily: "qsfp" }],
  });

  it("notes appended, fields set, combo port split with an exclusive group, missing slots added", () => {
    const r = applyFollowups(base(), OPS);
    const ports = r.template.ports as Record<string, unknown>[];
    expect(ports.find((p) => p.label === "LAN")!.notes).toBe("IP control; PoE 802.3af; PoE: actual draw not published");
    expect(r.template).toMatchObject({ poeDrawW: 12.95, modelNumber: "60-2072-52" });
    expect(ports.map((p) => p.label)).toEqual(["LAN", "HDMI In 4", "DTP3 In 4", "Out"]);
    expect(ports[1]).toMatchObject({ id: "port-3", exclusiveGroup: "input-4", signalType: "hdmi" });
    expect(ports[2]).toMatchObject({ id: "port-3-dtp3-in-4", exclusiveGroup: "input-4", signalType: "hdbaset", connectorType: "rj45" });
    expect(r.template.slots).toEqual([
      { id: "s1", label: "Port 17", slotFamily: "qsfp" },
      { id: "slot-qsfp-port-18", label: "Port 18", slotFamily: "qsfp" },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.applied).toHaveLength(6);
  });

  it("idempotent: the result needs nothing more", () => {
    const once = applyFollowups(base(), OPS).template;
    const twice = applyFollowups(once, OPS);
    expect(twice.applied).toEqual([]);
    expect(twice.skipped).toEqual([]);
    expect(twice.template).toEqual(once);
  });

  it("onlyIfEmpty keeps an entered value; unknown ports and fields are reported, not invented", () => {
    const r = applyFollowups({ ...base(), poeDrawW: 7 }, [
      { id: "t", model: "T", op: "set", field: "poeDrawW", value: 12.95, onlyIfEmpty: true },
      { id: "t", model: "T", op: "portNote", port: "Nope", note: "passive" },
      { id: "t", model: "T", op: "set", field: "ports", value: [] },
    ]);
    expect(r.template.poeDrawW).toBe(7);
    expect(r.skipped).toEqual(['port "Nope": note "passive": port not found', "ports = []: field not settable by a follow-up"]);
  });
});

let dataDir: string;
let api: ApiServer;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-followups-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function insert(t: Record<string, unknown>, status = "raw", source: string | null = null) {
  const row = templateToRow({ category: "Audio Products / Microphones", ports: [], ...t } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, ?)").run(t.id, status, source);
}
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown>;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("apply:worklist with follow-ups", () => {
  const followups: FollowupsFile = {
    version: 1,
    operations: [
      { id: "mic", model: "Shure SM57", op: "portNote", port: "Out", note: "passive" },
      { id: "cur", model: "Curated", op: "portNote", port: "Out", note: "passive" },
      { id: "gone", model: "Gone", op: "portNote", port: "Out", note: "passive" },
    ],
    notDone: ["Yamaha PY64-D: PY card — slot family not set (decision: PY cards are step 1.8)"],
  };
  const rows = [{ "Template id": "mic", Model: "Shure SM57", "Issue 1": "E no power port", Solution: "1) ложное срабатывание: динамический микрофон — питание не требуется" }];
  const OUT = { id: "o", label: "Out", signalType: "analog-audio", direction: "output", section: "Audio Outputs", connectorType: "xlr-3" };

  beforeEach(() => {
    insert({ id: "mic", label: "Shure SM57", manufacturer: "Shure", deviceType: "wired-mic", ports: [OUT] }, "draft");
    insert({ id: "cur", label: "Curated", manufacturer: "Shure", deviceType: "wired-mic", ports: [OUT] }, "draft", AVAIL_LIBRARY_SOURCE);
  });

  it("marks the false positive, keeps the status, skips curated, lists later decisions; second run changes nothing", () => {
    const r = applyWorklist(api.db.sqlite, rows, { followups });
    expect(JSON.parse(row("mic").ports as string)[0].notes).toBe("passive");
    expect(meta("mic")).toMatchObject({ status: "draft", updated_by: "worklist" });
    expect(JSON.parse(row("cur").ports as string)[0].notes).toBeUndefined();
    expect(r.followups).toMatchObject({ templatesChanged: 1, applied: 1, curatedSkipped: ["Curated [cur]"], missingTemplates: ["Gone [gone]"] });
    expect(r.falsePositiveGone).toBe(1);
    expect(r.falsePositiveRemaining).toEqual([]);
    const text = formatApplyWorklistReport(r, "w.xlsx");
    expect(text).toContain("Follow-ups: 3 operations; templates changed 1");
    expect(text).toContain("Decided for a later step (not done now):\n  Yamaha PY64-D");

    const version = row("mic").version;
    const again = applyWorklist(api.db.sqlite, rows, { followups });
    expect(again.followups).toMatchObject({ templatesChanged: 0, applied: 0, alreadyApplied: 1 });
    expect(row("mic").version).toBe(version);
  });

  it("dry run writes nothing", () => {
    applyWorklist(api.db.sqlite, rows, { followups, dryRun: true });
    expect(JSON.parse(row("mic").ports as string)[0].notes).toBeUndefined();
  });
});
