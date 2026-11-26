/**
 * "Not duplicates" (step 2.4): decided pairs in src/avail/duplicates.ts (groups, findDuplicate),
 * the workspace's selection group and pair plan, the audit log text, and the 409 error with a link
 * to the existing template (src/avail/apiError.ts).
 */
import { describe, expect, it } from "vitest";
import { auditChanges, AUDIT_ACTION_LABELS, type AuditRecord } from "../avail/adminApi";
import { apiError, ApiError, errorParts } from "../avail/apiError";
import { allPairs, duplicateGroups, findDuplicate, pairKey, type DupCandidate } from "../avail/duplicates";
import { buildRows, notDuplicatePairs, notDuplicatesGroup, groupMembers, type WsInfo, type WsTemplate } from "../avail/workspaceModel";

const c = (id: string, label: string, modelNumber: string, over: Partial<DupCandidate> = {}): DupCandidate => ({
  id, label, manufacturer: "Extron", modelNumber, status: "raw", source: "easyschematic.live", portsOrigin: "community", level: "A", ports: 3, ...over,
});

describe("decided pairs in the duplicate check", () => {
  it("pairKey is unordered; allPairs lists each pair once", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
    expect(allPairs(["c", "a", "b", "a"])).toEqual([["a", "b"], ["a", "c"], ["b", "c"]]);
  });

  it("a decided pair is not joined; a third template still joins both", () => {
    const two = [c("a", "Extron A", "60-1"), c("b", "Extron B", "60-1")];
    expect(duplicateGroups(two)).toHaveLength(1);
    expect(duplicateGroups(two, new Set([pairKey("b", "a")]))).toEqual([]);
    const three = [...two, c("c", "Extron C", "60-1")];
    expect(duplicateGroups(three, new Set([pairKey("a", "b")])).map((g) => g.members.map((m) => m.id).sort())).toEqual([["a", "b", "c"]]);
    const all = new Set(allPairs(["a", "b", "c"]).map(([x, y]) => pairKey(x, y)));
    expect(duplicateGroups(three, all)).toEqual([]);
    // a–b and a–c decided: b and c are still duplicates of each other.
    expect(duplicateGroups(three, new Set([pairKey("a", "b"), pairKey("a", "c")])).map((g) => g.members.map((m) => m.id).sort())).toEqual([["b", "c"]]);
  });

  it("findDuplicate skips a decided pair (an update only: a new template has no pairs)", () => {
    const existing = [c("a", "Extron A", "60-1", { status: "draft" })];
    const decided = new Set([pairKey("a", "b")]);
    expect(findDuplicate({ id: "b", label: "Extron B", manufacturer: "Extron", modelNumber: "60 1" }, existing, decided)).toBeNull();
    expect(findDuplicate({ id: "x", label: "Extron X", manufacturer: "Extron", modelNumber: "60 1" }, existing, decided)).toEqual({ id: "a", label: "Extron A" });
    expect(findDuplicate({ label: "Extron New", manufacturer: "Extron", modelNumber: "60-1" }, existing, decided)?.id).toBe("a");
  });
});

const INFO: WsInfo = {
  status: "draft", level: "A", statusReason: null, statusChangedAt: null, updatedAt: null, approvedBy: null, approvedVia: null, approvedAt: null,
  portsOrigin: "community", portsSource: "db", portsFrom: null, datasheetUrl: null, source: null, editors: [], lastActor: null, lastAt: null,
};
const t = (id: string, info: Partial<WsInfo> = {}): WsTemplate =>
  ({ id, label: `Extron ${id.toUpperCase()}`, manufacturer: "Extron", modelNumber: "60-1", deviceType: "switcher", category: "AV distribution / Switchers", ports: [], avail: { ...INFO, ...info } }) as unknown as WsTemplate;

