/**
 * Standard v0.10 rules from the review queue: R1 (linter: a slots-only chassis without a power
 * input needs no power figures), R2 (voltage from the power input's notes), R3 (long port labels).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { applyCatalogRules, shortenLabel, voltageFromPowerNotes } from "../avail/catalogRules";
import { normalizeBlock } from "../avail/normalize";

const here = path.dirname(fileURLToPath(import.meta.url));
const dtp3 = () => JSON.parse(readFileSync(path.join(here, "../../library/avail/extron-dtp3-t-203.json"), "utf8")) as Record<string, unknown> & { ports: Record<string, unknown>[] };
const power = (notes: string, label = "Power") => ({ id: "p", label, signalType: "power", direction: "input", section: "Power", connectorType: "barrel", notes });

describe("R1: slots-only chassis", () => {
  it("no power figures needed when the block has slots and no ports", () => {
    const t = { ...dtp3(), ports: [], powerDrawW: undefined, voltage: undefined, slots: [{ id: "s1", label: "Slot 1", slotFamily: "extron-cubby-aap" }] };
    expect(lintBlock(t).warnings).not.toContain("no powerDrawW/voltage (or poeDrawW)");
    // A device with ports still needs them.
    expect(lintBlock({ ...dtp3(), powerDrawW: undefined }).warnings).toContain("no powerDrawW/voltage (or poeDrawW)");
  });
});

describe("R2: voltage from the power input's notes", () => {
  const block = (notes: string, over: Record<string, unknown> = {}) => ({ powerDrawW: 7, ports: [power(notes)], ...over });
  it("one stated voltage, the kind from the same note", () => {
    expect(voltageFromPowerNotes(block("External 12VDC Extron Everlast PSU brick"))).toBe("12V DC");
    expect(voltageFromPowerNotes(block("12 V 2 A DC, external adapter"))).toBe("12V DC");
    expect(voltageFromPowerNotes(block("100-240 V AC mains inlet"))).toBe("100-240V AC");
  });
  it("nothing when ambiguous, already set, no draw, or several inputs", () => {
    expect(voltageFromPowerNotes(block("External 12VDC PSU (100-240 VAC universal input)"))).toBeNull();
    expect(voltageFromPowerNotes(block("12 VDC", { voltage: "24V DC" }))).toBeNull();
    expect(voltageFromPowerNotes(block("12 VDC", { powerDrawW: undefined }))).toBeNull();
    expect(voltageFromPowerNotes({ powerDrawW: 7, ports: [power("12 VDC"), power("12 VDC", "Power 2")] })).toBeNull();
  });
});

describe("R3: port labels over 28 characters", () => {
  it("In / Out first, the trailing bracket to notes when still too long", () => {
    expect(shortenLabel("HDMI Output 1 (Buffered Mirror)")).toEqual({ label: "HDMI Out 1 (Buffered Mirror)" });
    expect(shortenLabel("DTP3/XTP/HDBT Scaled Output 2")).toEqual({ label: "DTP3/XTP/HDBT Scaled Out 2" });
    expect(shortenLabel("USB 3.0 (Rear, Communication)")).toEqual({ label: "USB 3.0", moved: "Rear, Communication" });
    expect(shortenLabel("HDMI In 1")).toBeNull();
    expect(shortenLabel("A very long label without brackets at all")).toBeNull();
  });

  it("applyCatalogRules: notes keep what they had after the moved qualifier; the input is not changed", () => {
    const t = { powerDrawW: 4, ports: [{ id: "u", label: "USB 3.0 (Rear, Communication)", notes: "900 mA" }, power("12 VDC")] };
    const { block, changes } = applyCatalogRules(t);
    expect(block.ports[0]).toMatchObject({ label: "USB 3.0", notes: "Rear, Communication; 900 mA" });
    expect((block as Record<string, unknown>).voltage).toBe("12V DC");
    expect(changes.map((c) => c.rule)).toEqual(["R2", "R3"]);
    expect(t.ports[0].label).toBe("USB 3.0 (Rear, Communication)");
    expect(applyCatalogRules(block).changes).toEqual([]);
  });

  it("the normalizer applies R2 and R3 and lists them", () => {
    const t = dtp3();
    t.ports[0] = { ...t.ports[0], label: "HDMI Output 1 (Buffered Mirror)", direction: "output", section: "Video Outputs" };
    const { template, changes } = normalizeBlock(t);
    expect((template as typeof t).ports.find((p) => String(p.label).startsWith("HDMI Out 1"))!.label).toBe("HDMI Out 1 (Buffered Mirror)");
    expect(changes.some((c) => /R3/.test(c.note))).toBe(true);
  });
});
