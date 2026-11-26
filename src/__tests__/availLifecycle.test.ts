/**
 * Product lifecycle and reference-list choice (AVAIL): src/avail/lifecycle.ts, the linter's estimates
 * rule (standard v0.12), the badges' data in libraryMode.ts, the workspace filter / column / Set
 * lifecycle plan, the intake columns, the catalog check; src/avail/referenceLists.ts (Category and
 * Manufacturer in the Device Editor and bulk Change category).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lintBlock } from "../avail/blockLint";
import { cardFromRow, INTAKE_COLUMNS, mergeCard, validateIntake } from "../avail/intake";
import { checkCatalog } from "../avail/libraryFiles";
import {
  isLifecycleDate,
  lifecycleBadge,
  lifecycleBlocks,
  lifecycleOf,
  lifecycleText,
  parseLifecycleInput,
  sameLifecycle,
} from "../avail/lifecycle";
import { blockLifecycle, lifecycleOfTemplate, noteLibraryResponse, resetForTests } from "../avail/libraryMode";
import { AvailLifecycleNotice } from "../avail/LibraryUi";
import { AvailListPicker } from "../avail/ListPicker";
import {
  BOQ_ONLY,
  categoryForDeviceType,
  categoryOptions,
  exactOption,
  filterOptions,
  groupOptions,
  listFieldErrors,
  VENDOR_GROUPS,
  vendorOptions,
} from "../avail/referenceLists";
import { bulkReport, runBulk } from "../avail/workspaceBulk";
import { buildRows, COLUMNS, completeFilter, EMPTY_FILTER, exportTable, filterRows, planLifecycle, sortRows, type WsInfo, type WsTemplate } from "../avail/workspaceModel";
import type { DeviceTemplate } from "../types";

/** A level-A template; `notes` goes on its power port. */
function block(over: Record<string, unknown> = {}, notes?: string) {
  return {
    id: "a",
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: "60-1",
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 25, widthMm: 100, depthMm: 90, weightKg: 0.3,
    powerDrawW: 6, voltage: "12V DC",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel", ...(notes ? { notes } : {}) },
    ],
    ...over,
  };
}