describe("workspace: Not duplicates on a selection", () => {
  const g = { primary: "a", size: 3 };
  const rows = buildRows([
    t("b", { duplicate: g }),
    t("a", { duplicate: g, notDuplicates: [{ id: "c", label: "Extron C", comment: "x", by: "lib@avail.test", at: "2026-11-26 10:00:00" }] }),
    t("c", { duplicate: g, notDuplicates: [{ id: "a", label: "Extron A", comment: "x", by: "lib@avail.test", at: "2026-11-26 10:00:00" }] }),
    t("x", { duplicate: { primary: "x", size: 2 } }),
    t("y", { duplicate: { primary: "x", size: 2 } }),
    t("solo"),
  ]);
  const pick = (...ids: string[]) => rows.filter((r) => ids.includes(r.id));

  it("two or more templates of one group; the group's rows, primary first", () => {
    expect(notDuplicatesGroup(pick("a"), rows)).toEqual({ error: "Select two or more templates of one duplicate group" });
    expect(notDuplicatesGroup(pick("a", "x"), rows)).toEqual({ error: "The selected templates are not in one duplicate group" });
    expect(notDuplicatesGroup(pick("a", "solo"), rows)).toEqual({ error: "The selected templates are not in one duplicate group" });
    const ok = notDuplicatesGroup(pick("b", "c"), rows);
    expect("members" in ok && ok.members.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(groupMembers(rows, "x").map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("the pairs to add and those decided already", () => {
    expect(notDuplicatePairs(["a", "b", "c"], rows)).toEqual({ add: [["a", "b"], ["b", "c"]], already: 1 });
    expect(notDuplicatePairs(["a", "c"], rows)).toEqual({ add: [], already: 1 });
  });
});

describe("audit log text", () => {
  const rec = (before: unknown, after: unknown): AuditRecord =>
    ({ id: 1, at: "2026-11-26", actor: "lib@avail.test", entity: "template", entityId: "a", action: "not-duplicate", before, after }) as AuditRecord;
  it("marked, undone, removed automatically", () => {
    expect(AUDIT_ACTION_LABELS["not-duplicate"]).toBe("Not a duplicate");
    expect(auditChanges(rec(null, { notDuplicateOf: "b", notDuplicateOfLabel: "Extron B", comment: "PoE and non-PoE" }))).toEqual([
      "Marked as not a duplicate of Extron B: PoE and non-PoE",
    ]);
    expect(auditChanges(rec({ notDuplicateOf: "b", notDuplicateOfLabel: "Extron B" }, { removed: "undone" }))).toEqual(["Undone: not a duplicate of Extron B"]);
    expect(auditChanges(rec({ notDuplicateOf: "b", notDuplicateOfLabel: "Extron B" }, { removed: "b changed its manufacturer or model number" }))).toEqual([
      "Decision on Extron B removed: b changed its manufacturer or model number",
    ]);
  });
});

describe("409 duplicate: the existing template's name links to its card", () => {
  const body = {
    error: "A template for Extron 60-1 already exists: Extron DTP3 T 203. Edit that one, or mark this one as a variant.",
    duplicateOf: { id: "x 1", label: "Extron DTP3 T 203" },
    link: "/library?template=x%201",
  };
  it("parts: text, link, text", () => {
    const e = apiError(409, body);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(errorParts(e)).toEqual([
      { text: "A template for Extron 60-1 already exists: " },
      { text: "Extron DTP3 T 203", href: "/library?template=x%201", templateId: "x 1" },
      { text: ". Edit that one, or mark this one as a variant." },
    ]);
  });
  it("no name in the message: an Open link after it; a foreign link is replaced; other errors stay plain", () => {
    expect(errorParts(apiError(409, { ...body, error: "Conflict." }))).toEqual([
      { text: "Conflict. Open " },
      { text: "Extron DTP3 T 203", href: "/library?template=x%201", templateId: "x 1" },
      { text: "." },
    ]);
    expect(apiError(409, { ...body, link: "https://evil.example/x" }).link).toBe("/library?template=x%201");
    expect(errorParts(apiError(400, { error: "Bad" }))).toEqual([{ text: "Bad" }]);
    expect(errorParts(apiError(502, null))).toEqual([{ text: "HTTP 502" }]);
    expect(errorParts(new Error("boom"))).toEqual([{ text: "boom" }]);
  });
});
