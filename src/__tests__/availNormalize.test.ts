/**
 * src/avail/normalize.ts — the block auto-normalizer: mechanical fixes towards the
 * AVAIL Device Block Standard, nothing invented, ambiguous cases flagged as manual.
 */
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { appliedChanges, isCapsLabel, normalizeBlock, sectionByPurpose, standardCaseLabel } from "../avail/normalize";

type P = { id: string; label: string; signalType: string; direction: string; section?: string; connectorType?: string };
const port = (id: string, over: Partial<P> = {}): P => ({
  id,
  label: `Port ${id}`,
  signalType: "hdmi",
  direction: "input",
  connectorType: "hdmi",
  ...over,
});

function block(over: Record<string, unknown> = {}) {
  return {
    label: "Extron DTP3 T 203",
    modelNumber: "60-1885-52",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    ports: [port("1", { section: "Video Inputs" }), port("2", { label: "Power", signalType: "power", section: "Power", connectorType: "barrel" })],
    ...over,
  };
}

const field = (changes: { field: string }[], f: string) => changes.filter((c) => c.field === f);

describe("normalizeBlock: card", () => {
  it("a block already by the standard is left alone", () => {
    const b = block();
    const r = normalizeBlock(b);
    expect(r.changes).toEqual([]);
    expect(r.template).toEqual(b);
  });

  it("header → the single row {{deviceType}}; other rows are replaced", () => {
    for (const aux of [undefined, [], [{ text: "{{modelNumber}}" }], [{ text: "{{deviceType}}" }, { text: "{{modelNumber}}", position: "footer" }]]) {
      const r = normalizeBlock(block({ auxiliaryData: aux }));
      expect(r.template.auxiliaryData, JSON.stringify(aux)).toEqual([{ text: "{{deviceType}}", position: "header" }]);
      expect(field(r.changes, "auxiliaryData")).toHaveLength(1);
      expect(lintBlock(r.template).warnings).not.toContain("header is not {{deviceType}}");
    }
    // A footer-positioned {{deviceType}} row passes the linter, so it is left as it is.
    expect(field(normalizeBlock(block({ auxiliaryData: [{ text: "{{deviceType}}" }] })).changes, "auxiliaryData")).toEqual([]);
  });

  it("color is removed; an empty color goes silently", () => {
    const r = normalizeBlock(block({ color: "#7c3aed" }));
    expect("color" in r.template).toBe(false);
    expect(field(r.changes, "color")).toEqual([expect.objectContaining({ from: "#7c3aed" })]);
    expect(lintBlock(r.template).warnings).not.toContain("color is set");
    const empty = normalizeBlock(block({ color: "" }));
    expect("color" in empty.template).toBe(false);
    expect(field(empty.changes, "color")).toEqual([]);
  });

  it("does not modify its input", () => {
    const b = block({ manufacturer: "WYRESTORM", label: "WYRESTORM X" });
    const copy = structuredClone(b);
    normalizeBlock(b);
    expect(b).toEqual(copy);
  });

  it("manufacturer alias → canonical; label prefix follows", () => {
    const r = normalizeBlock(block({ manufacturer: "Biamp Systems", label: "Biamp Systems TesiraFORTE X 400", shortName: "TesiraFORTE X 400" }));
    expect(r.template).toMatchObject({ manufacturer: "Biamp", label: "Biamp TesiraFORTE X 400" });
  });

  it("label without the manufacturer gets it in front", () => {
    expect(normalizeBlock(block({ manufacturer: "Shure", label: "MXA925", shortName: "MXA925" })).template.label).toBe("Shure MXA925");
  });

  it("label prefix in another case is replaced, a longer word is not mistaken for it", () => {
    expect(normalizeBlock(block({ label: "EXTRON DTP3 T 203" })).template.label).toBe("Extron DTP3 T 203");
    expect(normalizeBlock(block({ manufacturer: "Sharp", label: "Sharpvision X", shortName: "X" })).template.label).toBe("Sharp Sharpvision X");
  });

  it("shortName: model from label when empty or a part number", () => {
    expect(normalizeBlock(block({ shortName: "" })).template.shortName).toBe("DTP3 T 203");
    expect(normalizeBlock(block({ shortName: "60-1885-52" })).template.shortName).toBe("DTP3 T 203");
    expect(field(normalizeBlock(block({ shortName: "DTP3" })).changes, "shortName")).toEqual([]);
  });

  it("no manufacturer: label and shortName left, flagged for a human", () => {
    const r = normalizeBlock(block({ manufacturer: "", shortName: "" }));
    expect(r.template.label).toBe("Extron DTP3 T 203");
    expect(r.template.shortName).toBe("");
    expect(r.changes.filter((c) => c.manual).map((c) => c.field)).toEqual(["manufacturer", "shortName"]);
  });

  it("category from deviceTypeDefaults when not a schematic leaf; manual when there is no default", () => {
    expect(normalizeBlock(block({ category: "KVM / Extenders" })).template.category).toBe("AV distribution / Extenders");
    expect(normalizeBlock(block({ category: undefined, deviceType: "charging-station" })).template.category).toBe("Microphones / Wireless microphones");
    const r = normalizeBlock(block({ category: "Cameras", deviceType: "camera" }));
    expect(r.template.category).toBe("Cameras");
    expect(field(r.changes, "category")[0]).toMatchObject({ manual: true });
  });

  it("a BoQ-only leaf (schematic=false) is a decision: kept, flagged", () => {
    const r = normalizeBlock(block({ category: "Connectivity / Cables & Adapters", deviceType: "adapter" }));
    expect(r.template.category).toBe("Connectivity / Cables & Adapters");
    expect(field(r.changes, "category")[0]).toMatchObject({ manual: true, note: expect.stringContaining("BoQ-only") });
  });
});

