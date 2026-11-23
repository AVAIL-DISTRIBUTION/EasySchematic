/**
 * src/avail/blockLint.ts must give the same result as the reference
 * tools/avail/avail_block_lint.py on every block: level and the E/W messages.
 *
 * - engineer-blocks.expected.json is the Python result committed with the fixture
 *   (refresh: python3 tools/avail/lint_to_json.py <fixture> > <expected>), so the
 *   check runs even without Python.
 * - Where python3 is available (CI, dev machines), Python is also run live on the
 *   fixture and on edge-case blocks, and the CLI report is compared line for line.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { blocksOf, formatBlockReport, lintBlock, lintDocument, type BlockReportRow } from "../avail/blockLint";
import type { DeviceTemplate } from "../types";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOOLS = path.join(ROOT, "tools/avail");
const FIXTURE = path.join(TOOLS, "fixtures/engineer-blocks.json");
const EXPECTED = path.join(TOOLS, "fixtures/engineer-blocks.expected.json");

const fixture: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as BlockReportRow[];

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const tmp = mkdtempSync(path.join(tmpdir(), "avail-block-lint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function python(script: string, ...args: string[]): string {
  return execFileSync("python3", ["-I", "-B", path.join(TOOLS, script), ...args], { encoding: "utf8" });
}

/** A block that passes every rule (level A); tests change one thing at a time. */
function clean(): DeviceTemplate & Record<string, unknown> {
  return {
    label: "Extron DTP3 T 203",
    model: "Extron DTP3 T 203",
    modelNumber: "60-1885-52",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    deviceType: "hdbaset-extender",
    category: "KVM / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12 VDC",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "DTP3 Out", signalType: "hdbaset", direction: "output", section: "Video Outputs", connectorType: "rj45" },
      { id: "3", label: "RS-232", signalType: "serial", direction: "bidirectional", section: "Serial", connectorType: "captive-screw" },
      { id: "4", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "captive-screw" },
    ],
  } as DeviceTemplate & Record<string, unknown>;
}

/** Blocks that probe the places where Python and JS semantics differ. */
function edgeCases(): object[] {
  const port = (over: Record<string, unknown>) => ({ ...clean().ports[0], ...over });
  return [
    clean(),
    { ...clean(), slots: [] },                                    // [] is falsy in Python
    { ...clean(), slots: [{ id: "s" }], ports: [] },
    { ...clean(), heightMm: 0 },                                  // 0 is "missing"
    { ...clean(), auxiliaryData: [] },
    { ...clean(), auxiliaryData: [{ text: "{{deviceType}}" }, { text: "x" }] },
    { ...clean(), color: "" },
    { ...clean(), color: "#ff0000" },
    { ...clean(), model: "" },
    { ...clean(), shortName: "60-1885-52" },
    { ...clean(), shortName: "60-1885-52\n" },                    // Python `$` before a final newline
    { ...clean(), shortName: "٦٠-١٨٨٥-٥٢" },                     // Python \d is Unicode
    { ...clean(), manufacturer: "", label: "X" },
    { ...clean(), label: "extron dtp3", model: "extron dtp3" },
    { ...clean(), deviceType: "speaker", ports: [], powerDrawW: 0 },
    { ...clean(), deviceType: "passive", ports: [] },
    { ...clean(), poeDrawW: 12, powerDrawW: 0, ports: [] },
    { ...clean(), searchTerms: [] },
    { ...clean(), ports: [port({ section: "Video Inputs (Front)" }), port({ section: "Audio Inputs" }), port({ section: "Video Outputs" })] },
    { ...clean(), ports: [port({ section: "Video Inputs (Front)\n" }), port({ section: "Power  (rear) " }), port({ section: "" })] },
    { ...clean(), ports: [port({ section: "Slot 1", label: "IGNORED" }), port({ section: "Video Inputs　(A)" })] },
    { ...clean(), ports: [port({ label: "HDMI INPUT" }), port({ label: "HDMI INPUT" }), port({ label: "HDMI\u001cINPUT" }), port({ label: "МИКРОФОН ВХОД" })] },
    { ...clean(), ports: [port({ label: "Вход Ёжика номер 1234567890123" }), port({ label: "x".repeat(28) }), port({ label: "😀".repeat(15) })] },
    { ...clean(), ports: [port({ label: "кdtp", signalType: "hdmi" }), port({ label: "_xtp" }), port({ label: "-HDBaseT out" }), port({ label: "1dtp" })] },
    { ...clean(), ports: [port({ label: "Power Loop", signalType: "power", direction: "output" }), port({ label: "PWR", signalType: "power", direction: "output" })] },
    { ...clean(), ports: [port({ label: "RS-232", signalType: "rs422", direction: "bidirectional" }), port({ label: "Dante", signalType: "dante", direction: "input" })] },
    { ...clean(), ports: [port({ label: "Relay 1", signalType: "gpio" }), port({ label: "EBUS", signalType: "serial" }), port({ connectorType: "" })] },
  ];
}

