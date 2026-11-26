/**
 * Duplicate control (step 2.4): src/avail/duplicates.ts and the workspace's filter, column,
 * Merge into… plan and the selection after a bulk action.
 */
import { describe, expect, it } from "vitest";
import { duplicateGroups, findDuplicate, normalizedModel, variantOf, type DupCandidate } from "../avail/duplicates";
import { duplicateRows, formatDuplicates } from "../avail/duplicatesReport";
import { selectionAfter } from "../avail/workspaceBulk";
import { buildRows, EMPTY_FILTER, builtInFilters, filterRows, planMerge, sortRows, suggestedPrimary, type WsInfo, type WsTemplate } from "../avail/workspaceModel";

const c = (id: string, label: string, over: Partial<DupCandidate> = {}): DupCandidate => ({
  id, label, manufacturer: label.split(" ")[0], modelNumber: "", status: "raw", source: "easyschematic.live", portsOrigin: "community", level: "A", ports: 3, ...over,
});

describe("normalized model and variant", () => {
  it("no manufacturer (aliases, abbreviations), punctuation, case or variant words", () => {
    expect(normalizedModel("Extron DTP3 T 203 (Black)", "Extron")).toBe("dtp3 t 203");
    expect(normalizedModel("A&H dLive S7000", "Allen & Heath")).toBe("dlive s7000");
    expect(normalizedModel("Allen & Heath dLive S7000", "Allen & Heath")).toBe("dlive s7000");
    expect(normalizedModel("Biamp Systems TesiraFORTÉ X 400", "Biamp")).toBe("tesiraforte x 400");
    expect(normalizedModel("Extron FOX3 SR 201 MM (Lossless)", "Extron")).toBe("fox3 sr 201 lossless");
    expect(normalizedModel("Extron DTP3 CrossPoint 622 IPCP A (LinkLicense)", "Extron")).toBe("dtp3 crosspoint 622 ipcp a");
    expect(normalizedModel("Allen & Heath SQ7+", "Allen & Heath")).toBe("sq7+");
  });
  it("the variant: the catalog field and the label's variant words", () => {
    expect(variantOf({ label: "Extron FOX3 SR 201 MM (Lossless)", manufacturer: "Extron", variant: "Lossless" })).toBe("lossless mm");
    expect(variantOf({ label: "Biamp Desono C-IC6 White", manufacturer: "Biamp" })).toBe("white");
    expect(variantOf({ label: "Extron DTP3 T 203", manufacturer: "Extron" })).toBe("");
  });
});