describe("normalizeBlock: port labels", () => {
  it("caps → standard form with known words and abbreviations", () => {
    expect(standardCaseLabel("HDMI INPUT 1")).toBe("HDMI Input 1");
    expect(standardCaseLabel("LAN (POE+)")).toBe("LAN (PoE+)");
    expect(standardCaseLabel("RS-232 PORT")).toBe("RS-232 Port");
    expect(standardCaseLabel("IN/OUT 12V")).toBe("In/Out 12V");
    expect(standardCaseLabel("EBUS CONTROL")).toBe("eBUS Control");
  });

  it("an unknown word stops the fix: nothing invented", () => {
    expect(standardCaseLabel("LOBE 1 OUT")).toBeNull();
    const r = normalizeBlock(block({ ports: [port("1", { label: "LOBE 1 OUT", section: "Video Inputs" })] }));
    expect(r.template.ports[0].label).toBe("LOBE 1 OUT");
    expect(field(r.changes, "ports[1].label")[0]).toMatchObject({ manual: true });
  });

  it("only abbreviations (still caps after the fix) is flagged, not changed", () => {
    const r = normalizeBlock(block({ ports: [port("1", { label: "HDMI LAN", section: "Video Inputs" })] }));
    expect(r.template.ports[0].label).toBe("HDMI LAN");
    expect(field(r.changes, "ports[1].label")[0]).toMatchObject({ manual: true });
  });

  it("isCapsLabel matches the linter's rule", () => {
    expect(isCapsLabel("HDMI IN")).toBe(true);
    expect(isCapsLabel("HDMI")).toBe(false);
    expect(isCapsLabel("HDMI In")).toBe(false);
  });
});

