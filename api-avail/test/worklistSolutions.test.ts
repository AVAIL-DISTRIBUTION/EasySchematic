/**
 * Phase 1.8a: the engineers' worklist (xlsx reader, solution parser, applying to templates,
 * apply:worklist checks and report, export:vendor-requests).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { applyWorklist, formatApplyWorklistReport, vendorRequests, vendorRequestsCsv, type WorklistRowInput } from "../src/applyWorklist";
import { AVAIL_LIBRARY_SOURCE } from "../src/importAvail";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { applyActions, CHECK_PANEL_NOTE, mapSection, normalizeConnector, parseNumber, parseSolution } from "../src/worklistSolutions";
import { readXlsx, sheetObjects } from "../src/xlsx";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("xlsx reader", () => {
  it("reads the engineers' workbook: sheets, header, rows", () => {
    const book = readXlsx(readFileSync(path.join(repo, "tools/avail/incoming/Library_worklist_engineers_solutions.xlsx")));
    expect([...book.keys()]).toEqual(expect.arrayContaining(["Worklist", "Solution notes"]));
    const rows = sheetObjects(book.get("Worklist")!);
    expect(rows.length).toBe(1033);
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(["Template id", "Issue 1", "Solution", "Solution status"]));
    expect(new Set(rows.map((r) => r["Solution status"]))).toEqual(new Set(["Готово", "Нет данных", "Ложное срабатывание"]));
  });
});

describe("parseSolution", () => {
  it("device fields with comma decimals and comments in parentheses", () => {
    const [l] = parseSolution("1) voltage = 48V DC / PoE 802.3af; powerDrawW = 1,3; poeDrawW = 15,4 (при питании по PoE); thermalBtuh = 4,6");
    expect(l.kind).toBe("applied");
    expect(l.actions).toEqual([
      { type: "set", field: "voltage", value: "48V DC / PoE 802.3af" },
      { type: "set", field: "powerDrawW", value: 1.3 },
      { type: "set", field: "poeDrawW", value: 15.4 },
      { type: "set", field: "thermalBtuh", value: 4.6 },
    ]);
    expect(parseNumber("2 (<2 Вт)")).toBe(2);
  });

  it("port renames with notes, port fields, added ports, search terms, a category in prose", () => {
    const lines = parseSolution(
      "1) «HDMI Output 1 (Buffered Mirror)» → «HDMI Out 1 (Mirror)», notes: «buffered mirror»\n" +
        "2) «Power In 1»: connectorType = barrel (12 V DC)\n" +
        "3) добавить порт «Power 48V DC»: signalType power, direction input, connectorType phoenix, section Power (внешний БП); альтернативно PoE 802.3af\n" +
        "4) searchTerms = CDD6, loudspeaker\n" +
        "5) Break-in/out-бокс используется на схемах как блок: category = Integration Tools / Adapters (schematic=true).\n" +
        "6) «Mic 1»: section «Audio Inputs» → Audio I/O",
    );
    expect(lines.map((l) => l.kind)).toEqual(["applied", "applied", "applied", "applied", "applied", "applied"]);
    expect(lines[0].actions[0]).toEqual({ type: "portRename", port: "HDMI Output 1 (Buffered Mirror)", to: "HDMI Out 1 (Mirror)", notes: "buffered mirror" });
    expect(lines[1].actions[0]).toMatchObject({ type: "portSet", port: "Power In 1", field: "connectorType", value: "barrel" });
    expect(lines[2].actions[0]).toEqual({ type: "portAdd", port: { label: "Power 48V DC", signalType: "power", direction: "input", connectorType: "phoenix", section: "Power" } });
    expect(lines[3].actions[0]).toEqual({ type: "set", field: "searchTerms", value: ["cdd6", "loudspeaker"] });
    expect(lines[4].actions[0]).toEqual({ type: "set", field: "category", value: "Integration Tools / Adapters" });
    expect(lines[5].actions[0]).toMatchObject({ type: "portSet", port: "Mic 1", field: "section", value: "Audio I/O" });
  });

  it("false positives, keep, no data (with and without the tag), manual", () => {
    const lines = parseSolution(
      "1) ложное срабатывание: питание PoE 802.3af по LAN-порту (RJ-45), отдельный порт питания не нужен\n" +
        "2) «IPCP LAN 1»: оставить — метка из аббревиатур\n" +
        "3) heightMm: данных производителя не найдено [нет данных]\n" +
        "4) weightKg = 10; потребление (Вт) производителем не опубликовано [нет данных]\n" +
        "5) weightKg: вес стойки производителем на найденных страницах не указан\n" +
        "6) мотор экрана",
    );
    expect(lines.map((l) => l.kind)).toEqual(["false-positive", "false-positive", "no-data", "applied", "no-data", "manual"]);
    expect(lines[2].missing).toEqual(["heightMm"]);
    expect(lines[3].missing).toEqual(["powerDrawW"]);
    expect(lines[4].missing).toEqual(["weightKg"]);
  });

  it("connectors and sections map to ours", () => {
    expect(normalizeConnector("powercon-20")).toBe("powercon");
    expect(normalizeConnector("RJ45")).toBe("rj45");
    expect(normalizeConnector("hd15-ish")).toBeNull();
    expect(mapSection("Control", { signalType: "serial", direction: "bidirectional" })).toBe("Serial");
    expect(mapSection("Control", { signalType: "contact-closure", direction: "output" })).toBe("Relays");
    expect(mapSection("Control", { signalType: "tally", direction: "output" })).toBe("Control");
    expect(mapSection("Telephony", { signalType: "pots" })).toBe("Telephony");
    expect(mapSection("Rear Panel", {})).toBeNull();
  });
});

describe("applyActions", () => {
  const tpl = () => ({
    label: "X",
    searchTerms: ["x"],
    ports: [
      { id: "1", label: "Power In 1", signalType: "power", direction: "input" },
      { id: "2", label: "LAN (PoE)", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45" },
      { id: "3", label: "Data Port", signalType: "vga", direction: "input" },
    ],
  });
  it("renames first, signal before section, connector with a check-the-panel note, PoE note, search terms merged", () => {
    const actions = [
      ...parseSolution("1) «Data Port»: section = Control").flatMap((l) => l.actions),
      ...parseSolution("2) «Data Port»: signalType = serial, connectorType db15, direction bidirectional").flatMap((l) => l.actions),
      ...parseSolution("3) «Power In 1»: connectorType = barrel (сверить с панелью)").flatMap((l) => l.actions),
      ...parseSolution("4) poeDrawW = 12,95 (максимум 802.3af; фактическое потребление не опубликовано); searchTerms = X, y").flatMap((l) => l.actions),
    ];
    const r = applyActions(tpl(), actions);
    const ports = r.template.ports as Record<string, unknown>[];
    expect(ports[2]).toMatchObject({ signalType: "serial", connectorType: "db15", direction: "bidirectional", section: "Serial" });
    expect(ports[0]).toMatchObject({ connectorType: "barrel", notes: CHECK_PANEL_NOTE });
    expect(ports[1].notes).toBe("PoE: actual draw not published");
    expect(r.template).toMatchObject({ poeDrawW: 12.95, searchTerms: ["x", "y"] });
    expect(r.skipped).toEqual([]);
  });
  it("reports what it cannot apply", () => {
    const r = applyActions(tpl(), [
      { type: "portSet", port: "Nope", field: "direction", value: "input" },
      { type: "portSet", port: "Power In 1", field: "connectorType", value: "weird" },
    ]);
    expect(r.skipped).toEqual(['port "Nope" not found (portSet)', 'port "Power In 1": unknown connector "weird"']);
  });
});

let dataDir: string;
let api: ApiServer;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-worklist-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});
afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function insert(t: Record<string, unknown>, status = "raw", source: string | null = null) {
  const row = templateToRow({ category: "Audio Products / Speakers", ports: [], ...t } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, ?)").run(t.id, status, source);
}
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown>;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown>;

describe("applyWorklist", () => {
  const MA = {
    id: "ma", label: "Martin Audio CDD6", shortName: "CDD6", manufacturer: "Martin Audio", modelNumber: "CDD6", deviceType: "speaker",
    auxiliaryData: [{ text: "{{deviceType}}" }], referenceUrl: "https://martin-audio.com", heightMm: 1, widthMm: 1, depthMm: 1,
    ports: [{ id: "i", label: "Speaker In", signalType: "speaker-level", direction: "input", section: "Audio Inputs", connectorType: "phoenix" }],
  };
  const rows: WorklistRowInput[] = [
    { "Template id": "ma", Vendor: "Martin Audio", Model: "Martin Audio CDD6", "Issue 1": "W no weightKg", "Issue 2": "W no searchTerms", Solution: "1) weightKg = 5,69\n2) searchTerms = CDD6, loudspeaker", "Solution status": "Готово" },
    { "Template id": "ipcp", Model: "Extron IPCP", "Issue 1": 'W "IPCP LAN": label in all caps', Solution: "1) «IPCP LAN»: оставить — метка из аббревиатур (ложное срабатывание)", "Solution status": "Ложное срабатывание" },
    { "Template id": "mic", Vendor: "Shure", Model: "Shure SM57", "Issue 1": "E no power port", Solution: "1) ложное срабатывание: динамический микрофон — питание не требуется", "Solution status": "Ложное срабатывание" },
    { "Template id": "ma", Model: "Martin Audio CDD6", Solution: "", "Solution status": "Готово" },
    { "Template id": "nd", Vendor: "Mipro", Model: "Mipro AT90W", "Part number": "AT90W", "Issue 1": "W no heightMm", Solution: "1) heightMm: данных производителя не найдено [нет данных]\n2) searchTerms = AT90W", "Solution status": "Нет данных" },
    { "Template id": "cur", Model: "Curated", Solution: "1) heightMm = 44", "Solution status": "Готово" },
    { "Template id": "gone", Model: "Gone", Solution: "1) heightMm = 44", "Solution status": "Готово" },
  ];

  beforeEach(() => {
    insert(MA, "draft");
    insert({ id: "ipcp", label: "Extron IPCP", manufacturer: "Extron", deviceType: "control-processor", ports: [{ id: "l", label: "IPCP LAN", signalType: "ethernet", direction: "bidirectional", section: "Network", connectorType: "rj45" }] });
    insert({ id: "mic", label: "Shure SM57", manufacturer: "Shure", deviceType: "wired-mic", ports: [{ id: "o", label: "Out", signalType: "analog-audio", direction: "output", section: "Audio Outputs", connectorType: "xlr-3" }] });
    insert({ id: "nd", label: "Mipro AT90W", manufacturer: "Mipro", modelNumber: "AT90W", deviceType: "wireless-mic-receiver", referenceUrl: "https://mipro.com.tw" });
    insert({ id: "cur", label: "Curated", manufacturer: "Extron", deviceType: "switcher" }, "draft", AVAIL_LIBRARY_SOURCE);
  });

  it("applies, keeps statuses, skips curated, checks false positives against the current rules, is idempotent", () => {
    const r = applyWorklist(api.db.sqlite, rows);
    expect(row("ma")).toMatchObject({ weight_kg: 5.69, version: 2 });
    expect(JSON.parse(row("ma").search_terms as string)).toEqual(["cdd6", "loudspeaker"]);
    expect(meta("ma")).toMatchObject({ status: "draft", updated_by: "worklist" });
    expect(r).toMatchObject({ templatesChanged: 2, curatedSkipped: ["Curated [cur]"], missingTemplates: ["Gone [gone]"] });
    expect(row("cur").height_mm).toBeNull();
    // "IPCP LAN" is no longer reported (rule 1); the SM57 has no marker: listed as still reported.
    expect(r.falsePositiveGone).toBe(1);
    expect(r.falsePositiveRemaining.map((x) => x.templateId)).toEqual(["mic"]);
    expect(r.appliedGone).toBe(2);
    expect(r.levelsAfter["Martin Audio"]).toEqual({ A: 1, B: 0, FIX: 0 });
    expect(formatApplyWorklistReport(r, "w.xlsx")).toContain("False positives: gone under the current rules 1, still reported 1");

    const again = applyWorklist(api.db.sqlite, rows);
    expect(again).toMatchObject({ templatesChanged: 0, alreadyApplied: 2 });
    expect(row("ma").version).toBe(2);
  });

  it("dry run writes nothing", () => {
    applyWorklist(api.db.sqlite, rows, { dryRun: true });
    expect(row("ma")).toMatchObject({ weight_kg: null, version: 1 });
  });

  it("vendor requests: fields manufacturers do not publish, CSV per vendor", () => {
    const req = vendorRequests(api.db.sqlite, rows);
    expect(req).toEqual([
      { vendor: "Mipro", model: "Mipro AT90W", partNumber: "AT90W", missing: ["heightMm"], note: "heightMm: данных производителя не найдено", templateId: "nd", referenceUrl: "https://mipro.com.tw" },
    ]);
    const csv = vendorRequestsCsv(req);
    expect(csv.startsWith("﻿Vendor,Model,Part number,Missing fields,Engineer note,Reference URL,Template id\r\n")).toBe(true);
  });
});