describe("duplicate groups", () => {
  it("same part number or same model with the same variant; variants and hidden are not duplicates", () => {
    const g = duplicateGroups([
      c("a1", "Allen & Heath SQ7+", { manufacturer: "Allen & Heath", modelNumber: "SQ-7" }),
      c("a2", "Allen & Heath SQ-7", { manufacturer: "Allen & Heath", modelNumber: "sq 7" }),
      c("d1", "Extron DTP3 R 201", { status: "verified", source: "avail-library", portsOrigin: "manufacturer" }),
      c("d2", "EXTRON dtp3 r-201"),
      c("v1", "Biamp Desono C-IC6 Black", { modelNumber: "920-1" }),
      c("v2", "Biamp Desono C-IC6 White", { modelNumber: "920-2" }),
      c("h1", "Extron TLS 300M"),
      c("h2", "Extron TLS 300M", { status: "hidden" }),
    ]);
    expect(g.map((x) => [x.primary, x.members.map((m) => m.id), x.reasons])).toEqual([
      ["a1", ["a1", "a2"], ["same part number"]],
      ["d1", ["d1", "d2"], ["same model"]],
    ]);
  });

  it("the primary: verified > draft > raw, catalog > community, document > database, level, ports", () => {
    const g = duplicateGroups([
      c("raw-doc", "Extron X 1", { portsOrigin: "manufacturer" }),
      c("draft-cat", "Extron X 1", { status: "draft", source: "avail-catalog", portsOrigin: "community" }),
      c("draft-cat-doc", "Extron X 1", { status: "draft", source: "avail-catalog", portsOrigin: "manufacturer" }),
    ]);
    expect(g[0].members.map((m) => m.id)).toEqual(["draft-cat-doc", "draft-cat", "raw-doc"]);
  });

  it("findDuplicate: same manufacturer + part number, not hidden, not itself; another variant is allowed", () => {
    const existing = [
      c("x", "Extron DTP3 T 203", { modelNumber: "60-1885-52" }),
      c("w", "Biamp Desono C-IC6 White", { modelNumber: "920-9" }),
      c("h", "Extron Old", { modelNumber: "60-1-1", status: "hidden" }),
    ];
    expect(findDuplicate({ label: "Extron DTP3 T 203 copy", manufacturer: "Extron", modelNumber: "60 1885 52" }, existing)).toEqual({ id: "x", label: "Extron DTP3 T 203" });
    expect(findDuplicate({ id: "x", label: "Extron DTP3 T 203", manufacturer: "Extron", modelNumber: "60-1885-52" }, existing)).toBeNull();
    expect(findDuplicate({ label: "Biamp Desono C-IC6 Black", manufacturer: "Biamp", modelNumber: "920-9" }, existing)).toBeNull();
    expect(findDuplicate({ label: "Extron New", manufacturer: "Extron", modelNumber: "60-1-1" }, existing)).toBeNull();
    expect(findDuplicate({ label: "Extron X", manufacturer: "Extron", modelNumber: "" }, existing)).toBeNull();
  });

  it("report: one row per template, the primary first; markdown table", () => {
    const g = duplicateGroups([c("p", "Extron TLS 300M", { status: "draft", source: "avail-catalog" }), c("d", "Extron TLS 300M")]);
    expect(duplicateRows(g).map((r) => r.slice(0, 3))).toEqual([[1, "primary", "p"], [1, "duplicate", "d"]]);
    const md = formatDuplicates(g, { source: "test.sqlite", date: "2026-11-26", total: 2 });
    expect(md).toContain("**1** groups, **1** templates to merge");
    expect(md).toMatch(/\| 1 \| Extron TLS 300M \(`p`, Draft/);
  });
});

const info = (over: Partial<WsInfo> = {}): WsInfo => ({
  status: "draft", level: "A", statusReason: null, statusChangedAt: null, updatedAt: null, approvedBy: null, approvedVia: null, approvedAt: null,
  portsOrigin: "community", portsSource: "db", portsFrom: null, datasheetUrl: null, source: null, editors: [], lastActor: null, lastAt: null, ...over,
});
const tpl = (id: string, label: string, over: Partial<WsInfo> = {}): WsTemplate =>
  ({ id, label, manufacturer: "Extron", modelNumber: id, deviceType: "switcher", ports: [], avail: info(over) }) as unknown as WsTemplate;

describe("workspace: possible duplicates and Merge into…", () => {
  const rows = buildRows([
    tpl("p", "Extron TLS 300M", { duplicate: { primary: "p", size: 2 } }),
    tpl("z", "Extron TLS 300M", { duplicate: { primary: "p", size: 2 } }),
    tpl("solo", "Extron DTP3 T 203"),
  ]);

  it("the built-in filter and the column keep a group together, primary first", () => {
    const f = builtInFilters(null).find((x) => x.name === "Possible duplicates")!.filter;
    const shown = sortRows(filterRows(rows, f), "duplicateOf", false);
    expect(shown.map((r) => [r.id, r.duplicateOf])).toEqual([["p", "primary (2)"], ["z", "Extron TLS 300M (2)"]]);
    expect(filterRows(rows, EMPTY_FILTER)).toHaveLength(3);
  });

  it("the suggested primary and the plan: the others become hidden as duplicates of it", () => {
    const sel = rows.filter((r) => r.id !== "solo");
    expect(suggestedPrimary([...sel].reverse())!.id).toBe("p");
    const plan = planMerge(sel, sel[0]);
    expect(plan.change.map((c) => [c.row.id, c.to])).toEqual([["z", "Hidden (duplicate of Extron TLS 300M)"]]);
    const merged = buildRows([tpl("z", "Extron TLS 300M", { status: "hidden", statusReason: "duplicate of p" })]);
    expect(planMerge(merged, sel[0]).unchanged.map((r) => r.id)).toEqual(["z"]);
  });

  it("after a bulk action the selection is cleared; a failed batch stays selected", () => {
    expect([...selectionAfter({ batches: 1, updated: ["a"], unchanged: [], refused: [], failedBatches: [] })]).toEqual([]);
    expect([...selectionAfter({ batches: 2, updated: ["a"], unchanged: [], refused: [], failedBatches: [{ batch: 2, ids: ["b", "c"], error: "HTTP 500" }] })]).toEqual(["b", "c"]);
  });
});