describe("normalizeBlock: direction", () => {
  it("LAN / Dante / AVB / RS-232 / GPIO → bidirectional; passthrough and video untouched", () => {
    const ports = ["ethernet", "dante", "avb", "serial", "gpio"].map((s, i) => port(String(i), { signalType: s, direction: "input", section: "Control" }));
    const r = normalizeBlock(block({ ports: [...ports, port("p", { signalType: "ethernet", direction: "passthrough", section: "Network" })] }));
    const dir = Object.fromEntries(r.template.ports.map((p) => [p.id, p.direction]));
    expect(dir).toEqual({ 0: "bidirectional", 1: "bidirectional", 2: "bidirectional", 3: "bidirectional", 4: "bidirectional", p: "passthrough" });
    expect(normalizeBlock(block()).template.ports[0].direction).toBe("input");
  });
});

describe("normalizeBlock: sections", () => {
  const sectionOf = (over: Partial<P>) => normalizeBlock(block({ ports: [port("x", over)] })).template.ports[0].section;

  it("community names → standard names", () => {
    expect(sectionOf({ section: "Dante Network", signalType: "dante", direction: "bidirectional" })).toBe("Dante");
    expect(sectionOf({ section: "Lan", signalType: "ethernet", direction: "bidirectional" })).toBe("Network");
    expect(sectionOf({ section: "Audio In", signalType: "analog-audio" })).toBe("Audio Inputs");
    expect(sectionOf({ section: "Speaker Out", signalType: "speaker-level", direction: "output" })).toBe("Speaker Outputs");
    expect(sectionOf({ section: "GPIO", signalType: "gpio", direction: "bidirectional" })).toBe("Digital I/O");
  });

  it("Inputs / Outputs → Video or Audio by signal type", () => {
    expect(sectionOf({ section: "Inputs", signalType: "hdmi", direction: "input" })).toBe("Video Inputs");
    expect(sectionOf({ section: "Outputs", signalType: "analog-audio", direction: "output" })).toBe("Audio Outputs");
    expect(sectionOf({ section: "Inputs", signalType: "ethernet", direction: "bidirectional" })).toBe("Network");
  });

  it("Back of unit / empty → by purpose; Front of unit adds (Front) to the label", () => {
    expect(sectionOf({ section: "Back of unit", signalType: "hdmi", direction: "output" })).toBe("Video Outputs");
    expect(sectionOf({ section: undefined, signalType: "power", direction: "input" })).toBe("Power");
    const r = normalizeBlock(block({ ports: [port("u", { label: "USB", section: "Front of unit", signalType: "usb", direction: "bidirectional" })] }));
    expect(r.template.ports[0]).toMatchObject({ section: "USB", label: "USB (Front)" });
  });

  it("keeps a clarification in brackets", () => {
    expect(sectionOf({ section: "Pass-Thru (TP Tx)", signalType: "serial", direction: "bidirectional" })).toBe("Serial (TP Tx)");
    expect(sectionOf({ section: "Mic/Line Inputs (with phantom)", signalType: "analog-audio" })).toBe("Audio Inputs (with phantom)");
  });

  it("ambiguous → unchanged and manual", () => {
    const cases: Partial<P>[] = [
      { section: "Back of unit", signalType: "analog-audio", direction: "bidirectional" },
      { section: "Rear", signalType: "custom", direction: "input" },
      { section: "Rear", signalType: "usb", label: "USB-C (DP Alt)", direction: "input" },
      { section: "Rear", signalType: "contact-closure", direction: "bidirectional" },
    ];
    for (const c of cases) {
      const r = normalizeBlock(block({ ports: [port("x", c)] }));
      expect(r.template.ports[0].section, JSON.stringify(c)).toBe(c.section);
      expect(field(r.changes, "ports[x].section")[0], JSON.stringify(c)).toMatchObject({ manual: true });
    }
  });

  it("new pairs: speaker input, fiber, DMX / MIDI, proprietary buses", () => {
    const cases: [Partial<P>, string][] = [
      [{ signalType: "speaker-level", direction: "input", label: "Speaker In" }, "Audio Inputs"],
      [{ signalType: "fiber", direction: "input", label: "Fiber In 1", connectorType: "lc" }, "Video Inputs"],
      [{ signalType: "fiber", direction: "output", label: "Fiber Out 1", connectorType: "lc" }, "Video Outputs"],
      [{ signalType: "fiber", direction: "bidirectional", label: "SFP+ 1", connectorType: "sfp" }, "Network"],
      [{ signalType: "dmx", direction: "output", label: "DMX Out" }, "Control"],
      [{ signalType: "midi", direction: "input", label: "MIDI In" }, "Control"],
      [{ signalType: "gigaace", direction: "bidirectional", label: "gigaACE" }, "Expansion"],
      [{ signalType: "ydif", direction: "output", label: "YDIF Out" }, "Expansion"],
      [{ signalType: "dxlink", direction: "bidirectional", label: "DX A" }, "Expansion"],
      [{ signalType: "genlock", direction: "input", label: "Ref In" }, "Sync"],
      [{ signalType: "wordclock", direction: "output", label: "WC Out" }, "Sync"],
      [{ signalType: "timecode", direction: "bidirectional", label: "LTC" }, "Sync"],
      [{ signalType: "bluetooth", direction: "bidirectional", label: "Bluetooth" }, "RF"],
      [{ signalType: "sensor", direction: "input", label: "Sensor" }, "Control"],
      [{ signalType: "hdbaset", direction: "bidirectional", label: "DTP3 I/O 1" }, "Video Inputs (Configurable)"],
    ];
    for (const [c, want] of cases) {
      const r = normalizeBlock(block({ ports: [port("x", { section: "", ...c })] }));
      expect(r.template.ports[0].section, JSON.stringify(c)).toBe(want);
    }
  });

  it("slot ports and standard sections are not touched", () => {
    expect(sectionOf({ section: "Slot 1", signalType: "hdmi" })).toBe("Slot 1");
    expect(sectionOf({ section: "Video Inputs (Front)", signalType: "hdmi" })).toBe("Video Inputs (Front)");
  });

  it("contact closure: output → Relays, input → Control", () => {
    expect(sectionByPurpose({ signalType: "contact-closure", direction: "output" })).toBe("Relays");
    expect(sectionByPurpose({ signalType: "contact-closure", direction: "input" })).toBe("Control");
  });

  it("orders ports by the standard's section order, stable within a section", () => {
    const r = normalizeBlock(block({
      ports: [
        port("pw", { signalType: "power", section: "Power" }),
        port("o1", { direction: "output", section: "Video Outputs" }),
        port("i1", { section: "Video Inputs" }),
        port("x", { section: "Slot 2" }),
        port("i2", { section: "Video Inputs" }),
      ],
    }));
    expect(r.template.ports.map((p) => p.id)).toEqual(["i1", "i2", "o1", "pw", "x"]);
    expect(field(r.changes, "ports.order")).toHaveLength(1);
  });
});

