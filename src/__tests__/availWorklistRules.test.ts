/**
 * Phase 1.8a linter rules from the engineers' worklist (sheet "Solution notes"): labels made of
 * abbreviations, power paths without a power port, power outputs of PDUs and 12 V / tally / lamp,
 * cards without dimensions, the Audio I/O and Telephony sections.
 */
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { onlyAbbreviations } from "../avail/labels";
import { normalizeBlock } from "../avail/normalize";
import { BLOCK_SECTIONS } from "../avail/sections";

const block = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  label: "Extron X", shortName: "X", manufacturer: "Extron", modelNumber: "1", deviceType: "switcher", category: "AV distribution / Switchers",
  auxiliaryData: [{ text: "{{deviceType}}" }], referenceUrl: "https://www.extron.com", searchTerms: ["x"],
  heightMm: 1, widthMm: 1, depthMm: 1, weightKg: 1, powerDrawW: 1, voltage: "100-240V",
  ports: [{ id: "p", label: "AC Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" }],
  ...over,
});

describe("label in all caps: abbreviations and numbers only are fine", () => {
  it("IPCP LAN, USB HID, AV LAN, COM 1, RS-232/IR", () => {
    for (const l of ["IPCP LAN", "USB HID", "AV LAN", "COM 1", "RS-232/IR", "COM 1 (RS-232)", "IPCP LAN 1"]) {
      expect(onlyAbbreviations(l), l).toBe(true);
      const lint = lintBlock(block({ ports: [...(block().ports as object[]), { id: "l", label: l, signalType: "ethernet", direction: "bidirectional", section: "Network", connectorType: "rj45" }] }));
      expect(lint.warnings.some((w) => w.includes("all caps")), l).toBe(false);
    }
  });
  it("still a warning for real words in capitals", () => {
    for (const l of ["ANT A OUT 1", "AUDIO OUT", "BALANCED AUDIO OUT 1"]) expect(onlyAbbreviations(l), l).toBe(false);
    const lint = lintBlock(block({ ports: [...(block().ports as object[]), { id: "l", label: "AUDIO OUT", signalType: "analog-audio", direction: "output", section: "Audio Outputs", connectorType: "phoenix" }] }));
    expect(lint.warnings).toContain('"AUDIO OUT": label in all caps');
  });
});

describe("no power port: the powering port's notes say how it is powered", () => {
  const without = (notes: string, signalType = "analog-audio") =>
    lintBlock(block({ powerDrawW: undefined, voltage: undefined, ports: [{ id: "a", label: "Out", signalType, direction: "output", section: "Audio Outputs", connectorType: "xlr-3", notes }] }));
  it("phantom, battery, passive, bus-powered (eBUS / ACP / DCP / VCH)", () => {
    for (const n of ["phantom +48 V", "battery (AA)", "passive", "bus-powered (eBUS)", "bus-powered (ACP)", "bus-powered (DCP)", "bus-powered (VCH)"]) {
      const l = without(n);
      expect(l.warnings, n).not.toContain("no power port");
      expect(l.warnings, n).not.toContain("no powerDrawW/voltage (or poeDrawW)");
    }
    expect(without("balanced").warnings).toContain("no power port");
  });
  it("powered by host: on any port, no power figure needed", () => {
    for (const n of ["powered by host", "powered by host (PoH)"]) {
      const l = without(n);
      expect(l.warnings, n).not.toContain("no power port");
      expect(l.warnings, n).not.toContain("no powerDrawW/voltage (or poeDrawW)");
    }
  });
});

