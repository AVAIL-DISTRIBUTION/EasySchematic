/**
 * Library workspace model (src/avail/workspaceModel.ts) and the xlsx writer (src/avail/xlsxWrite.ts).
 */
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../api-avail/src/xlsx";
import {
  activeFilterCount,
  buildRows,
  builtInFilters,
  categoryTree,
  completeFilter,
  diffIsEmpty,
  diffTemplates,
  EMPTY_FILTER,
  exportTable,
  facet,
  filterRows,
  planBulk,
  ruleKey,
  ruleLabel,
  sortRows,
  type WsInfo,
  type WsTemplate,
} from "../avail/workspaceModel";
import { buildXlsx, columnName } from "../avail/xlsxWrite";

const INFO: WsInfo = {
  status: "draft", level: null, statusReason: null, statusChangedAt: null, updatedAt: "2026-11-20 10:00:00", approvedBy: null,
  approvedVia: null, approvedAt: null, portsOrigin: "manufacturer", portsSource: "datasheet", portsFrom: "https://x/a.pdf",
  datasheetUrl: "https://x/a.pdf", source: "avail-catalog", editors: [], lastActor: null, lastAt: null,
};

function tpl(id: string, over: Partial<WsTemplate> = {}, info: Partial<WsInfo> = {}): WsTemplate {
  return {
    id,
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: `60-${id}`,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
    ],
    ...over,
    avail: { ...INFO, ...info },
  } as WsTemplate;
}