describe("normalizeBlock improves the lint level", () => {
  it("a typical community block goes from FIX to B", () => {
    const community = {
      label: "WYRESTORM NHD-500-TX",
      manufacturer: "WYRESTORM",
      modelNumber: "NHD-500-TX",
      shortName: "",
      deviceType: "avoip-encoder",
      category: "Video",
      ports: [
        port("1", { label: "POWER 12V", signalType: "power", section: "Back of unit", connectorType: "barrel" }),
        port("2", { label: "LAN (POE)", signalType: "ethernet", direction: "input", section: "Back of unit", connectorType: "rj45" }),
        port("3", { label: "HDMI INPUT", section: "Back of unit" }),
        port("4", { label: "HDMI LOOP OUT", direction: "output", section: "Back of unit" }),
      ],
    };
    expect(lintBlock(community).level).toBe("FIX");
    const r = normalizeBlock(community);
    expect(lintBlock(r.template)).toMatchObject({ level: "B", errors: [] });
    expect(r.template).toMatchObject({ manufacturer: "Wyrestorm", label: "Wyrestorm NHD-500-TX", shortName: "NHD-500-TX", category: "AV distribution / AVoIP" });
    expect(r.template.ports.map((p) => `${p.section}: ${p.label}`)).toEqual([
      "Video Inputs: HDMI Input",
      "Video Outputs: HDMI Loop Out",
      "Network: LAN (PoE)",
      "Power: POWER 12V", // one word by the linter's rule: not "caps", left as is
    ]);
    expect(appliedChanges(r.changes).length).toBeGreaterThan(0);
  });
});

