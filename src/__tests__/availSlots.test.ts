/**
 * Phase 1.7: slot families (registry, several accepted families per slot), normalizer v3
 * (Sync, configurable HDBaseT, connector from signal, family renames and categories, category
 * plan), linter slot/card checks, Sony scope with retype, Normalize applied to the form.
 */
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { findCategory } from "../avail/library";
import { normalizeBlock, plannedCategory } from "../avail/normalize";
import { BLOCK_SECTIONS, CONFIGURABLE_NOTE, SIGNAL_CONNECTORS } from "../avail/sections";
import { acceptedFamilies, canonicalFamily, familyInfo, fitsSlot, SLOT_FAMILIES, slotLibraryContext, slotLibraryWarnings } from "../avail/slotFamilies";
import { applyTemplateToDeviceData } from "../avail/templateEdit";
import { VendorRules } from "../avail/vendorDecisions";
import { validateCardForSlot } from "../mcp/validation";

describe("slot family registry (docs/avail/slot-families.json)", () => {
  it("names are lower case <vendor>-<platform>-<slot-type> or an industry form factor; categories are leaves", () => {
    for (const f of SLOT_FAMILIES) {
      expect(f.name, f.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (f.category) expect(findCategory(f.category)?.leaf, f.name).toBe(true);
      for (const a of f.alsoAccepts ?? []) expect(familyInfo(a), `${f.name} → ${a}`).toBeDefined();
    }
    const names = SLOT_FAMILIES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("old names map to one family per physical format", () => {
    expect(canonicalFamily("Tesria IO")).toBe("biamp-tesira-server-card");
    for (const card of ["CIML4", "CIML4-HP", "COL4", "CODP4", "CAES4", "CDN64", "CIAES16"]) expect(canonicalFamily(card), card).toBe("qsc-core-io");
    expect(canonicalFamily("AH-dLive/Avantis-IO")).toBe("ah-dlive-io");
    expect(canonicalFamily("AH-dLive/SQ-IO")).toBe("ah-sq-io");
    expect(canonicalFamily("AH-SQ/AHM-IO")).toBe("ah-sq-io");
    expect(canonicalFamily("ah-sq-slink")).toBe("ah-sq-io");
    expect(canonicalFamily("ah-gld-m")).toBe("ah-ilive-gld-io");
    expect(canonicalFamily("Audio Interface Card")).toBe("yamaha-tf-ny");
    expect(canonicalFamily("OPS")).toBe("ops");
    expect(canonicalFamily("unknown-family")).toBe("unknown-family");
  });
});

describe("a slot accepting several families", () => {
  const qu2 = { slotFamily: "extron-quantum-ultra-2", slotFamilies: ["extron-quantum-ultra"] };
  it("slotFamily first, then slotFamilies; a single slotFamily works as before", () => {
    expect(acceptedFamilies(qu2)).toEqual(["extron-quantum-ultra-2", "extron-quantum-ultra"]);
    expect(acceptedFamilies({ slotFamily: "yamaha-my" })).toEqual(["yamaha-my"]);
    expect(fitsSlot(qu2, "extron-quantum-ultra")).toBe(true);
    expect(fitsSlot({ slotFamily: "extron-quantum-ultra" }, "extron-quantum-ultra-2")).toBe(false);
  });

  it("MCP install check uses the list", () => {
    expect(validateCardForSlot(acceptedFamilies(qu2), "extron-quantum-ultra")).toMatchObject({ ok: true });
    expect(validateCardForSlot("yamaha-my", "yamaha-my")).toMatchObject({ ok: true });
    expect(validateCardForSlot(acceptedFamilies(qu2), "yamaha-my")).toMatchObject({
      ok: false,
      error: 'Card slot family "yamaha-my" does not fit slot family "extron-quantum-ultra-2" or "extron-quantum-ultra".',
    });
  });
});

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t", label: "Extron X", shortName: "X", manufacturer: "Extron", modelNumber: "1", deviceType: "switcher",
  category: "AV distribution / Switchers", auxiliaryData: [{ text: "{{deviceType}}", position: "header" }], ports: [], ...over,
});

describe("normalizer v3", () => {
  it("Sync is a section: genlock / word clock / timecode", () => {
    expect(BLOCK_SECTIONS).toContain("Sync");
    const r = normalizeBlock(base({ ports: [{ id: "g", label: "Ref In", signalType: "genlock", direction: "input", section: "" }] }));
    expect((r.template.ports as Record<string, unknown>[])[0]).toMatchObject({ section: "Sync", connectorType: "bnc" });
  });

  it("connector from the signal only where it is unambiguous", () => {
    const ports = ["hdmi", "sdi", "ethernet", "dante", "avb", "hdbaset", "displayport", "analog-audio", "usb"].map((s, i) => ({
      id: `p${i}`, label: `${s} In`, signalType: s, direction: s === "ethernet" || s === "dante" || s === "avb" || s === "usb" ? "bidirectional" : "input", section: "",
    }));
    const out = normalizeBlock(base({ ports })).template.ports as { signalType: string; connectorType?: string }[];
    const bySig = Object.fromEntries(out.map((p) => [p.signalType, p.connectorType]));
    expect(bySig).toMatchObject({ hdmi: "hdmi", sdi: "bnc", ethernet: "rj45", dante: "rj45", avb: "rj45", hdbaset: "rj45", displayport: "displayport" });
    expect(bySig["analog-audio"]).toBeUndefined();
    expect(bySig.usb).toBeUndefined();
    expect(SIGNAL_CONNECTORS["analog-audio"]).toBeUndefined();
  });

  it("HDBaseT I/O: bidirectional is allowed, noted as configurable, no linter warning", () => {
    const port = { id: "d", label: "DTP3 I/O 1", signalType: "hdbaset", direction: "bidirectional", section: "", connectorType: "rj45" };
    const r = normalizeBlock(base({ ports: [port] }));
    expect((r.template.ports as Record<string, unknown>[])[0]).toMatchObject({ direction: "bidirectional", notes: CONFIGURABLE_NOTE, section: "Video Inputs (Configurable)" });
    expect(lintBlock(r.template).warnings.some((w) => w.includes("bidirectional"))).toBe(false);
    // An HDBaseT port that says Out is an output.
    expect((normalizeBlock(base({ ports: [{ ...port, label: "DTP Out" }] })).template.ports as Record<string, unknown>[])[0]).toMatchObject({ direction: "output" });
  });

  it("slot families renamed; Quantum Ultra II slots also accept Quantum Ultra cards; card category from its family", () => {
    const chassis = normalizeBlock(base({
      deviceType: "frame", category: "",
      slots: [{ id: "s1", label: "Slot 1", slotFamily: "extron-quantum-ultra-2" }, { id: "s2", label: "Slot 2", slotFamily: "CIML4" }],
    })).template as unknown as { slots: { slotFamily: string; slotFamilies?: string[] }[]; category: string };
    expect(chassis.slots[0]).toMatchObject({ slotFamily: "extron-quantum-ultra-2", slotFamilies: ["extron-quantum-ultra"] });
    expect(chassis.slots[1]).toMatchObject({ slotFamily: "qsc-core-io" });
    expect(chassis.category).toBe("Processing / Videowall Processors");
    const card = normalizeBlock(base({ deviceType: "expansion-card", category: "", slotFamily: "AH-dLive/Avantis-IO" })).template;
    expect(card).toMatchObject({ slotFamily: "ah-dlive-io", category: "Audio Products / Mixers" });
  });

  it("category plan by id wins; a missing category takes a BoQ-only default", () => {
    expect(plannedCategory("11075238-5055-471e-97b9-70407ff4e0fc")).toBe("Control Systems / eBUS");
    const r = normalizeBlock(base({ id: "11075238-5055-471e-97b9-70407ff4e0fc", deviceType: "controller", category: "" }));
    expect(r.template.category).toBe("Control Systems / eBUS");
    expect(normalizeBlock(base({ deviceType: "cable-accessory", category: "" })).template.category).toBe("Connectivity / Cables & Adapters");
  });
});

describe("linter: slots and cards against the library", () => {
  const host = base({ deviceType: "frame", slots: [{ id: "s", label: "Slot 1", slotFamily: "yamaha-hy" }, { id: "s2", label: "Slot 2", slotFamily: "yamaha-hy" }] });
  const card = base({ deviceType: "expansion-card", slotFamily: "sd-card" });

  it("a slot no card fits and a card no chassis takes are warnings (once per family)", () => {
    const ctx = slotLibraryContext([host, card] as never);
    expect(slotLibraryWarnings(host, ctx)).toEqual(['slots of family "yamaha-hy": no card in the library fits']);
    expect(slotLibraryWarnings(card, ctx)).toEqual(['card family "sd-card": no chassis in the library has this slot']);
    expect(lintBlock(host, ctx).warnings).toContain('slots of family "yamaha-hy": no card in the library fits');
    expect(lintBlock(host).warnings.some((w) => w.includes("no card"))).toBe(false); // no context, no check
  });

  it("alsoAccepts counts: Quantum Ultra II slots are fine with only first-generation cards", () => {
    const qu2 = base({ deviceType: "frame", slots: [{ id: "s", label: "Slot 1", slotFamily: "extron-quantum-ultra-2" }] });
    const qu1card = base({ deviceType: "expansion-card", slotFamily: "extron-quantum-ultra" });
    expect(slotLibraryWarnings(qu2, slotLibraryContext([qu2, qu1card] as never))).toEqual([]);
  });

  it("a card is powered by its chassis: no power port or power figure required", () => {
    const l = lintBlock(base({ deviceType: "expansion-card", slotFamily: "yamaha-my", ports: [] }));
    expect(l.errors).not.toContain("no power port");
    expect(l.warnings).not.toContain("no powerDrawW/voltage (or poeDrawW)");
  });
});

describe("Sony scope (vendor-decisions.json)", () => {
  const rules = new VendorRules();
  it("PTZ cameras and PTZ controllers stay; BRC/SRG/FR7 filed as camera become ptz-camera; camcorders and studio cameras go", () => {
    expect(rules.classify({ manufacturer: "Sony", deviceType: "ptz-camera", label: "Sony SRG-A40" })).toMatchObject({ kind: "keep" });
    expect(rules.classify({ manufacturer: "Sony", deviceType: "ptz-controller", label: "Sony RM-IP10" })).toMatchObject({ kind: "keep" });
    expect(rules.classify({ manufacturer: "Sony", deviceType: "camera", label: "Sony BRC-X1000", modelNumber: "BRC-X1000" })).toMatchObject({ kind: "keep", deviceType: "ptz-camera" });
    for (const [label, mn] of [["Sony PXW-FX9", "PXW-FX9"], ["Sony HDC-3500", "HDC-3500"], ["Sony HXC-D70", "HXC-D70"], ["Sony a6100", "ILCE-6100"]]) {
      expect(rules.classify({ manufacturer: "Sony", deviceType: "camera", label, modelNumber: mn }).kind, label).toBe("scope");
    }
  });
});

describe("Normalize applied to the form", () => {
  it("editor fields and ports come from the normalized template, node-only fields stay, removed fields go", () => {
    const data = { label: "x", color: "#f00", templateId: "t1", hiddenPorts: ["a"], ports: [{ id: "a", label: "Old" }] };
    const out = applyTemplateToDeviceData(data, { label: "Extron X", ports: [{ id: "a", label: "New" }] });
    expect(out).toEqual({ label: "Extron X", templateId: "t1", hiddenPorts: ["a"], ports: [{ id: "a", label: "New" }] });
  });
});
