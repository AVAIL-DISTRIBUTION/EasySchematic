/**
 * Overrides (src/avail/overrides.ts, step 2.7): what an accepted proposal changed, applied over
 * incoming data; conflicts where the incoming data changed an overridden value; the audit text.
 */
import { describe, expect, it } from "vitest";
import { auditChanges, type AuditRecord } from "../avail/auditText";
import {
  applyOverrides,
  combineOverrides,
  describeConflict,
  describeOverride,
  mergeOverrides,
  overrideConflicts,
  overridesFor,
  overridesFromChange,
  type Override,
} from "../avail/overrides";

const port = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi", ...extra });
const base = () => ({
  id: "t1",
  label: "Extron DTP3 T 203",
  manufacturer: "Extron",
  modelNumber: "60-1885-52",
  powerDrawW: 6,
  ports: [port("1", "HDMI In"), port("2", "Power", { signalType: "power", section: "Power", connectorType: "phoenix" })],
});
const meta = { source: "proposal s1 by eng@avail.test", comment: "Data sheet p. 3", acceptedBy: "lib@avail.test" };

describe("overridesFromChange", () => {
  it("one override per changed field and port; ports pair by id, else label; added and removed ports", () => {
    const before = base();
    const after = {
      ...base(),
      powerDrawW: 7,
      voltage: "12V DC",
      ports: [port("1", "HDMI Input", { notes: "HDCP 2.3" }), port("3", "USB-C In", { signalType: "usb", connectorType: "usb-c" })],
    };
    const list = overridesFromChange(before, after, meta);
    expect(list.map(describeOverride)).toEqual([
      "powerDrawW = 7",
      'voltage = "12V DC"',
      'port "HDMI In": label = "HDMI Input", notes = "HDCP 2.3"',
      'port "USB-C In": added',
      'port "Power": removed',
    ]);
    expect(list[0]).toMatchObject({ templateId: "t1", manufacturer: "Extron", modelNumber: "60-1885-52", kind: "field", field: "powerDrawW", value: 7, base: 6, ...meta });
    expect(list[1].base).toBeNull();
    expect(list[2]).toMatchObject({ kind: "port", port: "HDMI In", portId: "1", op: "set", base: { label: "HDMI In", notes: null } });
    expect(overridesFromChange(before, base(), meta)).toEqual([]);
  });
});

describe("applyOverrides", () => {
  const list = overridesFromChange(
    base(),
    { ...base(), powerDrawW: 7, ports: [port("1", "HDMI Input", { notes: "HDCP 2.3" }), port("3", "USB-C In", { signalType: "usb", section: "Video Inputs" })] },
    meta,
  );

  it("over a copy from another source (new id, same manufacturer + part number): fields, port fields, added and removed ports", () => {
    const incoming = { ...base(), id: "avail-extron-60-1885-52", powerDrawW: 8 };
    const r = applyOverrides(incoming, list);
    expect(r.block).toMatchObject({ powerDrawW: 7 });
    expect(r.block.ports.map((p) => p.label)).toEqual(["HDMI Input", "USB-C In"]);
    expect((r.block.ports[0] as Record<string, unknown>).notes).toBe("HDCP 2.3");
    expect(r.missed).toEqual([]);
    expect(incoming.powerDrawW).toBe(8); // the input is not changed
    expect(applyOverrides(r.block, list).changes).toEqual([]); // idempotent: the port matches by its new label too
  });

  it("only the template's own; a field set to null is removed; a port the template lacks is missed", () => {
    expect(applyOverrides({ ...base(), id: "x", modelNumber: "60-9", label: "Extron Other" }, list).changes).toEqual([]);
    const drop: Override = { templateId: "t1", kind: "field", field: "powerDrawW", value: null, ...meta };
    expect(applyOverrides(base(), [drop]).block).not.toHaveProperty("powerDrawW");
    const lost: Override = { templateId: "t1", kind: "port", port: "Audio Out", op: "set", value: { notes: "x" }, ...meta };
    expect(applyOverrides(base(), [lost]).missed).toEqual([lost]);
    expect(overridesFor({ manufacturer: "Biamp", modelNumber: "60-1885-52", label: "Extron DTP3 T 203" }, [{ ...drop, templateId: null, manufacturer: "Extron", modelNumber: "60-1885-52" }])).toEqual([]);
  });
});

