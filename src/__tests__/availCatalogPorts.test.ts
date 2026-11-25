/**
 * src/avail/catalogPorts.ts — ports of the product catalog (library/catalog) from the curated
 * library, a database snapshot and variants (step 1.9).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  catalogFileName,
  fillCatalogPorts,
  hasManualPorts,
  modelName,
  variantBase,
  type CatalogFile,
  type CatalogTemplate,
  type PortDonor,
} from "../avail/catalogPorts";
import { checkCatalog } from "../avail/libraryFiles";

const PORTS = [
  { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" },
  { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "barrel" },
];

function card(label: string, modelNumber: string, extra: Partial<CatalogTemplate> = {}): CatalogFile {
  const t: CatalogTemplate = {
    id: `avail-extron-${modelNumber}`,
    label,
    shortName: label.replace(/^Extron /, ""),
    manufacturer: "Extron",
    modelNumber,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    heightMm: 25,
    powerDrawW: 6,
    _avail: { status: "awaiting-ports" },
    ports: [],
    ...extra,
  };
  return { file: `extron/${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`, template: t };
}

function donor(id: string, label: string, modelNumber: string, extra: Partial<PortDonor> = {}): PortDonor {
  return { id, label, manufacturer: "Extron", modelNumber, ports: PORTS, status: "raw", level: "A", ...extra };
}

describe("matching", () => {
  it("variantBase drops the variant in brackets and a trailing colour", () => {
    expect(variantBase("Extron NAV 10E 201 D (Black, MM)")).toBe("extron nav 10e 201 d");
    expect(variantBase("Biamp BMA 360D White")).toBe("biamp bma 360d");
    expect(variantBase("Biamp BMA 360D-I Black")).toBe("biamp bma 360d-i");
    expect(modelName("Extron DTP3 T 203", "Extron")).toBe("dtp3 t 203");
  });

  it("part number first, then model name; the best donor wins", () => {
    const files = [card("Extron DTP3 T 203", "60-1885-52"), card("Extron DTP3 R 203", "60-1886-52")];
    const db = [
      donor("raw-pn", "Extron DTP3 T 203 old", "60-1885-52"),
      donor("verified-pn", "Extron DTP3 T 203", "60-1885-52", { status: "verified", ports: [PORTS[0]] }),
      donor("by-name", "Extron DTP3 R 203", "DTP3 R 203", { status: "draft" }),
      donor("by-name-b", "Extron DTP3 R 203", "DTP3 R 203", { status: "draft", level: "B" }),
    ];
    const r = fillCatalogPorts(files, { library: [], db });
    expect(r.changed.map((f) => f.template._avail.portsSource)).toEqual([
      { kind: "db", from: "verified-pn", label: "Extron DTP3 T 203", match: "part-number", status: "verified", level: "A" },
      { kind: "db", from: "by-name", label: "Extron DTP3 R 203", match: "model-name", status: "draft", level: "A" },
    ]);
    expect(r.changed[0].template.ports).toEqual([PORTS[0]]);
    expect(r.changed[0].template._avail.status).toBe("ports-filled");
  });

  it("hidden and port-less database templates are no donors", () => {
    const db = [donor("h", "Extron DTP3 T 203", "60-1885-52", { status: "hidden" }), donor("e", "Extron DTP3 T 203", "60-1885-52", { ports: [] })];
    const r = fillCatalogPorts([card("Extron DTP3 T 203", "60-1885-52")], { library: [], db });
    expect(r.rows[0].source).toBe("none");
    expect(r.changed).toEqual([]);
  });

  it("library/avail goes before the database for its own models", () => {
    const lib = [{ ...donor("lib-id", "Extron DTP3 T 203", "60-1885-52"), file: "extron-dtp3-t-203.json", status: "verified" as const }];
    const db = [donor("db-id", "Extron DTP3 T 203", "60-1885-52", { status: "verified" })];
    const r = fillCatalogPorts([card("Extron DTP3 T 203", "60-1885-52")], { library: lib, db });
    expect(r.rows[0]).toMatchObject({ source: "library", from: "extron-dtp3-t-203.json" });
  });

  it("an alternative part number matches too", () => {
    const f = card("Extron Tesira X", "60-1-01", { _avail: { status: "awaiting-ports", altPartNumber: "60-1-02" } });
    const r = fillCatalogPorts([f], { library: [], db: [donor("alt", "Something", "60-1-02")] });
    expect(r.rows[0]).toMatchObject({ source: "db", from: "alt" });
  });
});

describe("card stays, variants, manual ports", () => {
  it("never overwrites the card: only ports, slots and _avail change", () => {
    const f = card("Extron DTP3 T 203", "60-1885-52");
    const d = donor("x", "Extron DTP3 T 203", "60-1885-52", { heightMm: 99, category: "Other / Generic" } as Partial<PortDonor>);
    const out = fillCatalogPorts([f], { library: [], db: [d] }).changed[0].template;
    const { ports: _p, _avail: _a, ...cardAfter } = out;
    const { ports: _p0, _avail: _a0, ...cardBefore } = f.template;
    expect(cardAfter).toEqual(cardBefore);
    expect(Object.keys(out).slice(-2)).toEqual(["_avail", "ports"]);
  });

  it("variants of a described model copy its ports", () => {
    const files = [
      card("Extron NAV 10E 201 D (Black, MM)", "60-1572-21"),
      card("Extron NAV 10E 201 D (White, SM)", "60-1572-24"),
    ];
    const r = fillCatalogPorts(files, { library: [], db: [donor("d", "Extron NAV 10E 201 D Black MM", "60-1572-21")] });
    expect(r.rows.map((x) => x.source)).toEqual(["db", "variant"]);
    expect(r.changed[1].template._avail.portsSource).toMatchObject({ kind: "variant", from: files[0].file });
  });

  it("ports from a datasheet stay and serve their variants", () => {
    const manual = card("Biamp BMA 360D Black", "920-00030-10000", {
      manufacturer: "Biamp",
      ports: PORTS,
      _avail: { status: "ports-filled", portsSource: { kind: "datasheet", from: "https://www.biamp.com/x.pdf" } },
    });
    const white = card("Biamp BMA 360D White", "910-00009", { manufacturer: "Biamp" });
    expect(hasManualPorts(manual.template)).toBe(true);
    const r = fillCatalogPorts([manual, white], { library: [], db: [donor("d", "Biamp BMA 360D", "920-00030-10000", { manufacturer: "Biamp", status: "hidden" })] });
    expect(r.rows.map((x) => x.source)).toEqual(["datasheet", "variant"]);
    expect(r.changed.map((f) => f.file)).toEqual([white.file]);
  });

  it("copied slots get the catalog slot family when they take none of its families", () => {
    const f = card("Extron Cable Cubby 1202", "60-1-1", { _avail: { status: "awaiting-ports", slotFamilies: ["extron-cubby-aap"] } });
    const d = donor("c", "Extron Cable Cubby 1202", "60-1-1", { ports: [], slots: [{ id: "slot-1", label: "Slot 1", slotFamily: "extron-cubby" }] });
    const r = fillCatalogPorts([f], { library: [], db: [d] });
    expect(r.changed[0].template.slots).toEqual([{ id: "slot-1", label: "Slot 1", slotFamily: "extron-cubby-aap" }]);
    expect(r.slotFamilyFixes).toEqual([{ file: f.file, catalog: ["extron-cubby-aap"], copied: ["extron-cubby"] }]);
  });

  it("is idempotent", () => {
    const files = [card("Extron DTP3 T 203 (Black)", "60-1"), card("Extron DTP3 T 203 (White)", "60-2")];
    const sources = { library: [], db: [donor("d", "Extron DTP3 T 203", "60-1")] };
    const first = fillCatalogPorts(files, sources);
    const after = files.map((f) => first.changed.find((c) => c.file === f.file) ?? f);
    expect(fillCatalogPorts(after, sources).changed).toEqual([]);
  });

  it("catalogFileName is <vendor>/<slug(label)>.json", () => {
    expect(catalogFileName({ manufacturer: "Extron", label: "Extron NAV 10E 101 (MM)" })).toBe("extron/extron-nav-10e-101-mm.json");
  });
});

describe("checkCatalog (CI, step 1.9)", () => {
  const entry = (file: string, t: Record<string, unknown>) => ({ file, template: t });
  const t = (label: string, modelNumber: string, extra: Record<string, unknown> = {}) => ({
    id: `avail-biamp-${modelNumber}`, label, manufacturer: "Biamp", modelNumber, deviceType: "speaker", category: "Audio Products / Speakers",
    _avail: { status: "awaiting-ports" }, ports: [], ...extra,
  });

  it("allows any level, requires shape, names, unique part numbers and the index", () => {
    const ok = checkCatalog([entry("biamp/biamp-parle-n-100.json", t("Biamp Parlé N-100", "910-1"))]);
    expect(ok.ok).toBe(true);
    expect(ok.levels.Biamp).toEqual({ A: 0, B: 0, FIX: 1, noPorts: 1 });

    const bad = checkCatalog(
      [
        entry("biamp/biamp-parl-n-100.json", t("Biamp Parlé N-100", "910-1")),
        entry("biamp/biamp-modena-hub.json", t("Biamp Modena Hub", "910-2", { _avail: undefined })),
        entry("biamp/biamp-x.json", t("Biamp X", "910-2", { id: "other" })),
      ],
      { templates: [{ file: "biamp/biamp-modena-hub.json", id: "wrong" }] },
    );
    expect(bad.ok).toBe(false);
    expect(bad.files[0].problems).toEqual(["file name must be biamp/biamp-parle-n-100.json"]);
    expect(bad.files[1].problems).toEqual(["no _avail"]);
    expect(bad.problems).toEqual(
      expect.arrayContaining([
        "biamp/biamp-x.json: same manufacturer + model as biamp/biamp-modena-hub.json",
        "biamp/biamp-parl-n-100.json: not in index.json",
        "biamp/biamp-modena-hub.json: id differs from index.json (wrong)",
      ]),
    );
  });

  it("a label whose slug collides takes the part number in the file name", () => {
    const r = checkCatalog([entry("biamp/biamp-modena-hub-920-01737-00002.json", t("Biamp Modena Hub+", "920-01737-00002"))]);
    expect(r.files[0].problems).toEqual([]);
  });

  it("the repository catalog is well-formed", () => {
    const root = fileURLToPath(new URL("../../library/catalog/", import.meta.url));
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        readdirSync(path.join(root, d.name))
          .filter((f) => f.endsWith(".json"))
          .map((f) => ({ file: `${d.name}/${f}`, template: JSON.parse(readFileSync(path.join(root, d.name, f), "utf8")) as unknown })),
      );
    const r = checkCatalog(entries, JSON.parse(readFileSync(path.join(root, "index.json"), "utf8")));
    expect([...r.problems, ...r.files.flatMap((f) => f.problems.map((p) => `${f.file}: ${p}`))]).toEqual([]);
    expect(entries.length).toBeGreaterThan(1700);
  });
});