describe("blockLint vs avail_block_lint.py — engineer blocks", () => {
  const actual = lintDocument(fixture);

  it("reads every device node of the schematic", () => {
    expect(actual.map((r) => r.label)).toEqual(expected.map((r) => r.label));
    expect(actual.length).toBe(22);
  });

  it.each(expected.map((e, i) => [i, e.label, e] as const))("block %i %s: level and number of E/W", (i, _label, e) => {
    const r = actual[i];
    expect({ level: r.level, E: r.errors.length, W: r.warnings.length }).toEqual({
      level: e.level,
      E: e.errors.length,
      W: e.warnings.length,
    });
  });

  it("same messages, in the same order", () => {
    expect(actual).toEqual(expected);
  });

  it("summary matches the reference run (A 0 / B 4 / FIX 18)", () => {
    expect(formatBlockReport(actual).trimEnd().split("\n").at(-1)).toBe("Итого: {'A': 0, 'B': 4, 'FIX': 18}");
  });
});

describe.skipIf(!hasPython)("blockLint vs avail_block_lint.py — live Python run", () => {
  it("committed snapshot is up to date", () => {
    expect(JSON.parse(python("lint_to_json.py", FIXTURE))).toEqual(expected);
  });

  it("edge cases (truthiness, Unicode, regex anchors) give identical results", () => {
    const blocks = edgeCases();
    const file = path.join(tmp, "edge.json");
    writeFileSync(file, JSON.stringify({ templates: blocks }));
    const py = JSON.parse(python("lint_to_json.py", file)) as BlockReportRow[];
    expect(lintDocument({ templates: blocks })).toEqual(py);
  });

  it.each([[[]], [["--verbose"]]])("CLI report is identical to the Python script %j", (flags) => {
    const ts = execFileSync("npx", ["tsx", path.join(ROOT, "src/avail/blockLintCli.ts"), FIXTURE, ...flags], {
      encoding: "utf8",
      cwd: ROOT,
    });
    expect(ts).toBe(python("avail_block_lint.py", FIXTURE, ...flags));
  }, 30_000);
});

describe("lintBlock rules", () => {
  it("a complete block is level A", () => {
    expect(lintBlock(clean())).toEqual({ level: "A", errors: [], warnings: [] });
  });

  it("warnings only → B, any error → FIX", () => {
    expect(lintBlock({ ...clean(), color: "#f00" }).level).toBe("B");
    expect(lintBlock({ ...clean(), modelNumber: "" })).toMatchObject({ level: "FIX", errors: ["нет modelNumber"] });
  });

  it("missing power port is an error unless PoE, slots, speaker or antenna", () => {
    const noPower = { ...clean(), ports: clean().ports.filter((p) => p.signalType !== "power") };
    expect(lintBlock(noPower).errors).toContain("нет порта питания");
    expect(lintBlock({ ...noPower, poeDrawW: 10 }).errors).not.toContain("нет порта питания");
    expect(lintBlock({ ...noPower, deviceType: "antenna" }).errors).not.toContain("нет порта питания");
  });

  it("section order and vocabulary", () => {
    const [hdmi, dtp, rs232, power] = clean().ports;
    expect(lintBlock({ ...clean(), ports: [power, hdmi, dtp, rs232] }).warnings).toContain("порядок секций не по стандарту");
    expect(lintBlock({ ...clean(), ports: [{ ...hdmi, section: "Rear" }, power] }).errors).toContain("«HDMI In»: секция «Rear» вне словаря");
  });

  it("never throws on malformed input", () => {
    for (const bad of [{}, { ports: null }, { ports: [null, 1, "x"] }, { auxiliaryData: "x", label: 5 }]) {
      expect(() => lintBlock(bad)).not.toThrow();
    }
  });
});

describe("blocksOf", () => {
  it("device archive: templates; schematic: data of device nodes", () => {
    expect(blocksOf({ templates: [{ label: "a" }] })).toEqual([{ label: "a" }]);
    expect(
      blocksOf({ nodes: [{ type: "device", data: { label: "d" } }, { type: "room", data: { label: "r" } }] }),
    ).toEqual([{ label: "d" }]);
  });
});
