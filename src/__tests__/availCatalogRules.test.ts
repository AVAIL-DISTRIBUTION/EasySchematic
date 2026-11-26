/**
 * Standard v0.10 rules from the review queue: R1 (linter: a slots-only chassis without a power
 * input needs no power figures), R2 (voltage from the power input's notes), R3 (long port labels);
 * v0.11: R4 (signal type from the label), R5 (power notes by group), Cable Cubby F55 slots.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import {
  applyCatalogRules,
  applySignalRule,
  EBUS_NOTE,
  HOST_NOTE,
  PASSIVE_NOTE,
  powerNote,
  shortenLabel,
  signalFromLabel,
  voltageFromPowerNotes,
} from "../avail/catalogRules";
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

// ---------------------------------------------------------------------------- v0.11 (Extron level B)

const extron = (ports: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  ...dtp3(),
  label: "Extron IPCP Pro 550 xi",
  modelNumber: "60-1913-01A",
  deviceType: "control-processor",
  ports,
  ...over,
});
const port = (id: string, label: string, signalType: string, direction: string, section: string, extra: Record<string, unknown> = {}) => ({
  id, label, signalType, direction, section, connectorType: "phoenix", ...extra,
});

describe("R4: signal type from the label", () => {
  it("Relay N → contact-closure output in Relays; IPCP Relay N too; an input stays an input", () => {
    expect(signalFromLabel(port("1", "Relay 1", "gpio", "bidirectional", "Digital I/O"))).toEqual({ signalType: "contact-closure", direction: "output", section: "Relays" });
    expect(signalFromLabel(port("2", "IPCP Relay 4", "gpio", "bidirectional", "Relays"))).toEqual({ signalType: "contact-closure", direction: "output" });
    expect(signalFromLabel(port("3", "RELAY 2", "gpio", "input", "Control"))).toEqual({ signalType: "contact-closure" });
  });

  it("eBUS → ebus, bidirectional, Expansion", () => {
    expect(signalFromLabel(port("1", "eBUS", "serial", "bidirectional", "Serial"))).toEqual({ signalType: "ebus", section: "Expansion" });
    expect(signalFromLabel(port("2", "Sensor Out (eBUS)", "serial", "output", "Control"))).toEqual({ signalType: "ebus", direction: "bidirectional", section: "Expansion" });
  });

  it("leaves right types, other relay wording, power, slot ports and look-alike words alone", () => {
    expect(signalFromLabel(port("1", "Relay 1", "contact-closure", "output", "Relays"))).toBeNull();
    expect(signalFromLabel(port("2", "Relay (Screen Up) 1", "gpio", "bidirectional", "Digital I/O"))).toBeNull();
    expect(signalFromLabel(port("3", "Relay 1", "gpio", "bidirectional", "Slot 1"))).toBeNull();
    expect(signalFromLabel(port("4", "eBUS Power", "power", "output", "Power"))).toBeNull();
    expect(signalFromLabel(port("5", "Webus 1", "serial", "bidirectional", "Serial"))).toBeNull();
  });

  it("applyCatalogRules: the relay/eBUS warnings go, the moved eBUS port keeps the section order", () => {
    const b = extron([
      port("s", "COM 1", "serial", "bidirectional", "Serial"),
      port("e", "eBUS", "serial", "bidirectional", "Serial"),
      port("r", "Relay 1", "gpio", "bidirectional", "Relays"),
      port("p", "Power", "power", "input", "Power", { connectorType: "iec" }),
    ]);
    const before = lintBlock(b).warnings;
    expect(before).toEqual(expect.arrayContaining(['"eBUS": eBUS must be ebus', '"Relay 1": a relay must be contact-closure']));
    const { block, changes } = applyCatalogRules(b);
    expect(changes.filter((c) => c.rule === "R4").map((c) => c.field)).toEqual([
      "ports[e].signalType", "ports[e].section", "ports[r].signalType", "ports[r].direction",
    ]);
    const after = lintBlock(block).warnings;
    expect(after.filter((w) => /relay|eBUS|order/.test(w))).toEqual([]);
    // Standard order: Serial, Relays, Expansion, Power — the eBUS port moves after the relays.
    expect(block.ports.map((p) => p.id)).toEqual(["s", "r", "e", "p"]);
    expect(applyCatalogRules(block).changes).toEqual([]);
  });

  it("applySignalRule changes the ports only", () => {
    const b = extron([port("r", "Relay 1", "gpio", "bidirectional", "Relays")], { voltage: undefined, powerDrawW: 10 });
    const { block, changes } = applySignalRule(b);
    expect(changes.every((c) => c.rule === "R4")).toBe(true);
    expect({ ...block, ports: b.ports }).toEqual(b);
  });
});

describe("R5: power notes by group", () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    ...dtp3(),
    label: "Extron SF 10C SUB",
    modelNumber: "60-1610-01",
    deviceType: "subwoofer",
    category: "Audio Products / Speakers",
    powerDrawW: undefined,
    voltage: undefined,
    ports: [port("0", "Speaker In", "speaker-level", "input", "Audio Inputs")],
    ...over,
  });

  it("passive Extron subwoofers: 'passive' on the first input; the power warnings go", () => {
    expect(lintBlock(sub()).warnings).toEqual(expect.arrayContaining(["no power port", "no powerDrawW/voltage (or poeDrawW)"]));
    const { block, changes } = applyCatalogRules(sub());
    expect(changes).toEqual([{ rule: "R5", field: "ports[0].notes", from: null, to: PASSIVE_NOTE }]);
    expect(lintBlock(block).warnings.filter((w) => /power/.test(w))).toEqual([]);
    expect(applyCatalogRules(block).changes).toEqual([]);
  });

  it("not for other vendors, powered subwoofers or ports other than speaker-level inputs", () => {
    expect(powerNote(sub({ manufacturer: "Biamp" }))).toBeNull();
    expect(powerNote(sub({ ports: [port("0", "Speaker In", "speaker-level", "input", "Audio Inputs"), port("1", "Power", "power", "input", "Power")] }))).toBeNull();
    expect(powerNote(sub({ ports: [port("0", "Line In", "analog-audio", "input", "Audio Inputs")] }))).toBeNull();
    expect(powerNote(sub({ deviceType: "amplifier" }))).toBeNull();
    // A speaker is passive to the linter already: its card is not changed.
    expect(powerNote(sub({ deviceType: "speaker" }))).toBeNull();
  });

  it("host power: IPA T RLY4 on its control / power port, OCS 100C on its eBUS port", () => {
    const rly = sub({
      label: "Extron IPA T RLY4", modelNumber: "60-545-03", deviceType: "control-expansion",
      ports: [port("r", "Relay 1", "contact-closure", "output", "Relays"), port("c", "Control / Power In", "serial", "bidirectional", "Control", { notes: "DC power from a host (12VDC)" })],
    });
    expect(powerNote(rly)).toEqual({ index: 1, note: HOST_NOTE });
    expect(lintBlock(applyCatalogRules(rly).block).level).toBe("A");
    const ocs = sub({
      label: "Extron OCS 100C", modelNumber: "60-1664-01", deviceType: "control-expansion", powerDrawW: 0.8,
      ports: [port("0", "Sensor Out (eBUS)", "ebus", "bidirectional", "Expansion")],
    });
    expect(powerNote(ocs)).toEqual({ index: 0, note: EBUS_NOTE });
    const done = applyCatalogRules(ocs).block;
    expect(lintBlock(done).level).toBe("A");
    expect(powerNote(done)).toBeNull();
  });
});

describe("catalog: Cable Cubby F55 (70-1295-02/-03)", () => {
  it("four Flex55 slots from Extron's page; F55 Edge / UT unchanged without a document", () => {
    const read = (f: string) => JSON.parse(readFileSync(path.join(here, "../../library/catalog/extron", f), "utf8"));
    for (const f of ["extron-cable-cubby-f55-no-ac-black.json", "extron-cable-cubby-f55-aluminum-no-ac.json"]) {
      const t = read(f);
      expect(t.slots.map((s: { slotFamily: string }) => s.slotFamily)).toEqual(Array(4).fill("extron-cubby-flex55"));
      expect(t._avail.slotsSource).toBe("document: https://www.extron.com/Power-Modules/prodsubtype-587");
      expect(t._avail.portsMissing).toBeUndefined();
      expect(lintBlock(t).level).toBe("A");
    }
    for (const f of ["extron-cable-cubby-f55-edge-no-ac-black.json", "extron-cable-cubby-f55-ut-no-ac-black.json"]) {
      expect(read(f).slots).toBeUndefined();
    }
  });
});

describe("linter v0.11: HDBaseT/DTP/XTP must be hdbaset", () => {
  const warns = (p: Record<string, unknown>) =>
    lintBlock(extron([p, port("pw", "Power", "power", "input", "Power", { connectorType: "iec" })])).warnings.filter((w) => w.includes("must be hdbaset"));

  it("not for ports that ride on the link or carry IR / serial", () => {
    expect(warns(port("1", "IR Pass-Through (DTP2 Out)", "ir", "output", "IR"))).toEqual([]);
    expect(warns(port("2", "RS-232 over XTP", "serial", "bidirectional", "Serial"))).toEqual([]);
    expect(warns(port("3", "Audio Pass-thru (DTP In)", "analog-audio", "output", "Audio Outputs"))).toEqual([]);
    expect(warns(port("4", "DTP Serial", "serial", "bidirectional", "Serial"))).toEqual([]);
  });

  it("still for the link port itself", () => {
    expect(warns(port("1", "DTP Out", "ethernet", "bidirectional", "Network", { connectorType: "rj45" }))).toEqual(['"DTP Out": HDBaseT/DTP/XTP must be hdbaset']);
    expect(warns(port("2", "XTP In", "analog-audio", "input", "Audio Inputs"))).toEqual(['"XTP In": HDBaseT/DTP/XTP must be hdbaset']);
  });
});
