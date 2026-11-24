/**
 * Phase 1.4: the curated library files (src/avail/libraryFiles.ts), the review card views
 * (ports by section, device card) and the Edit flow conversion (src/avail/templateEdit.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { checkLibrary, checkLibraryFile, libraryFileName, parseHiddenList, productKey, slug } from "../avail/libraryFiles";
import { deviceCardRows, NO_SECTION, portsBySection } from "../avail/libraryView";
import { deviceDataToTemplate, editSessionFor, endEditSession, startEditSession } from "../avail/templateEdit";
import { AUTH_ERROR_MESSAGES } from "../avail/auth";
import type { DeviceTemplate } from "../types";

function tpl(over: Record<string, unknown> = {}) {
  return {
    id: "avail-dtp3",
    label: "Extron DTP3 T 203",
    shortName: "DTP3 T 203",
    manufacturer: "Extron",
    modelNumber: "60-1885-52",
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    heightMm: 44, widthMm: 222, depthMm: 216, weightKg: 0.98,
    powerDrawW: 90.3, voltage: "100-240V",
    referenceUrl: "https://www.extron.com/product/dtp3t203",
    searchTerms: ["dtp3"],
    ports: [
      { id: "1", label: "HDMI In 1", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
      { id: "2", label: "AC Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" },
    ],
    ...over,
  };
}

describe("library file names", () => {
  it("label in lower-case Latin, words joined by -", () => {
    expect(slug("Extron DTP3 T 203")).toBe("extron-dtp3-t-203");
    expect(slug("Biamp TesiraFORTÉ X 400")).toBe("biamp-tesiraforte-x-400");
    expect(slug("Biamp Parlé TCM-XA")).toBe("biamp-parle-tcm-xa");
    expect(slug("Netgear-AV M4250-26G4XF-PoE+")).toBe("netgear-av-m4250-26g4xf-poe");
    expect(libraryFileName({ label: "Shure SLXD4QDAN+A" })).toBe("shure-slxd4qdan-a.json");
  });
});

describe("checkLibrary", () => {
  it("a level-A template with the right file name passes", () => {
    const r = checkLibrary([{ file: "extron-dtp3-t-203.json", template: tpl() }]);
    expect(r.ok).toBe(true);
    expect(r.files[0].lint.level).toBe("A");
  });

  it("level below A, wrong name, no id fail; pending only checks the shape", () => {
    const below = tpl({ searchTerms: [] });
    expect(checkLibraryFile({ file: "extron-dtp3-t-203.json", template: below }).problems).toEqual(["standard level B, library/avail/ needs A"]);
    expect(checkLibraryFile({ file: "extron-dtp3-t-203.json", template: below }, false).problems).toEqual([]);
    expect(checkLibraryFile({ file: "dtp3.json", template: tpl() }).problems).toEqual(["file name must be extron-dtp3-t-203.json"]);
    const { id: _id, ...noId } = tpl();
    expect(checkLibraryFile({ file: "extron-dtp3-t-203.json", template: noId }).problems).toContain("no id");
    expect(checkLibraryFile({ file: "x.json", template: "invalid" }).problems).toEqual(["not a JSON object"]);
  });

  it("duplicate ids and duplicate manufacturer + model across files fail", () => {
    const r = checkLibrary([
      { file: "extron-dtp3-t-203.json", template: tpl() },
      { file: "extron-dtp3-t-203-copy.json", template: tpl({ label: "Extron DTP3 T 203 copy" }) },
    ]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "extron-dtp3-t-203-copy.json: same id as extron-dtp3-t-203.json",
      "extron-dtp3-t-203-copy.json: same manufacturer + model as extron-dtp3-t-203.json",
    ]);
  });

  it("product key: canonical manufacturer, model number or label, case and spacing ignored", () => {
    expect(productKey({ manufacturer: "Biamp Systems", modelNumber: "910-00014" })).toBe(productKey({ manufacturer: "biamp", modelNumber: " 910-00014" }));
    expect(productKey({ manufacturer: "Shure", label: "Shure AD4Q" })).toBe("shure|shure ad4q");
  });

  it("hidden list: needs id and reason", () => {
    expect(parseHiddenList({ hidden: [{ id: "a", reason: "dup", label: "X" }] })).toEqual([{ id: "a", reason: "dup", label: "X" }]);
    expect(() => parseHiddenList({ hidden: [{ id: "a" }] })).toThrow(/entry 0/);
    expect(() => parseHiddenList([])).toThrow();
  });
});

describe("the repository's curated library (CI gate)", () => {
  const dir = fileURLToPath(new URL("../../library/avail/", import.meta.url));
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, template: JSON.parse(readFileSync(dir + file, "utf8")) as unknown }));

  it("every library/avail/*.json is at standard level A, named by its label, unique", () => {
    expect(entries.length).toBeGreaterThan(0);
    const r = checkLibrary(entries);
    expect(r.problems).toEqual([]);
    for (const f of r.files) expect({ file: f.file, problems: f.problems, lint: f.lint }).toEqual({ file: f.file, problems: [], lint: { level: "A", errors: [], warnings: [] } });
  });

  it("library/hidden.json is well-formed", () => {
    const hidden = parseHiddenList(JSON.parse(readFileSync(fileURLToPath(new URL("../../library/hidden.json", import.meta.url)), "utf8")));
    expect(hidden.length).toBeGreaterThan(0);
  });
});

describe("review card views", () => {
  it("ports grouped by section in order of appearance, ports without a section last-seen group", () => {
    const groups = portsBySection([
      { label: "HDMI In 1", section: "Video Inputs", direction: "input", signalType: "hdmi", connectorType: "hdmi" },
      { label: "AC Power", section: "Power", direction: "input", signalType: "power", connectorType: "iec", notes: "C14" },
      { label: "HDMI In 2", section: "Video Inputs", direction: "input", signalType: "hdmi" },
      { label: "Odd", direction: "input", signalType: "usb" },
    ]);
    expect(groups.map((g) => g.section)).toEqual(["Video Inputs", "Power", NO_SECTION]);
    expect(groups[0].ports.map((p) => p.label)).toEqual(["HDMI In 1", "HDMI In 2"]);
    expect(groups[0].ports[1].connector).toBe("");
    expect(groups[1].ports[0]).toEqual({ label: "AC Power", direction: "input", signal: "power", connector: "iec", notes: "C14" });
  });

  it("device card: model, part number, category, physics, manufacturer link; dashes for missing values", () => {
    const rows = Object.fromEntries(deviceCardRows(tpl()).map((r) => [r.label, r]));
    expect(rows["Model"].value).toBe("Extron DTP3 T 203");
    expect(rows["Part number"].value).toBe("60-1885-52");
    expect(rows["Category"].value).toBe("AV distribution / Extenders");
    expect(rows["Dimensions"].value).toBe("44 × 222 × 216 mm (H × W × D)");
    expect(rows["Weight"].value).toBe("0.98 kg");
    expect(rows["Power"].value).toBe("90.3 W, 100-240V");
    expect(rows["Manufacturer page"]).toMatchObject({ href: "https://www.extron.com/product/dtp3t203" });
    const poe = Object.fromEntries(deviceCardRows({ label: "X", poeDrawW: 25.5 }).map((r) => [r.label, r.value]));
    expect(poe).toMatchObject({ Power: "PoE draw 25.5 W", Dimensions: "—", Weight: "—", "Manufacturer page": "—", "Part number": "—" });
  });
});

describe("Edit flow: editor data → template", () => {
  const original = { ...tpl(), version: 4, availStatus: "verified", slots: [{ id: "s1", label: "Slot 1", slotFamily: "f" }] } as unknown as DeviceTemplate;

  it("form fields come from the editor, a cleared field is removed, the rest is kept from the stored template", () => {
    const data = {
      ...tpl({ weightKg: 1.01, referenceUrl: "", searchTerms: ["dtp3", "new"] }),
      templateId: "avail-dtp3", templateVersion: 4, model: "Extron DTP3 T 203", hiddenPorts: ["2"], note: "site note",
    };
    const out = deviceDataToTemplate(data, original) as unknown as Record<string, unknown>;
    expect(out.weightKg).toBe(1.01);
    expect("referenceUrl" in out).toBe(false);
    expect(out.searchTerms).toEqual(["dtp3", "new"]);
    expect(out.slots).toEqual([{ id: "s1", label: "Slot 1", slotFamily: "f" }]);
    for (const k of ["id", "version", "availStatus", "templateId", "templateVersion", "model", "hiddenPorts", "note"]) expect(k in out, k).toBe(false);
  });

  it("ports of cards installed in the canvas copy are left out", () => {
    const data = { ...tpl(), ports: [...tpl().ports, { id: "card-1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Slot 1" }] };
    const out = deviceDataToTemplate(data, original, new Set(["card-1"]));
    expect(out.ports.map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("the live linter sees the edited template", () => {
    const out = deviceDataToTemplate({ ...tpl(), color: "#ff0000" }, original);
    expect(lintBlock(out).warnings).toContain("color is set");
  });

  it("edit sessions are per canvas node", () => {
    startEditSession("node-1", original);
    expect(editSessionFor("node-1")).toMatchObject({ templateId: "avail-dtp3" });
    expect(editSessionFor("node-2")).toBeUndefined();
    expect(editSessionFor(null)).toBeUndefined();
    endEditSession("node-1");
    expect(editSessionFor("node-1")).toBeUndefined();
    expect(() => startEditSession("n", { label: "x" } as DeviceTemplate)).toThrow();
  });
});

describe("English UI", () => {
  it("sign-in errors are English", () => {
    for (const m of Object.values(AUTH_ERROR_MESSAGES)) expect(m).toMatch(/^[\x20-\x7E]+$/);
  });

  it("no Cyrillic in the AVAIL UI and CLI sources", () => {
    const files = [
      "../avail/LibraryUi.tsx", "../avail/AuthErrorNotice.tsx", "../avail/auth.ts", "../avail/libraryMode.ts", "../avail/libraryView.ts",
      "../avail/blockLint.ts", "../avail/normalize.ts", "../avail/blockLintCli.ts", "../avail/checkLibraryCli.ts", "../avail/libraryFiles.ts",
      "../../api-avail/src/importUpstream.ts", "../../api-avail/src/importAvail.ts", "../../api-avail/src/normalizeLibrary.ts",
      "../../api-avail/src/routes.ts", "../../api-avail/src/server.ts", "../../api-avail/src/templateMeta.ts",
    ];
    for (const f of files) expect(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8"), f).not.toMatch(/[Ѐ-ӿ]/);
  });
});