describe("normalizeBlock: direction of physical signals (v2)", () => {
  const dir = (c: Partial<P>) => {
    const r = normalizeBlock(block({ ports: [port("x", { section: "", direction: "bidirectional", ...c })] }));
    return { port: r.template.ports[0] as P & { notes?: string }, changes: field(r.changes, "ports[x].direction") };
  };

  it("from the label: In / Input / Mic / Rx → input; Out / Output / Loop / Thru / Monitor / Tx → output", () => {
    for (const label of ["HDMI In 1", "Input 3", "Mic 2", "Line In", "HDBaseT Rx"]) expect(dir({ label }).port.direction, label).toBe("input");
    for (const label of ["HDMI Out", "Output 2", "HDMI Loop", "SDI Thru", "Monitor", "HDBaseT Tx"]) expect(dir({ label }).port.direction, label).toBe("output");
    for (const signalType of ["analog-audio", "speaker-level", "ir", "sdi", "displayport", "vga", "dvi", "hdbaset"]) {
      expect(dir({ signalType, label: "Out 1" }).port.direction, signalType).toBe("output");
    }
  });

  it("the section follows from the inferred direction", () => {
    expect(dir({ label: "HDMI Out 2" }).port.section).toBe("Video Outputs");
    expect(dir({ signalType: "analog-audio", label: "Mic/Line In 4" }).port.section).toBe("Audio Inputs");
  });

  it("HDMI with eARC / ARC stays an input; the audio return goes in notes", () => {
    const r = dir({ label: "HDMI 1 (eARC)" });
    expect(r.port.direction).toBe("input");
    expect(r.port.notes).toBe("(e)ARC: audio return to the source");
    expect(dir({ label: "HDMI ARC", notes: "audio return to the TV" } as Partial<P>).port.notes).toBe("audio return to the TV");
  });

  it("not inferable → unchanged, \"check against the panel\"", () => {
    for (const label of ["HDMI", "Audio 1", "In/Out"]) {
      const r = dir({ signalType: label === "HDMI" ? "hdmi" : "analog-audio", label });
      expect(r.port.direction, label).toBe("bidirectional");
      if (label !== "In/Out") expect(r.changes[0], label).toMatchObject({ manual: true, note: expect.stringContaining("check against the panel") });
    }
  });

  it("exempt: partyline intercom, TRRS / headset, pass-through, In/Out; other signals untouched", () => {
    for (const c of [
      { signalType: "analog-audio", label: "Partyline 1" },
      { signalType: "analog-audio", label: "Mobile (TRRS)" },
      { signalType: "ir", label: "IR Pass-Thru TP Tx 1" },
      { signalType: "analog-audio", label: "Audio In/Out" },
      { signalType: "usb", label: "USB Out" },
    ]) {
      const r = dir(c);
      expect(r.port.direction, c.label).toBe("bidirectional");
      expect(r.changes, c.label).toEqual([]);
    }
  });

  it("the linter warns about bidirectional physical signals and hints the section", () => {
    const bad = { ...block(), ports: [port("x", { label: "HDMI Out", direction: "bidirectional", section: "Rear" })] };
    const lint = lintBlock(bad);
    expect(lint.warnings).toContain('"HDMI Out": hdmi must be input or output, not bidirectional');
    expect(lint.errors).toContain('"HDMI Out": section "Rear" is not in the vocabulary; use "Video Outputs"');
    expect(lintBlock({ ...block(), ports: [port("y", { label: "Thing", signalType: "custom", section: "" })] }).errors).toContain('"Thing": no section');
  });
});