describe("coax bias (v0.13): powered over the coax by a receiver or distributor", () => {
  const rf = (notes: string, direction = "output") => ({ id: "r", label: "To Receiver", signalType: "rf", direction, section: "RF", connectorType: "bnc", notes });
  const amp = (over: Record<string, unknown>) => block({ deviceType: "antenna-distribution", powerDrawW: 0.72, voltage: "10-15V DC", ...over });
  it("\"bus-powered (coax bias)\" on any port, or \"coax bias\" in voltage: no power port needed", () => {
    expect(lintBlock(amp({ ports: [rf("bus-powered (coax bias)")] })).warnings).not.toContain("no power port");
    expect(lintBlock(amp({ ports: [rf("bus-powered (coax bias)", "input")] })).warnings).not.toContain("no power port");
    expect(lintBlock(amp({ voltage: "10-15V DC (coax bias)", ports: [rf("BNC, 50 ohm")] }))).toEqual({ level: "A", errors: [], warnings: [] });
    expect(lintBlock(amp({ ports: [rf("BNC, 50 ohm")] })).warnings).toContain("no power port");
  });
  it("the draw is still required: coax bias is not a power figure", () => {
    const l = lintBlock(amp({ powerDrawW: undefined, voltage: undefined, ports: [rf("bus-powered (coax bias)")] }));
    expect(l.warnings).not.toContain("no power port");
    expect(l.warnings).toContain("no powerDrawW/voltage (or poeDrawW)");
  });
});

describe("labels: more panel abbreviations and values", () => {
  it("DX, ME, EBU, PD, TB3 and number+unit tokens", () => {
    for (const l of ["DX 1", "ME 1", "AES/EBU", "USB PD", "TB3", "TB4", "12VDC", "5V DC"]) expect(onlyAbbreviations(l), l).toBe(true);
    expect(onlyAbbreviations("12VDC POWER")).toBe(false);
  });
});

describe("power outputs", () => {
  const out = (label: string, deviceType = "switcher") =>
    lintBlock(block({ deviceType, ports: [...(block().ports as object[]), { id: "o", label, signalType: "power", direction: "output", section: "Power", connectorType: "phoenix" }] })).errors;
  it("allowed for PDUs and power supplies, and for 12 V / tally / lamp outputs", () => {
    expect(out("Outlet 1", "power-distribution")).not.toContain('"Outlet 1": power is not an input');
    expect(out("Outlet 1", "power-supply")).not.toContain('"Outlet 1": power is not an input');
    expect(out("DC Out 1", "antenna-distribution")).not.toContain('"DC Out 1": power is not an input');
    for (const l of ["12V Power 1", "Tally Power", "Lamp"]) expect(out(l), l).not.toContain(`"${l}": power is not an input`);
    expect(out("Aux Power")).toContain('"Aux Power": power is not an input');
  });
});

describe("cards", () => {
  it("no dimensions or weight required", () => {
    const l = lintBlock(block({ deviceType: "expansion-card", slotFamily: "yamaha-my", heightMm: undefined, widthMm: undefined, depthMm: undefined, weightKg: undefined }));
    expect(l.warnings.some((w) => /no (height|width|depth)Mm|no weightKg/.test(w))).toBe(false);
  });
});

describe("Audio I/O and Telephony sections", () => {
  it("in the vocabulary, next to their neighbours", () => {
    expect(BLOCK_SECTIONS.indexOf("Audio I/O")).toBe(BLOCK_SECTIONS.indexOf("Audio Outputs") + 1);
    expect(BLOCK_SECTIONS.indexOf("Telephony")).toBe(BLOCK_SECTIONS.indexOf("Network") + 1);
  });
  it("configurable analog audio → Audio I/O without a bidirectional warning; POTS → Telephony", () => {
    const r = normalizeBlock(block({ ports: [
      { id: "a", label: "Audio 1", signalType: "analog-audio", direction: "bidirectional", section: "", connectorType: "phoenix", notes: "configurable input/output" },
      { id: "t", label: "Telco", signalType: "pots", direction: "bidirectional", section: "", connectorType: "rj11" },
      { id: "p", label: "AC Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" },
    ] }));
    const ports = r.template.ports as { id: string; section: string }[];
    expect(ports.find((p) => p.id === "a")!.section).toBe("Audio I/O");
    expect(ports.find((p) => p.id === "t")!.section).toBe("Telephony");
    expect(lintBlock(r.template).warnings.some((w) => w.includes("bidirectional"))).toBe(false);
  });
});
