/**
 * src/avail/blockLint.ts — the AVAIL Device Block Standard linter, and the reference
 * data helpers in src/avail/library.ts (taxonomy, vendors).
 *
 * Until v0.2 the TS linter was checked for parity with tools/avail/avail_block_lint.py;
 * since v0.3 (category / manufacturer / Generic rules) TS is the only implementation
 * and the Python script is an archive.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blocksOf, formatBlockReport, genericModelNumber, lintBlock, lintDocument } from "../avail/blockLint";
import {
  defaultCategoryFor,
  findCategory,
  findVendor,
  normalizeManufacturer,
  TAXONOMY,
  VENDORS,
} from "../avail/library";
import type { DeviceTemplate } from "../types";

const FIXTURE = fileURLToPath(new URL("../../tools/avail/fixtures/engineer-blocks.json", import.meta.url));
const fixture: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));

/** A block that passes every rule (level A); tests change one thing at a time. */
function clean(): DeviceTemplate & Record<string, unknown> {
  return {
    label: "Extron DTP3 T 203",
    model: "Extron DTP3 T 203",
    modelNumber: "60-1885-52",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
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

/** A Generic block by the standard: no physics, no referenceUrl. */
function generic(): DeviceTemplate & Record<string, unknown> {
  const { heightMm: _h, widthMm: _w, depthMm: _d, weightKg: _k, powerDrawW: _p, voltage: _v, referenceUrl: _r, ...rest } = clean();
  return {
    ...rest,
    label: "Generic Room PC",
    model: "Generic Room PC",
    modelNumber: "GEN-ROOM-PC",
    shortName: "Room PC",
    manufacturer: "Generic",
    deviceType: "computer",
    category: "Other / Generic",
  } as DeviceTemplate & Record<string, unknown>;
}

describe("reference data (docs/avail)", () => {
  it("every deviceTypeDefaults target is a leaf category of the taxonomy", () => {
    for (const [type, path] of Object.entries(TAXONOMY.deviceTypeDefaults)) {
      if (path === null) continue;
      expect(findCategory(path)?.leaf, `${type} → ${path}`).toBe(true);
    }
  });

  it("no name or alias points to two different vendors (case-insensitive)", () => {
    const owner = new Map<string, string>();
    for (const v of VENDORS) {
      for (const n of [v.name, ...v.aliases]) {
        const k = n.toLowerCase();
        expect(owner.get(k) ?? v.name, n).toBe(v.name);
        owner.set(k, v.name);
      }
    }
  });

  it("normalizeManufacturer: aliases and case to the canonical name, others trimmed", () => {
    expect(normalizeManufacturer("Biamp Systems")).toBe("Biamp");
    expect(normalizeManufacturer("biamp")).toBe("Biamp");
    expect(normalizeManufacturer("  NETGEAR AV ")).toBe("Netgear-AV");
    expect(normalizeManufacturer("NETGEAR")).toBe("Netgear-AV");
    expect(normalizeManufacturer("WyreStorm")).toBe("Wyrestorm");
    expect(normalizeManufacturer("NEC")).toBe("Sharp");
    expect(normalizeManufacturer("tvONE")).toBe("TV One");
    expect(normalizeManufacturer("Blackmagic  Design ")).toBe("Blackmagic Design");
    expect(normalizeManufacturer("Martin")).toBe("Martin"); // lighting, not Martin Audio
    expect(normalizeManufacturer("")).toBeUndefined();
    expect(findVendor("Generic")?.name).toBe("Generic");
  });

  it("defaultCategoryFor: mapped, null and unknown device types", () => {
    expect(defaultCategoryFor("audio-dsp")).toBe("Audio Products / DSP");
    expect(defaultCategoryFor("camera")).toBeNull();
    expect(defaultCategoryFor("no-such-type")).toBeNull();
    expect(defaultCategoryFor("toString")).toBeNull();
    expect(defaultCategoryFor(undefined)).toBeNull();
  });
});

describe("lintBlock: card, physics and port rules (v0.2)", () => {
  it("a complete block is level A", () => {
    expect(lintBlock(clean())).toEqual({ level: "A", errors: [], warnings: [] });
  });

  it("warnings only → B, any error → FIX", () => {
    expect(lintBlock({ ...clean(), color: "#f00" }).level).toBe("B");
    expect(lintBlock({ ...clean(), modelNumber: "" })).toMatchObject({ level: "FIX", errors: ["no modelNumber"] });
  });

  it("missing power port is an error unless PoE, slots, speaker or antenna", () => {
    const noPower = { ...clean(), ports: clean().ports.filter((p) => p.signalType !== "power") };
    expect(lintBlock(noPower).errors).toContain("no power port");
    expect(lintBlock({ ...noPower, poeDrawW: 10 }).errors).not.toContain("no power port");
    expect(lintBlock({ ...noPower, deviceType: "antenna" }).errors).not.toContain("no power port");
  });

  it("section order and vocabulary", () => {
    const [hdmi, dtp, rs232, power] = clean().ports;
    expect(lintBlock({ ...clean(), ports: [power, hdmi, dtp, rs232] }).warnings).toContain("sections are not in the standard order");
    expect(lintBlock({ ...clean(), ports: [{ ...hdmi, section: "Rear" }, power] }).errors).toContain('"HDMI In": section "Rear" is not in the vocabulary; use "Video Inputs"');
  });

  it("keeps the v0.2 Python semantics: [] and 0 are missing, Unicode \\b, code-point length", () => {
    expect(lintBlock({ ...clean(), searchTerms: [] }).warnings).toEqual(["no searchTerms"]);
    expect(lintBlock({ ...clean(), heightMm: 0 }).warnings).toEqual(["no heightMm"]);
    const [hdmi, ...rest] = clean().ports;
    expect(lintBlock({ ...clean(), ports: [hdmi, { ...hdmi, label: "кdtp" }, ...rest] }).level).toBe("A");
    expect(lintBlock({ ...clean(), ports: [hdmi, { ...hdmi, label: "😀".repeat(15) }, ...rest] }).level).toBe("A");
  });

  it("never throws on malformed input", () => {
    for (const bad of [{}, { ports: null }, { ports: [null, 1, "x"] }, { auxiliaryData: "x", label: 5, category: 7 }]) {
      expect(() => lintBlock(bad)).not.toThrow();
    }
  });
});

describe("lintBlock: category (avail-taxonomy.json)", () => {
  it("leaf category with schematic=true passes", () => {
    expect(lintBlock({ ...clean(), category: "AV distribution / XTP Systems" }).level).toBe("A");
  });

  it("missing category is an error", () => {
    expect(lintBlock({ ...clean(), category: "" })).toEqual({ level: "FIX", errors: ["no category"], warnings: [] });
  });

  it("unknown path or a group (non-leaf) category is an error", () => {
    expect(lintBlock({ ...clean(), category: "KVM / Extenders" })).toMatchObject({
      level: "FIX",
      errors: ['category "KVM / Extenders" is not a leaf category of avail-taxonomy.json'],
    });
    expect(lintBlock({ ...clean(), category: "AV distribution" }).errors).toEqual([
      'category "AV distribution" is not a leaf category of avail-taxonomy.json',
    ]);
  });

  it("schematic=false category is an error for a block", () => {
    expect(lintBlock({ ...clean(), category: "Connectivity / Bulk Cables" })).toMatchObject({
      level: "FIX",
      errors: ['category "Connectivity / Bulk Cables" is not for schematic blocks (schematic=false)'],
    });
  });
});

describe("lintBlock: manufacturer (avail-vendors.json)", () => {
  it("alias instead of the canonical name", () => {
    const b = { ...clean(), manufacturer: "Biamp Systems", label: "Biamp Systems X", model: "Biamp Systems X" };
    expect(lintBlock(b).warnings).toEqual(['manufacturer "Biamp Systems" is an alias, use "Biamp"']);
    expect(lintBlock({ ...clean(), manufacturer: "EXTRON" }).warnings).toEqual(['manufacturer "EXTRON" is an alias, use "Extron"']);
  });

  it("vendor outside the portfolio", () => {
    const b = { ...clean(), manufacturer: "ASUS", label: "ASUS NUC", model: "ASUS NUC" };
    expect(lintBlock(b).warnings).toEqual(['manufacturer "ASUS" is not in avail-vendors.json (outside the portfolio use Generic)']);
  });
});

describe("lintBlock: Generic", () => {
  it("Generic block without physics and referenceUrl is level A", () => {
    expect(lintBlock(generic())).toEqual({ level: "A", errors: [], warnings: [] });
  });

  it("non-Generic block without physics is not", () => {
    const { manufacturer: _m, ...g } = generic();
    expect(lintBlock({ ...g, manufacturer: "Extron", label: "Extron PC", model: "Extron PC" }).warnings).toEqual(
      expect.arrayContaining(["no heightMm", "no powerDrawW/voltage (or poeDrawW)", "no referenceUrl"]),
    );
  });

  it("label must be \"Generic <class>\"", () => {
    const b = { ...generic(), label: "Generic", model: "Generic" };
    expect(lintBlock(b).warnings).toEqual(['Generic: label must be "Generic <class>"']);
  });

  it("modelNumber must be GEN-<CLASS> of the label", () => {
    expect(lintBlock({ ...generic(), modelNumber: "GEN-PC" }).warnings).toEqual(['Generic: modelNumber must be "GEN-ROOM-PC"']);
    expect(lintBlock({ ...generic(), modelNumber: "NUC13" }).warnings).toEqual(['Generic: modelNumber must be "GEN-ROOM-PC"']);
    expect(lintBlock({ ...generic(), modelNumber: "" }).errors).toEqual(["no modelNumber"]);
  });

  it("genericModelNumber", () => {
    expect(genericModelNumber("Generic Laptop")).toBe("GEN-LAPTOP");
    expect(genericModelNumber("Generic Room PC")).toBe("GEN-ROOM-PC");
    expect(genericModelNumber("Generic USB-C / HDMI adapter")).toBe("GEN-USB-C-HDMI-ADAPTER");
    expect(genericModelNumber("Generic Ноутбук")).toBe("GEN-НОУТБУК");
  });
});

describe("engineer blocks (tools/avail/fixtures/engineer-blocks.json)", () => {
  const rows = lintDocument(fixture);

  it("reads every device node of the schematic", () => {
    expect(rows.length).toBe(22);
  });

  it("levels: all FIX — their categories are EasySchematic's, not the taxonomy's", () => {
    expect(formatBlockReport(rows).trimEnd().split("\n").at(-1)).toBe("Total: A 0 / B 0 / FIX 22");
  });

  it("every block gets a category error", () => {
    for (const r of rows) expect(r.errors.some((e) => e.startsWith('category "')), r.label).toBe(true);
  });

  it("vendors: Netgear and WyreStorm aliases (accounting-system spellings), ASUS and Absen outside the portfolio", () => {
    const msgs = rows.flatMap((r) => r.warnings).filter((w) => w.startsWith("manufacturer"));
    expect(msgs.sort()).toEqual([
      'manufacturer "ASUS" is not in avail-vendors.json (outside the portfolio use Generic)',
      'manufacturer "Absen" is not in avail-vendors.json (outside the portfolio use Generic)',
      'manufacturer "Netgear" is an alias, use "Netgear-AV"',
      'manufacturer "WyreStorm" is an alias, use "Wyrestorm"',
    ]);
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