const LIB = [
  tpl("a"),
  tpl("b", { label: "Biamp Parlé TCM-XA", manufacturer: "Biamp", category: "Microphones / Array microphones", deviceType: "wired-mic", powerDrawW: undefined }, { status: "verified", level: "B", approvedBy: "lib@avail.test", approvedVia: "review", portsSource: "db", portsOrigin: "community", editors: ["eng@avail.test"] }),
  tpl("c", { label: "Extron SW4", category: "AV distribution / Switchers", deviceType: "switcher", ports: [{ id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs" }] as never }, { status: "hidden", level: "FIX", portsSource: null, portsOrigin: "none", updatedAt: "2026-10-01 09:00:00" }),
];

describe("rows and lint rules", () => {
  it("builds rows with the stored level, model without vendor, ports source label, rule keys", () => {
    const rows = buildRows(LIB);
    expect(rows.map((r) => [r.id, r.model, r.level, r.portsSource])).toEqual([
      ["a", "DTP3 T 203", "A", "Data sheet"],
      ["b", "Parlé TCM-XA", "B", "Database"],
      ["c", "SW4", "FIX", "None recorded"],
    ]);
    expect(rows[2].rules).toContain('E "…": no connectorType');
    expect(rows[1].rules).toContain("W no powerDrawW/voltage");
  });

  it("ruleKey drops port labels and specifics; ruleLabel names the common ones", () => {
    expect(ruleKey('"HDMI In": section "Rear" is not in the vocabulary; use "Video Inputs"')).toBe('"…": section "…" is not in the vocabulary');
    expect(ruleKey("no powerDrawW/voltage (or poeDrawW)")).toBe("no powerDrawW/voltage");
    expect(ruleLabel("E no power port")).toBe("No power port");
    expect(ruleLabel("W something new")).toBe("Warning: something new");
  });
});

describe("filters", () => {
  const rows = buildRows(LIB);
  const ids = (f: Partial<typeof EMPTY_FILTER>) => filterRows(rows, { ...EMPTY_FILTER, ...f }).map((r) => r.id);

  it("combine: vendor, category group or leaf, type, status, level, source, rule, date, approver, editor, text", () => {
    expect(ids({ vendors: ["Extron"] })).toEqual(["a", "c"]);
    expect(ids({ categories: ["AV distribution"] })).toEqual(["a", "c"]);
    expect(ids({ categories: ["AV distribution / Switchers"] })).toEqual(["c"]);
    expect(ids({ vendors: ["Extron"], statuses: ["draft"] })).toEqual(["a"]);
    expect(ids({ levels: ["B", "FIX"] })).toEqual(["b", "c"]);
    expect(ids({ portsSources: ["Database"] })).toEqual(["b"]);
    expect(ids({ rules: ['E "…": no connectorType'] })).toEqual(["c"]);
    expect(ids({ changedSince: "2026-11-01" })).toEqual(["a", "b"]);
    expect(ids({ approvedBy: ["lib@avail.test"] })).toEqual(["b"]);
    expect(ids({ editedBy: "eng@avail.test" })).toEqual(["b"]);
    expect(ids({ text: "tcm parlé" })).toEqual(["b"]);
    expect(ids({ text: "60-c" })).toEqual(["c"]);
    expect(activeFilterCount({ ...EMPTY_FILTER, vendors: ["Extron"], text: "x", changedSince: "2026-01-01" })).toBe(3);
  });

  it("built-in saved filters: review queue, my edits only when signed in", () => {
    expect(builtInFilters(null).map((f) => f.name)).toEqual(["Review queue", "Drafts to fix", "Unverified", "Approved without document check", "Hidden"]);
    const mine = builtInFilters("eng@avail.test").find((f) => f.name === "My edits")!;
    expect(filterRows(rows, mine.filter).map((r) => r.id)).toEqual(["b"]);
    expect(filterRows(rows, builtInFilters(null)[0].filter).map((r) => r.id)).toEqual(["a"]);
  });

  it("Approved without document check: verified, community ports, bulk-approved", () => {
    const lib = buildRows([
      ...LIB,
      tpl("d", {}, { status: "verified", approvedVia: "bulk", approvedBy: "lib@avail.test", portsOrigin: "community", portsSource: "db" }),
      tpl("e", {}, { status: "verified", approvedVia: "bulk", portsOrigin: "manufacturer" }),
      tpl("f", {}, { status: "draft", approvedVia: "bulk", portsOrigin: "community", portsSource: "db" }),
    ]);
    const preset = builtInFilters(null).find((f) => f.name === "Approved without document check")!;
    // b is verified with community ports but approved in the Review card: not in the set.
    expect(filterRows(lib, preset.filter).map((r) => r.id)).toEqual(["d"]);
    expect(activeFilterCount(preset.filter)).toBe(3);
    // An older saved filter without the new fields still works once completed.
    const old = { ...EMPTY_FILTER } as Partial<typeof EMPTY_FILTER>;
    delete old.origins;
    delete old.approvedVia;
    expect(filterRows(lib, completeFilter(old)).length).toBe(lib.length);
  });

  it("facets and the category tree count rows", () => {
    expect(facet(rows, (r) => r.vendor)).toEqual([{ value: "Extron", count: 2 }, { value: "Biamp", count: 1 }]);
    expect(categoryTree(rows).map((g) => [g.group, g.count, g.leaves.map((l) => l.leaf)])).toEqual([
      ["AV distribution", 2, ["Extenders", "Switchers"]],
      ["Microphones", 1, ["Array microphones"]],
    ]);
  });

  it("sorts by any column, level by A < B < FIX", () => {
    expect(sortRows(rows, "level", true).map((r) => r.level)).toEqual(["FIX", "B", "A"]);
    expect(sortRows(rows, "vendor", false).map((r) => r.vendor)).toEqual(["Biamp", "Extron", "Extron"]);
  });
});

describe("bulk plans", () => {
  const rows = buildRows(LIB);
  it("approve: changes level A, refuses below A, leaves verified", () => {
    const p = planBulk("approve", rows);
    expect(p.change.map((c) => [c.row.id, c.from, c.to])).toEqual([["a", "Draft", "Verified"]]);
    expect(p.refused.map((x) => [x.row.id, x.reason])).toEqual([["c", "level FIX: verified needs level A"]]);
    expect(p.unchanged.map((r) => r.id)).toEqual(["b"]);
  });

  it("unhide only touches hidden ones; hide; category needs a leaf", () => {
    expect(planBulk("unhide", rows).change.map((c) => c.row.id)).toEqual(["c"]);
    expect(planBulk("hide", rows).change.map((c) => c.row.id)).toEqual(["a", "b"]);
    const cat = planBulk("category", rows, "AV distribution / Switchers");
    expect(cat.change.map((c) => [c.row.id, c.to])).toEqual([["a", "AV distribution / Switchers"], ["b", "AV distribution / Switchers"]]);
    expect(cat.unchanged.map((r) => r.id)).toEqual(["c"]);
    expect(planBulk("category", rows, "AV distribution").refused).toHaveLength(3);
  });
});

describe("proposal diff", () => {
  it("fields, ports by id (else label), slots", () => {
    const before = tpl("a") as unknown as Record<string, unknown>;
    const after = {
      ...before,
      powerDrawW: 7,
      ports: [
        { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi", notes: "HDCP 2.3" },
        { id: "9", label: "LAN", signalType: "ethernet", direction: "bidirectional", section: "Network", connectorType: "rj45" },
      ],
    };
    const d = diffTemplates(before, after);
    expect(d.fields).toEqual([{ field: "powerDrawW", before: "6", after: "7" }]);
    expect(d.ports.map((p) => [p.kind, p.label, p.changes.map((c) => c.field)])).toEqual([
      ["changed", "HDMI In", ["notes"]],
      ["added", "LAN", ["label", "signalType", "direction", "section", "connectorType"]],
      ["removed", "Power", []],
    ]);
    expect(d.slots).toBeNull();
    expect(diffIsEmpty(diffTemplates(before, { ...before }))).toBe(true);
  });
});

describe("xlsx export", () => {
  it("writes a workbook the reader reads back", () => {
    const table = exportTable(buildRows(LIB));
    const bytes = buildXlsx("Templates", table);
    const sheets = readXlsx(Buffer.from(bytes));
    const rows = sheets.get("Templates")!;
    expect(rows[0].slice(0, 3)).toEqual(["Vendor", "Model", "Part number"]);
    expect(rows[1].slice(0, 3)).toEqual(["Extron", "DTP3 T 203", "60-a"]);
    expect(rows[2][8]).toBe("0"); // errors as a number
    expect(rows.length).toBe(4);
    expect(columnName(0)).toBe("A");
    expect(columnName(26)).toBe("AA");
    expect(buildXlsx("x", [["a & <b>", 1]]).length).toBeGreaterThan(100);
  });
});