describe("lifecycle values", () => {
  it("lifecycleOf: missing or unknown → active; a date only with its state", () => {
    expect(lifecycleOf(undefined)).toEqual({ lifecycle: "active" });
    expect(lifecycleOf({ lifecycle: "retired" })).toEqual({ lifecycle: "active" });
    expect(lifecycleOf({ lifecycle: "upcoming", availableFrom: "2027-Q3", eolDate: "2030" })).toEqual({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    expect(lifecycleOf({ lifecycle: "eol", eolDate: "2026-06", availableFrom: "2027" })).toEqual({ lifecycle: "eol", eolDate: "2026-06" });
    expect(lifecycleOf({ lifecycle: "upcoming", availableFrom: "soon" })).toEqual({ lifecycle: "upcoming" });
  });

  it("dates: year, quarter, month, day", () => {
    for (const d of ["2027", "2027-Q3", "2027-09", "2027-09-15"]) expect(isLifecycleDate(d)).toBe(true);
    for (const d of ["27", "2027-Q5", "2027-13", "Q3 2027", "2027/09", ""]) expect(isLifecycleDate(d)).toBe(false);
  });

  it("parseLifecycleInput: state, the date that goes with it, typed forms normalised", () => {
    expect(parseLifecycleInput({ lifecycle: "upcoming", availableFrom: "2027 q3" })).toEqual({ ok: true, value: { lifecycle: "upcoming", availableFrom: "2027-Q3" } });
    expect(parseLifecycleInput({ lifecycle: "upcoming", availableFrom: "" })).toEqual({ ok: true, value: { lifecycle: "upcoming" } });
    expect(parseLifecycleInput({ lifecycle: "eol" })).toEqual({ ok: true, value: { lifecycle: "eol" } });
    expect(parseLifecycleInput({ lifecycle: "active" })).toEqual({ ok: true, value: { lifecycle: "active" } });
    expect(parseLifecycleInput({ lifecycle: "gone" })).toMatchObject({ ok: false });
    expect(parseLifecycleInput({ lifecycle: "eol", eolDate: "June" })).toMatchObject({ ok: false, error: expect.stringMatching(/eolDate must be/) });
    expect(parseLifecycleInput({ lifecycle: "eol", availableFrom: "2027" })).toEqual({ ok: false, error: "availableFrom is only for upcoming" });
  });

  it("badge and text", () => {
    expect(lifecycleBadge({ lifecycle: "upcoming", availableFrom: "2027-Q3" })).toBe("Upcoming · 2027-Q3");
    expect(lifecycleBadge({ lifecycle: "upcoming" })).toBe("Upcoming");
    expect(lifecycleBadge({ lifecycle: "eol", eolDate: "2026-06" })).toBe("EoL");
    expect(lifecycleBadge({ lifecycle: "active" })).toBeNull();
    expect(lifecycleText({ lifecycle: "upcoming", availableFrom: "2027-Q3" })).toBe("Upcoming, available from 2027-Q3");
    expect(lifecycleText({ lifecycle: "eol", eolDate: "2026-06" })).toBe("EoL since 2026-06");
    expect(lifecycleText(null)).toBe("Active");
    expect(sameLifecycle({ lifecycle: "eol" }, { lifecycle: "eol", eolDate: "2026" })).toBe(false);
  });
});

describe("linter: values estimated from an analog (standard v0.12)", () => {
  it("are a warning for an active or EoL product, fine for an upcoming one", () => {
    expect(lintBlock(block()).level).toBe("A");
    const port = lintBlock(block({}, "estimated from DTP3 T 202"));
    expect(port.level).toBe("B");
    expect(port.warnings).toEqual(['"Power": estimated from an analog: use the manufacturer\'s value']);
    const card = lintBlock(block({ _avail: { notes: "Weight estimated from DTP3 T 202" } }));
    expect(card.warnings).toEqual(["estimated from an analog (catalog notes): use the manufacturer's value"]);
    expect(lintBlock(block({ _avail: { lifecycle: "eol", notes: "estimated from X" } })).level).toBe("B");

    const upcoming = { lifecycle: "upcoming", availableFrom: "2027-Q3", notes: "Dimensions estimated from DTP3 T 202" };
    expect(lintBlock(block({ _avail: upcoming }, "estimated from DTP3 T 202"))).toEqual({ level: "A", errors: [], warnings: [] });
  });

  it("other estimate wordings are not this rule ([AVAIL] estimated: …)", () => {
    expect(lintBlock(block({ _avail: { notes: "[AVAIL] estimated: 19\" rack width" } })).level).toBe("A");
  });
});

describe("library badges and the reports' warning", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    resetForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  const t = (id: string, availLifecycle?: unknown) => ({ id, label: id, deviceType: "switcher", ports: [], availStatus: "verified", ...(availLifecycle ? { availLifecycle } : {}) }) as unknown as DeviceTemplate;
  const nodes = [
    { id: "n1", type: "device", data: { templateId: "u", label: "Encoder" } },
    { id: "n2", type: "device", data: { templateId: "e", label: "Old switcher" } },
    { id: "n3", type: "device", data: { templateId: "a", label: "Amp" } },
    { id: "n4", type: "note", data: {} },
  ];

  it("the library's availLifecycle gives the block's lifecycle; active and unknown give none", () => {
    expect(lifecycleOfTemplate(t("u", { lifecycle: "upcoming", availableFrom: "2027-Q3" }))).toEqual({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    expect(lifecycleOfTemplate(t("a", { lifecycle: "active" }))).toBeNull();
    expect(blockLifecycle("u")).toBeNull(); // library not loaded
    noteLibraryResponse(new Response("[]", { headers: { "X-Avail-Library": "1" } }), [t("u", { lifecycle: "upcoming", availableFrom: "2027-Q3" }), t("e", { lifecycle: "eol" }), t("a")]);
    expect(blockLifecycle("u")).toEqual({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    expect(blockLifecycle("e")).toEqual({ lifecycle: "eol" });
    expect(blockLifecycle("a")).toBeNull();
    expect(lifecycleBlocks(nodes, blockLifecycle).map((b) => [b.label, b.lifecycle.lifecycle])).toEqual([
      ["Encoder", "upcoming"],
      ["Old switcher", "eol"],
    ]);
    const html = renderToStaticMarkup(createElement(AvailLifecycleNotice, { nodes }));
    expect(html).toContain("This project has 1 block of an upcoming product.");
    expect(html).toContain("Encoder (Upcoming, available from 2027-Q3)");
    expect(html).toContain("This project has 1 block of an end-of-life product.");
    expect(renderToStaticMarkup(createElement(AvailLifecycleNotice, { nodes: [nodes[2]] }))).toBe("");
  });

  it("against upstream's API: no lifecycle", () => {
    noteLibraryResponse(new Response("[]"), [t("u", { lifecycle: "upcoming" })]);
    expect(blockLifecycle("u")).toBeNull();
  });
});

describe("workspace", () => {
  const INFO: WsInfo = {
    status: "draft", level: null, statusReason: null, statusChangedAt: null, updatedAt: null, approvedBy: null, approvedVia: null, approvedAt: null,
    portsOrigin: "manufacturer", portsSource: "datasheet", portsFrom: null, datasheetUrl: null, source: null, editors: [], lastActor: null, lastAt: null,
  };
  const ws = (id: string, info: Partial<WsInfo>, notes?: string) => ({ ...block({ id, modelNumber: `60-${id}` }, notes), avail: { ...INFO, ...info } }) as unknown as WsTemplate;
  const rows = buildRows([
    ws("u", { lifecycle: "upcoming", availableFrom: "2027-Q3" }, "estimated from DTP3 T 202"),
    ws("e", { lifecycle: "eol", eolDate: "2026-06" }),
    ws("a", {}),
    ws("x", { lifecycle: "active" }, "estimated from DTP3 T 202"),
  ]);

  it("rows carry the lifecycle; the page's lint knows an upcoming product", () => {
    expect(rows.map((r) => r.lifecycleText)).toEqual(["Upcoming, available from 2027-Q3", "EoL since 2026-06", "Active", "Active"]);
    expect(rows.map((r) => r.lint.level)).toEqual(["A", "A", "A", "B"]);
  });

  it("Lifecycle filter, column, export", () => {
    const ids = (f: Partial<typeof EMPTY_FILTER>) => filterRows(rows, { ...EMPTY_FILTER, ...f }).map((r) => r.id);
    expect(ids({ lifecycles: ["upcoming"] })).toEqual(["u"]);
    expect(ids({ lifecycles: ["active", "eol"] })).toEqual(["e", "a", "x"]);
    expect(completeFilter({ statuses: ["draft"] }).lifecycles).toEqual([]);
    expect(COLUMNS.find((c) => c.id === "lifecycle")!.label).toBe("Lifecycle");
    expect(sortRows(rows, "lifecycle", false).map((r) => r.id)).toEqual(["u", "a", "x", "e"]);
    const table = exportTable(rows);
    expect(table[0][7]).toBe("Lifecycle");
    expect(table[1][7]).toBe("Upcoming, available from 2027-Q3");
  });

  it("Set lifecycle: plan, batches, report", async () => {
    const plan = planLifecycle(rows, { lifecycle: "eol", eolDate: "2026-06" });
    expect(plan.unchanged.map((r) => r.id)).toEqual(["e"]);
    expect(plan.change.map((c) => [c.row.id, c.from, c.to])).toEqual([
      ["u", "Upcoming, available from 2027-Q3", "EoL since 2026-06"],
      ["a", "Active", "EoL since 2026-06"],
      ["x", "Active", "EoL since 2026-06"],
    ]);
    const out = await runBulk(plan, async (ids) => ({ updated: ids, unchanged: [], failed: [], demoted: ["u"] }));
    const report = bulkReport(plan, out);
    expect(report[0]).toMatch(/^Lifecycle set to EoL since 2026-06: 3 changed/);
    expect(report).toContain("1 verified moved to draft: below level A with this lifecycle (estimated values).");
  });
});

describe("intake: Lifecycle and Lifecycle date", () => {
  const HEADER = [...INTAKE_COLUMNS];
  const names = HEADER.map((h) => h.replace(/\s*\*$/, ""));
  const sheet = (...rows: Record<string, string>[]) => [HEADER, ...rows.map((r) => names.map((n) => r[n] ?? ""))];
  const ROW = {
    Vendor: "Extron", Category: "AV distribution / Extenders", "Device type": "hdbaset-extender", Model: "Extron DTP4 T 203", "Part number": "60-9",
    "Input voltage": "12V DC", "Power draw (W)": "6", "Rack form": "Non-rack", "Reference URL": "https://www.extron.com/x", "Datasheet URL": "https://www.extron.com/x.pdf",
    Source: "AVAIL estimate",
  };

  it("validates the state and the date", () => {
    const v = validateIntake(sheet({ ...ROW, Lifecycle: "Upcoming", "Lifecycle date": "2027-Q3" }, { ...ROW, "Part number": "60-8", Lifecycle: "Soon" }, { ...ROW, "Part number": "60-7", Lifecycle: "Active", "Lifecycle date": "2027" }, { ...ROW, "Part number": "60-6", Lifecycle: "Upcoming" }, { ...ROW, "Part number": "60-5", Lifecycle: "EoL", "Lifecycle date": "June" }));
    expect(v.rows[0].errors).toEqual([]);
    expect(v.rows[1].errors).toContain('Lifecycle "Soon" is not in the list');
    expect(v.rows[2].errors).toContain("Lifecycle date is only for Upcoming (available from) or EoL (end of life)");
    expect(v.rows[3].warnings).toContain("Lifecycle Upcoming without Lifecycle date: when does it ship?");
    expect(v.rows[4].errors[0]).toMatch(/Lifecycle date "June" must be/);
  });

  it("goes to _avail; a lifecycle in the row replaces the card's", () => {
    const up = cardFromRow({ ...ROW, Lifecycle: "Upcoming", "Lifecycle date": "2027 q3" } as never, "f.xlsx");
    expect(up._avail).toMatchObject({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
    expect(cardFromRow(ROW as never, "f.xlsx")._avail.lifecycle).toBeUndefined();
    const released = mergeCard({ ...up, ports: [{ id: "p" }] }, cardFromRow({ ...ROW, Lifecycle: "Active" } as never, "g.xlsx"));
    expect(released._avail.lifecycle).toBe("active");
    expect(released._avail.availableFrom).toBeUndefined();
    const kept = mergeCard({ ...up, ports: [{ id: "p" }] }, cardFromRow(ROW as never, "g.xlsx"));
    expect(kept._avail).toMatchObject({ lifecycle: "upcoming", availableFrom: "2027-Q3" });
  });
});

describe("catalog check: _avail.lifecycle", () => {
  const entry = (avail: Record<string, unknown>) => ({ file: "extron/extron-dtp3-t-203.json", template: { ...block(), _avail: avail } });
  it("a known state, a date in a known format, only the date of the state", () => {
    expect(checkCatalog([entry({ lifecycle: "upcoming", availableFrom: "2027-Q3" })]).files[0].problems).toEqual([]);
    expect(checkCatalog([entry({ lifecycle: "soon" })]).files[0].problems).toEqual(["_avail.lifecycle must be one of upcoming, active, eol"]);
    expect(checkCatalog([entry({ lifecycle: "eol", eolDate: "June" })]).files[0].problems).toEqual(["_avail.eolDate must be 2027, 2027-Q3, 2027-09 or 2027-09-15"]);
    expect(checkCatalog([entry({ lifecycle: "active", availableFrom: "2027" })]).files[0].problems).toEqual(["_avail.availableFrom is only for lifecycle upcoming"]);
  });
});

describe("reference lists: Category and Manufacturer", () => {
  it("categories: leaves only, grouped by the top level, BoQ only for schematic=false", () => {
    const opts = categoryOptions();
    expect(opts.every((o) => o.value.includes(" / ") || o.group === o.value)).toBe(true);
    expect(opts.find((o) => o.value === "AV distribution / Extenders")).toMatchObject({ label: "Extenders", group: "AV distribution" });
    expect(opts.find((o) => o.value === "AV distribution / Accessories")?.tag).toBe(BOQ_ONLY);
    expect(opts.some((o) => o.value === "AV distribution")).toBe(false); // a group, not a leaf
    expect(groupOptions(opts)[0].group).toBe("AV distribution");
    expect(filterOptions(opts, "av ext").map((o) => o.value)).toContain("AV distribution / Extenders");
    expect(filterOptions(opts, "zzz")).toEqual([]);
  });

  it("vendors: portfolio, supported and Generic; an alias picks the canonical name", () => {
    const opts = vendorOptions();
    expect(new Set(opts.map((o) => o.group))).toEqual(new Set(Object.values(VENDOR_GROUPS)));
    expect(opts.find((o) => o.value === "Generic")?.group).toBe(VENDOR_GROUPS.generic);
    expect(opts.find((o) => o.value === "Extron")?.group).toBe(VENDOR_GROUPS.portfolio);
    expect(exactOption(opts, "WyreStorm")?.value).toBe("Wyrestorm");
    expect(exactOption(opts, " wyrestorm ")?.value).toBe("Wyrestorm");
    expect(exactOption(opts, "Wyre")).toBeUndefined();
    expect(filterOptions(opts, "wyrest").map((o) => o.value)).toEqual(["Wyrestorm"]);
  });

  it("a new value outside the lists cannot be saved; a value already there may stay", () => {
    expect(listFieldErrors({ category: "video", manufacturer: "Sony" }, { category: "video", manufacturer: "Sony" })).toEqual([]);
    expect(listFieldErrors({ category: "video" }, { category: "Video gear" })).toEqual(['Category "Video gear" is not in the list: pick a leaf category of the taxonomy']);
    expect(listFieldErrors({}, { category: "AV distribution" })).toHaveLength(1);
    expect(listFieldErrors({}, { manufacturer: "WyreStorm" })).toEqual(['Manufacturer "WyreStorm" is an alias: pick "Wyrestorm"']);
    expect(listFieldErrors({}, { manufacturer: "Acme" })[0]).toMatch(/not in the list/);
    expect(listFieldErrors(null, { category: "AV distribution / Extenders", manufacturer: "Extron" })).toEqual([]);
  });

  it("the device type fills the taxonomy default in the AVAIL build, upstream's category otherwise", () => {
    expect(categoryForDeviceType("hdbaset-extender", "video", true)).toBe("AV distribution / Extenders");
    expect(categoryForDeviceType("hdbaset-extender", "video", false)).toBe("video");
    expect(categoryForDeviceType("no-such-type", "video", true)).toBeUndefined();
  });

  it("the picker shows the current value, and marks one outside the list", () => {
    const opts = categoryOptions();
    const html = (value: string) => renderToStaticMarkup(createElement(AvailListPicker, { value, onChange: () => {}, options: opts, ariaLabel: "Category" }));
    expect(html("AV distribution / Extenders")).toContain('value="AV distribution / Extenders"');
    expect(html("AV distribution / Extenders")).not.toContain("not in the list");
    expect(html("video")).toContain("not in the list");
    expect(html("")).not.toContain("not in the list");
  });
});
