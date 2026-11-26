/**
 * Proposals as edits (src/avail/templatePatch.ts, step 2.9): the patch of an edit, three-way conflicts
 * with what changed since, applying with the chosen side, and what the patch touches.
 */
import { describe, expect, it } from "vitest";
import { applyPatchResolved, patchConflicts, patchFromEdit, patchIsEmpty, patchScope } from "../avail/templatePatch";

const base = () => ({
  label: "Audinate AVIO Analog Input",
  manufacturer: "Audinate",
  modelNumber: "ADP-DAI-AU-2X0",
  powerDrawW: 2,
  ports: [
    { id: "in1", label: "Analog In 1", signalType: "analog-audio" },
    { id: "net", label: "Dante", signalType: "dante", notes: "PoE" },
  ],
});

describe("patchFromEdit", () => {
  it("only what the edit changes: fields, port fields by id, added and removed ports", () => {
    const b = base();
    const a = { ...base(), powerDrawW: 3, ports: [{ ...b.ports[1], notes: "PoE, primary" }, { id: "gnd", label: "Ground Lift" }] };
    expect(patchFromEdit(b, a)).toEqual({
      powerDrawW: 3,
      ports: { update: [{ id: "net", notes: "PoE, primary" }], add: [{ id: "gnd", label: "Ground Lift" }], remove: ["in1"] },
    });
    expect(patchIsEmpty(patchFromEdit(b, { ...base(), id: "x", version: 9 }))).toBe(true);
  });
});

describe("two patches on one base", () => {
  const a = patchFromEdit(base(), { ...base(), modelNumber: "NEW" });
  const b = patchFromEdit(base(), { ...base(), powerDrawW: 3, ports: [base().ports[0], { ...base().ports[1], notes: "PoE, primary" }] });

  it("in either order: both changes, no conflicts", () => {
    const ab = applyPatchResolved(applyPatchResolved(base(), base(), a), base(), b);
    const ba = applyPatchResolved(applyPatchResolved(base(), base(), b), base(), a);
    expect(ab).toEqual(ba);
    expect(ab).toMatchObject({ modelNumber: "NEW", powerDrawW: 3 });
    expect(patchConflicts(base(), applyPatchResolved(base(), base(), a), b)).toEqual([]);
  });

  it("the same field changed since: a conflict with at creation / now / proposed; the chosen side wins", () => {
    const now = { ...base(), powerDrawW: 2.5 };
    const c = patchConflicts(base(), now, b);
    expect(c).toEqual([{ key: "field:powerDrawW", label: "powerDrawW", base: 2, current: 2.5, proposed: 3 }]);
    expect(applyPatchResolved(now, base(), b, { "field:powerDrawW": "current" })).toMatchObject({ powerDrawW: 2.5 });
    expect(applyPatchResolved(now, base(), b, { "field:powerDrawW": "proposed" })).toMatchObject({ powerDrawW: 3 });
    // Changed since to the same value: no conflict.
    expect(patchConflicts(base(), { ...base(), powerDrawW: 3 }, b)).toEqual([]);
  });

  it("port conflicts: a field changed since, a port removed since", () => {
    const changed = { ...base(), ports: [base().ports[0], { ...base().ports[1], notes: "PoE+" }] };
    expect(patchConflicts(base(), changed, b).map((x) => x.key)).toEqual(["port:net:notes"]);
    const gone = { ...base(), ports: [base().ports[0]] };
    expect(patchConflicts(base(), gone, b)).toEqual([expect.objectContaining({ key: "port:net", current: null })]);
    expect(applyPatchResolved(gone, base(), b, { "port:net": "current" }).ports).toEqual([base().ports[0]]);
    expect((applyPatchResolved(gone, base(), b, { "port:net": "proposed" }).ports as { id: string; notes?: string }[]).find((p) => p.id === "net")!.notes).toBe("PoE, primary");
  });

  it("scope: the fields and ports a patch touches", () => {
    const s = patchScope(b);
    expect([...s.fields]).toEqual(["powerDrawW"]);
    expect([...s.ports]).toEqual(["net"]);
  });
});

import { auditChanges } from "../avail/auditText";
describe("audit text", () => {
  it("a withdrawn proposal", () => {
    expect(auditChanges({ id: 1, at: "", actor: "e", actorId: null, entity: "template", entityId: "t", entityLabel: "T", action: "proposal", before: null, after: { decision: "withdrawn" } })).toEqual(["Withdrawn by the author"]);
  });
});
