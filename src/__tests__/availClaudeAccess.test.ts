/**
 * Claude connections (OAuth, step 2.8) in the editor's texts, and the linter previews with the
 * template's lifecycle: the Normalize preview and proposals lint as saving does.
 */
import { describe, expect, it } from "vitest";
import { auditActor, auditChanges, type AuditRecord } from "../avail/auditText";
import { lintBlock } from "../avail/blockLint";
import { carriedLifecycle, withLifecycle } from "../avail/lifecycle";
import { lintAsStored, workspaceLintContext } from "../avail/workspaceModel";

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  id: 1, at: "2026-11-26 10:00:00", actor: "eng@avail-int.com", actorId: "u1", entity: "user", entityId: "u1", entityLabel: "eng@avail-int.com",
  action: "token", before: null, after: null, ...over,
});

describe("audit log texts", () => {
  it("what was done through Claude: the user, via Claude; a static token keeps its name", () => {
    expect(auditActor(rec({ token: "via Claude" }))).toBe("eng@avail-int.com via Claude");
    expect(auditActor(rec({ token: "automation" }))).toBe("eng@avail-int.com (token “automation”)");
    expect(auditActor(rec({}))).toBe("eng@avail-int.com");
  });

  it("connected and revoked", () => {
    expect(auditChanges(rec({ after: { oauthGranted: "Claude" } }))).toEqual(["Claude connected (Claude)"]);
    expect(auditChanges(rec({ after: { oauthRevoked: "Claude", reason: "user disabled" } }))).toEqual(["Claude access revoked (Claude): user disabled"]);
  });
});

describe("linter previews with the lifecycle", () => {
  const block = {
    label: "Extron DTP4 T 203", shortName: "DTP4 T 203", manufacturer: "Extron", modelNumber: "60-9", deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders", auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3, powerDrawW: 6, voltage: "12V DC",
    referenceUrl: "https://www.extron.com/product/x", searchTerms: ["60-9"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel", notes: "estimated from DTP3 T 202" },
    ],
  };

  it("an upcoming product's estimates do not lower the level; active ones do", () => {
    expect(lintBlock(block).level).toBe("B");
    const upcoming = { lifecycle: "upcoming" as const, availableFrom: "2027-Q3" };
    expect(lintAsStored(block, upcoming, workspaceLintContext([])).level).toBe("A");
    expect(lintAsStored(block, { lifecycle: "active" }).level).toBe("B");
    expect(withLifecycle(block, { lifecycle: "active" })).toBe(block);
  });

  it("the lifecycle a block carries: _avail, availLifecycle (raw), avail (workspace)", () => {
    expect(carriedLifecycle({ _avail: { lifecycle: "eol", eolDate: "2026" } })).toEqual({ lifecycle: "eol", eolDate: "2026" });
    expect(carriedLifecycle({ availLifecycle: { lifecycle: "upcoming", availableFrom: "2027" } })).toEqual({ lifecycle: "upcoming", availableFrom: "2027" });
    expect(carriedLifecycle({ avail: { lifecycle: "upcoming" } })).toEqual({ lifecycle: "upcoming" });
    expect(carriedLifecycle({ label: "x" })).toBeNull();
  });
});
