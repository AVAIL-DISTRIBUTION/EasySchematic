/**
 * Partial edits (src/avail/templatePatch.ts) and the Proposals diff (diffTemplates): only what really
 * changes counts; a patch keeps everything it does not name (regression: thermalBtuh lost on OCS 100C).
 */
import { describe, expect, it } from "vitest";
import { applyTemplatePatch, describeEditChanges, editChanges, noChanges, storedForm } from "../avail/templatePatch";
import { diffIsEmpty, diffTemplates } from "../avail/workspaceModel";

const ocs = () => ({
  id: "ocs",
  version: 9,
  label: "Extron OCS 100C",
  manufacturer: "Extron",
  modelNumber: "60-1664-01",
  deviceType: "control-expansion",
  category: "Control Systems / IP Link Control Proc",
  powerDrawW: 0.8,
  voltage: "24V DC",
  thermalBtuh: 2.6,
  ports: [
    { id: "relay", label: "Relay (SPDT)", signalType: "contact-closure", direction: "output", section: "Relays" },
    { id: "occ", label: "Occupancy Out", signalType: "sensor", direction: "output", section: "Control" },
    { id: "pwr", label: "24V DC In", signalType: "power", direction: "input", section: "Power" },
  ],
});

describe("storedForm", () => {
  it("drops id, version, workspace and API extras, empty values; ports likewise", () => {
    const s = storedForm({ ...ocs(), avail: { status: "draft" }, lastEditedBy: { name: "x" }, hostname: "", searchTerms: [], color: null, isVenueProvided: false, ports: [{ id: "a", label: "A", notes: "" }] });
    expect(Object.keys(s)).toEqual(["label", "manufacturer", "modelNumber", "deviceType", "category", "powerDrawW", "voltage", "thermalBtuh", "ports"]);
    expect(s.ports).toEqual([{ id: "a", label: "A" }]);
  });
});

describe("applyTemplatePatch", () => {
  it("one field: everything else stays", () => {
    const r = applyTemplatePatch(ocs(), { voltage: "24 VDC" });
    if ("error" in r) throw new Error(r.error);
    const { id: _i, version: _v, ...rest } = ocs();
    expect(r.template).toEqual({ ...rest, voltage: "24 VDC" });
    expect(describeEditChanges(editChanges(ocs(), r.template))).toEqual(["voltage"]);
  });

  it("null removes a field; ports by id: update (null removes a port field), add, remove", () => {
    const r = applyTemplatePatch(ocs(), {
      thermalBtuh: null,
      ports: { update: [{ id: "occ", notes: "Blue wire", section: null }], add: [{ id: "usb", label: "USB-C Config", signalType: "usb" }], remove: ["relay"] },
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.template).not.toHaveProperty("thermalBtuh");
    expect(r.template.ports).toEqual([
      { id: "occ", label: "Occupancy Out", signalType: "sensor", direction: "output", notes: "Blue wire" },
      { id: "pwr", label: "24V DC In", signalType: "power", direction: "input", section: "Power" },
      { id: "usb", label: "USB-C Config", signalType: "usb" },
    ]);
    expect(describeEditChanges(editChanges(ocs(), r.template))).toEqual([
      "thermalBtuh",
      'port "Occupancy Out": notes, section',
      'port "USB-C Config" added',
      'port "Relay (SPDT)" removed',
    ]);
  });

  it("refuses what does not fit: id / version, unknown port ids, a new port without id or with a taken one, other keys", () => {
    expect(applyTemplatePatch(ocs(), { id: "x" })).toEqual({ error: "patch cannot change id" });
    expect(applyTemplatePatch(ocs(), { ports: { update: [{ id: "nope" }] } })).toMatchObject({ error: expect.stringContaining('no port with id "nope"') });
    expect(applyTemplatePatch(ocs(), { ports: { remove: ["nope"] } })).toMatchObject({ error: expect.stringContaining('no port with id "nope"') });
    expect(applyTemplatePatch(ocs(), { ports: { add: [{ label: "X" }] } })).toEqual({ error: "patch.ports.add: every new port needs an id" });
    expect(applyTemplatePatch(ocs(), { ports: { add: [{ id: "occ", label: "X" }] } })).toMatchObject({ error: expect.stringContaining("use update") });
    expect(applyTemplatePatch(ocs(), { ports: [] })).toMatchObject({ error: expect.stringContaining("{ update, add, remove }") });
    expect(applyTemplatePatch(ocs(), { ports: { replace: [] } })).toMatchObject({ error: expect.stringContaining("use update, add or remove") });
  });

  it("an empty patch or the same values change nothing", () => {
    for (const p of [{}, { voltage: "24V DC" }, { ports: { update: [{ id: "occ", label: "Occupancy Out" }] } }]) {
      const r = applyTemplatePatch(ocs(), p);
      if ("error" in r) throw new Error(r.error);
      expect(noChanges(editChanges(ocs(), r.template))).toBe(true);
    }
  });
});

describe("Proposals diff (diffTemplates): only real changes", () => {
  it("workspace data, version, empty values and key order do not count", () => {
    const before = { ...ocs(), avail: { status: "draft" } };
    const after = { ...ocs(), version: 10, hostname: "", searchTerms: [], ports: ocs().ports.map((p) => ({ ...Object.fromEntries(Object.entries(p).reverse()), notes: "" })) };
    expect(diffIsEmpty(diffTemplates(before, after))).toBe(true);
  });

  it("a field left out is shown as removed, any field (not only the card's); port fields beyond the usual ones too", () => {
    const { thermalBtuh: _t, ...without } = ocs();
    const d = diffTemplates(ocs(), { ...without, hostname: "ocs-1", ports: [{ ...ocs().ports[0], poe: "PoE+" }, ...ocs().ports.slice(1)] });
    expect(d.fields).toEqual([
      { field: "thermalBtuh", before: "2.6", after: "—" },
      { field: "hostname", before: "—", after: "ocs-1" },
    ]);
    expect(d.ports).toEqual([{ kind: "changed", label: "Relay (SPDT)", changes: [{ field: "poe", before: "—", after: "PoE+" }] }]);
  });
});
