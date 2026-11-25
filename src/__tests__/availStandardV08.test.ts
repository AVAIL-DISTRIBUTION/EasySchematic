/**
 * Standard v0.8: errors (E) only for what breaks the schematic or the specification, the rest of
 * the presentation rules are warnings (W); "Control" is a common section for control ports.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { normalizeBlock } from "../avail/normalize";

const here = path.dirname(fileURLToPath(import.meta.url));
type Port = Record<string, unknown>;
const dtp3 = (): Record<string, unknown> & { ports: Port[] } =>
  JSON.parse(readFileSync(path.join(here, "../../library/avail/extron-dtp3-t-203.json"), "utf8"));

describe("standard v0.8", () => {
  it("the reference block is level A", () => {
    expect(lintBlock(dtp3())).toMatchObject({ level: "A", errors: [], warnings: [] });
  });

  it("Control is a common section for serial, IR, relays, digital I/O and tally", () => {
    const control = (p: Port) => (["serial", "ir", "contact-closure", "gpio", "tally"].includes(String(p.signalType)) ? { ...p, section: "Control" } : p);
    const t = dtp3();
    const ports = t.ports.map(control);
    // Control sits between Digital I/O and Sync in the order: the configuration and power ports follow.
    const l = lintBlock({ ...t, ports });
    expect(l.errors).toEqual([]);
    expect(l.warnings).toEqual([]);
    expect(l.level).toBe("A");
  });

  it("the normalizer leaves ports in Control (and any vocabulary section) where they are", () => {
    const t = dtp3();
    const ports = t.ports.map((p) => (p.signalType === "serial" || p.signalType === "contact-closure" ? { ...p, section: "Control" } : p));
    const { template, changes } = normalizeBlock({ ...t, ports });
    expect(changes.filter((c) => c.field.endsWith(".section"))).toEqual([]);
    const sections = (template as { ports: Port[] }).ports.filter((p) => p.signalType === "serial").map((p) => p.section);
    expect(sections).toEqual(["Control", "Control"]);
  });

  it("presentation is a warning: section outside the vocabulary, no section, caps, long label, header, rs422", () => {
    const t = dtp3();
    const [first, ...rest] = t.ports;
    const cases: [string, Record<string, unknown>][] = [
      ["section", { ...t, ports: [{ ...first, section: "Rear" }, ...rest] }],
      ["no section", { ...t, ports: [{ ...first, section: "" }, ...rest] }],
      ["caps", { ...t, ports: [{ ...first, label: "HDMI INPUT ONE" }, ...rest] }],
      ["long", { ...t, ports: [{ ...first, label: "HDMI In 1 with a very long description" }, ...rest] }],
      ["header", { ...t, auxiliaryData: [] }],
      ["color", { ...t, color: "#f00" }],
      ["shortName", { ...t, shortName: "" }],
      ["searchTerms", { ...t, searchTerms: [] }],
      ["schematic=false", { ...t, category: "Connectivity / Bulk Cables" }],
      ["no power port", { ...t, ports: t.ports.filter((p) => p.signalType !== "power") }],
      ["rs422", { ...t, ports: t.ports.map((p) => (p.label === "RS-232" ? { ...p, signalType: "rs422" } : p)) }],
      ["order", { ...t, ports: [...rest, first] }],
    ];
    for (const [name, block] of cases) {
      const l = lintBlock(block);
      expect(l.errors, name).toEqual([]);
      expect(l.level, name).toBe("B");
    }
  });

  it("errors: no ports, no connectorType, category, modelNumber, manufacturer, deviceType, power not an input", () => {
    const t = dtp3();
    const power = t.ports.find((p) => p.signalType === "power")!;
    const cases: [string, Record<string, unknown>, string][] = [
      ["no ports", { ...t, ports: [] }, "no ports"],
      ["connector", { ...t, ports: [{ ...t.ports[0], connectorType: "" }, ...t.ports.slice(1)] }, '"HDMI In 1": no connectorType'],
      ["no category", { ...t, category: "" }, "no category"],
      ["category", { ...t, category: "Video" }, 'category "Video" is not a leaf category of avail-taxonomy.json'],
      ["modelNumber", { ...t, modelNumber: "" }, "no modelNumber"],
      ["manufacturer", { ...t, manufacturer: "" }, "no manufacturer"],
      ["deviceType", { ...t, deviceType: "" }, "no deviceType"],
      ["power", { ...t, ports: t.ports.map((p) => (p === power ? { ...p, direction: "output" } : p)) }, `"${String(power.label)}": power is not an input`],
    ];
    for (const [name, block, error] of cases) {
      const l = lintBlock(block);
      expect(l.level, name).toBe("FIX");
      expect(l.errors, name).toContain(error);
    }
  });

  it("a chassis with slots only is not 'no ports'; a slot without a family is a warning", () => {
    const t = { ...dtp3(), ports: [] };
    expect(lintBlock({ ...t, slots: [{ id: "s1", label: "Slot 1", slotFamily: "extron-cubby-aap" }] }).errors).toEqual([]);
    expect(lintBlock({ ...t, slots: [{ id: "s1", label: "Slot 1" }] }).warnings).toContain('slot "Slot 1": no slotFamily');
  });
});