describe("overrideConflicts", () => {
  const list = overridesFromChange(base(), { ...base(), powerDrawW: 7, ports: [port("1", "HDMI In", { notes: "HDCP 2.3" }), base().ports[1]] }, meta);

  it("the catalog changed an overridden value: neither the value before nor the override", () => {
    const changed = { ...base(), powerDrawW: 8, ports: [port("1", "HDMI In", { notes: "HDCP 1.4" }), base().ports[1]] };
    const c = overrideConflicts(changed, list);
    expect(c.map(describeConflict)).toEqual([
      "catalog changed a field overridden by proposal s1 by eng@avail.test: powerDrawW — catalog 8, kept 7",
      'catalog changed a field overridden by proposal s1 by eng@avail.test: ports["HDMI In"].notes — catalog "HDCP 1.4", kept "HDCP 2.3"',
    ]);
  });

  it("the value from before the decision, or the decided value: no conflict", () => {
    expect(overrideConflicts(base(), list)).toEqual([]);
    expect(overrideConflicts(applyOverrides(base(), list).block, list)).toEqual([]);
  });

  it("without a base (port decisions) any other value is a conflict", () => {
    const decision: Override = { manufacturer: "Extron", modelNumber: "60-1885-52", kind: "port", port: "HDMI In", op: "set", value: { notes: "decided" }, source: "port decision", comment: "", acceptedBy: "AVAIL engineers" };
    expect(overrideConflicts(base(), [decision]).map((c) => c.field)).toEqual(['ports["HDMI In"].notes']);
  });
});

describe("merging and combining", () => {
  const fileEntry: Override = { manufacturer: "Extron", modelNumber: "60-1885-52", label: "Extron DTP3 T 203", kind: "field", field: "powerDrawW", value: 7, source: "proposal s1 by eng@avail.test", comment: "", acceptedBy: "lib" };

  it("the database's rows win over the file's same entries; removed rows keep a file entry out", () => {
    const db = { ...fileEntry, id: 1, templateId: "t1" };
    expect(mergeOverrides([db], [fileEntry])).toEqual([db]);
    expect(mergeOverrides([{ ...db, removed: true }], [fileEntry])).toEqual([]);
    expect(mergeOverrides([], [fileEntry])).toEqual([fileEntry]);
  });

  it("a newer port set merges into the older one; the older base stays", () => {
    const older: Override = { templateId: "t1", kind: "port", port: "HDMI In", op: "set", value: { notes: "a" }, base: { notes: null }, ...meta };
    const newer: Override = { ...older, value: { notes: "b", connectorType: "hdmi-a" }, base: { notes: "a", connectorType: "hdmi" }, source: "proposal s2" };
    expect(combineOverrides(older, newer)).toMatchObject({ value: { notes: "b", connectorType: "hdmi-a" }, base: { notes: null, connectorType: "hdmi" }, source: "proposal s2" });
  });
});

describe("audit text", () => {
  const rec = (before: Record<string, unknown> | null, after: Record<string, unknown> | null): AuditRecord => ({
    id: 1, at: "2026-11-26 10:00:00", actor: "lib@avail.test", actorId: null, entity: "template", entityId: "t1", entityLabel: "X", action: "override", before, after,
  });
  it("added and removed overrides", () => {
    expect(auditChanges(rec(null, { added: ["powerDrawW = 7"], source: "proposal s1" }))).toEqual(["Overrides from proposal s1:", "  powerDrawW = 7"]);
    expect(auditChanges(rec({ override: "powerDrawW = 7", source: "proposal s1" }, { removed: true }))).toEqual(["Override removed (proposal s1): powerDrawW = 7"]);
  });
});
