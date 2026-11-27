/**
 * src/avail/intake.ts — product intake form → catalog cards (docs/avail/intake.md).
 */
import { describe, expect, it } from "vitest";
import type { CatalogFile, CatalogTemplate } from "../avail/catalogPorts";
import {
  canonicalModel,
  cardFromRow,
  formatIntakeReport,
  importIntake,
  INTAKE_COLUMNS,
  intakeId,
  mergeCard,
  mergeKits,
  PAIR_SOURCE,
  validateIntake,
  withoutPrices,
  type IntakeIndexEntry,
} from "../avail/intake";

const HEADER = [...INTAKE_COLUMNS];
type Row = Partial<Record<string, string>>;

/** A sheet: header plus rows given by column name (without " *"). */
function sheet(...rows: Row[]): string[][] {
  const names = HEADER.map((h) => h.replace(/\s*\*$/, ""));
  return [HEADER, ...rows.map((r) => names.map((n) => r[n] ?? ""))];
}

const DSP: Row = {
  Vendor: "Biamp", Category: "Audio Products / DSP", "Device type": "audio-dsp", Model: "Biamp TesiraFORTÉ X 900",
  "Part number": "910-9", "Input voltage": "100-240V AC", "Power draw (W)": "60", "Height (mm)": "44", "Width (mm)": "483",
  "Depth (mm)": "300", "Weight (kg)": "3.2", "Rack form": "1U Full rack", "Reference URL": "https://www.biamp.com/x",
  "Datasheet URL": "https://www.biamp.com/x.pdf", Description: "DSP", "MSRP (USD)": "4000", Source: "Manufacturer datasheet",
};

describe("validateIntake", () => {
  it("accepts a complete row", () => {
    const v = validateIntake(sheet(DSP));
    expect(v.fatal).toEqual([]);
    expect(v.rows[0]).toMatchObject({ row: 2, partNumber: "910-9", errors: [], warnings: [], example: false });
  });

  it("refuses a sheet without a required column or with an unknown one", () => {
    expect(validateIntake([HEADER.filter((h) => h !== "Source *")]).fatal).toEqual(['required column "Source" is missing']);
    expect(validateIntake([[...HEADER, "Colour"]]).fatal[0]).toMatch(/unknown columns: Colour/);
  });

  it("reports values outside the lists, numbers with units, bad links, duplicates", () => {
    const bad = { ...DSP, Vendor: "WyreStorm", Category: "Audio Products", "Device type": "passive-subwoofer", "Rack form": "Half", Source: "Guess", "Power draw (W)": "60 W", "Reference URL": "www.x.com" };
    const v = validateIntake(sheet(bad, DSP, DSP));
    expect(v.rows[0].errors).toEqual([
      'Vendor "WyreStorm" is an alias, use "Wyrestorm"',
      'Category "Audio Products" is not a leaf category of the list',
      'Device type "passive-subwoofer" is an old spelling, use "subwoofer"',
      'Rack form "Half" is not in the list',
      'Source "Guess" is not in the list',
      'Power draw (W): "60 W" is not a number (no units, decimal point)',
      'Reference URL: "www.x.com" is not an http(s) link',
    ]);
    expect(v.rows[2].errors).toEqual(["Part number 910-9 repeats row 3"]);
    expect(validateIntake(sheet({ Vendor: "Biamp" })).rows[0].errors.slice(0, 2)).toEqual(["Category is empty", "Device type is empty"]);
  });

  it("dimensions: error for a rack form, warning for a cabinet device without rack form, none for room-mounted", () => {
    const { "Height (mm)": _h, ...noHeight } = DSP;
    expect(validateIntake(sheet(noHeight)).rows[0].errors).toEqual(['Height (mm) empty: required for rack form "1U Full rack"']);
    const { "Rack form": _r, ...noRack } = noHeight;
    expect(validateIntake(sheet(noRack)).rows[0].warnings[0]).toMatch(/^Height \(mm\) empty: required for anything that can go into a cabinet/);
    const speaker = { Vendor: "Biamp", Category: "Audio Products / Speakers", "Device type": "speaker", Model: "Biamp P6", "Part number": "p6", "Reference URL": "https://b.com", "Datasheet URL": "https://b.com/p.pdf", Source: "Manufacturer site", "Rack form": "Non-rack" };
    expect(validateIntake(sheet(speaker)).rows[0]).toMatchObject({ errors: [], warnings: [] });
    // Updating a card that already has the dimensions: empty cells keep them.
    const existing = (_vendor: string, pn: string) => (pn === "910-9" ? ({ heightMm: 44 } as unknown as CatalogTemplate) : undefined);
    expect(validateIntake(sheet(noHeight), existing).rows[0].errors).toEqual([]);
  });

  it("warns about PoE without a draw, missing data sheet, unknown slot families; skips example rows", () => {
    const poe = { ...DSP, "Input voltage": "PoE 802.3af class 3", "Power draw (W)": "", "Datasheet URL": "", "Slot families (chassis)": "biamp-nope" };
    expect(validateIntake(sheet(poe)).rows[0].warnings).toEqual([
      'Input voltage "PoE 802.3af class 3" is PoE but PoE draw (W) is empty',
      "Datasheet URL is empty: ports are read from it later",
      'slot family "biamp-nope" is not in docs/avail/slot-families.json',
    ]);
    expect(validateIntake(sheet({ ...DSP, Note: "EXAMPLE ROW - delete" })).rows[0].example).toBe(true);
  });
});

describe("cards", () => {
  it("cardFromRow builds a catalog card in catalog key order", () => {
    const t = cardFromRow({ ...DSP, Variant: "Black", "Alt part number": "910-9K", "Card for slot families": "a, b", Note: "n" } as never, "f.xlsx");
    expect(t.id).toBe("avail-biamp-910-9");
    expect(t.label).toBe("Biamp TesiraFORTÉ X 900 (Black)");
    expect(t.shortName).toBe("TesiraFORTÉ X 900");
    expect(t).toMatchObject({ heightMm: 44, weightKg: 3.2, powerDrawW: 60, voltage: "100-240V AC", rackForm: "full", slotFamily: "a" });
    // Prices stay out of the public repository: MSRP (USD) is checked but not written.
    expect(t).not.toHaveProperty("unitCost");
    expect(t._avail).toEqual({
      status: "awaiting-ports", variant: "Black", altPartNumber: "910-9K", rackFormSource: "1U Full rack", rackUnits: 1, cardFamilies: ["a", "b"],
      description: "DSP", source: "Manufacturer datasheet", datasheetUrl: "https://www.biamp.com/x.pdf", note: "n", intakeFile: "f.xlsx",
    });
    expect(Object.keys(t).slice(-2)).toEqual(["_avail", "ports"]);
    expect(intakeId("Netgear-AV", "GSM 4230/PX")).toBe("avail-netgear-av-gsm-4230-px");
    expect(cardFromRow({ ...DSP, Model: "TesiraFORTÉ X 900" } as never, "f").label).toBe("Biamp TesiraFORTÉ X 900");
  });

  it("mergeCard: row values win, empty cells keep, ports and port provenance stay", () => {
    const existing = {
      ...cardFromRow(DSP as never, "old.xlsx"),
      powerDrawW: 50,
      ports: [{ id: "p1" }],
      _avail: { status: "ports-filled", source: "biamp-blocks.csv", portsSource: { kind: "datasheet" as const, from: "u" } },
    } as CatalogTemplate;
    const row: Row = { ...DSP, "Weight (kg)": "3.5" };
    delete row["Power draw (W)"];
    const out = mergeCard(existing, cardFromRow(row as never, "new.xlsx"));
    expect(out).toMatchObject({ powerDrawW: 50, weightKg: 3.5, ports: [{ id: "p1" }] });
    expect(out._avail).toMatchObject({ status: "ports-filled", source: "biamp-blocks.csv", intakeSource: "Manufacturer datasheet", portsSource: { kind: "datasheet" }, intakeFile: "new.xlsx" });
  });
});

describe("importIntake", () => {
  const existing = (): CatalogFile => ({ file: "biamp/biamp-tesiraforte-x-900.json", template: { ...cardFromRow(DSP as never, "a.xlsx"), ports: [{ id: "p1" }] } as CatalogTemplate });
  const index = (f: CatalogFile): IntakeIndexEntry[] => [{ file: f.file, id: f.template.id, label: f.template.label, partNumber: f.template.modelNumber, deviceType: f.template.deviceType, category: String(f.template.category) }];

  it("creates new cards, updates existing ones, skips rows with errors", () => {
    const e = existing();
    const r = importIntake(sheet({ ...DSP, "Weight (kg)": "4" }, { ...DSP, "Part number": "910-10", Model: "Biamp TesiraFORTÉ X 1000" }, { ...DSP, "Part number": "x", Source: "?" }), [e], index(e), "b.xlsx");
    expect(r.actions.map((a) => [a.row, a.action, a.file])).toEqual([
      [2, "updated", "biamp/biamp-tesiraforte-x-900.json"],
      [3, "created", "biamp/biamp-tesiraforte-x-1000.json"],
    ]);
    expect(r.write[0].template).toMatchObject({ weightKg: 4, ports: [{ id: "p1" }] });
    expect(r.index.map((x) => x.id)).toEqual(["avail-biamp-910-9", "avail-biamp-910-10"]);
  });

  it("renames the file when the label changes and keeps two labels with one slug apart", () => {
    const e = existing();
    const r = importIntake(sheet({ ...DSP, Variant: "White" }, { ...DSP, "Part number": "910-11", Model: "Biamp TesiraFORTÉ X 900+", Variant: "White" }), [e], index(e), "b.xlsx");
    expect(r.actions[0]).toMatchObject({ action: "updated", file: "biamp/biamp-tesiraforte-x-900-white.json", renamedFrom: "biamp/biamp-tesiraforte-x-900.json" });
    expect(r.remove).toEqual(["biamp/biamp-tesiraforte-x-900.json"]);
    expect(r.actions[1]).toMatchObject({ action: "created", file: "biamp/biamp-tesiraforte-x-900-white-910-11.json" });
    expect(r.index[0].file).toBe("biamp/biamp-tesiraforte-x-900-white.json");
  });

  it("is idempotent", () => {
    const first = importIntake(sheet(DSP), [], [], "a.xlsx");
    const files = first.write;
    const again = importIntake(sheet(DSP), files, first.index, "a.xlsx");
    expect(again.actions.map((a) => a.action)).toEqual(["unchanged"]);
    expect(again.write).toEqual([]);
  });
});

describe("review decision (Decision / Reason columns)", () => {
  /** A reviewed sheet: the template columns plus Decision and Reason. */
  const reviewed = (...rows: Row[]) => {
    const names = [...HEADER.map((h) => h.replace(/\s*\*$/, "")), "Decision", "Reason"];
    return [[...HEADER, "Decision", "Reason"], ...rows.map((r) => names.map((n) => r[n] ?? ""))];
  };
  const kit = { ...DSP, "Part number": "910-K", Source: "?", Decision: "Exclude", Reason: "kit / bundle" };

  it("imports Keep rows only; Exclude rows are skipped without validation and counted by reason", () => {
    const r = importIntake(reviewed({ ...DSP, Decision: "Keep" }, kit, { ...kit, "Part number": "910-9" }, { ...kit, "Part number": "910-L", Reason: "" }), [], [], "r.xlsx");
    expect(r.fatal).toEqual([]);
    expect(r.rows.map((x) => x.partNumber)).toEqual(["910-9"]);
    expect(r.rows[0].errors).toEqual([]);
    expect(r.excluded).toEqual([
      { row: 3, partNumber: "910-K", reason: "kit / bundle" },
      { row: 4, partNumber: "910-9", reason: "kit / bundle" },
      { row: 5, partNumber: "910-L", reason: "" },
    ]);
    expect(r.actions.map((a) => a.action)).toEqual(["created"]);
    const report = formatIntakeReport(r, "r.xlsx", true);
    expect(report).toContain("Excluded by the review (Decision = Exclude): 3");
    expect(report).toContain("     2  kit / bundle");
    expect(report).toContain("     1  (no reason)");
  });

  it("stops on Check, empty or unknown decisions and lists them; nothing is imported", () => {
    const r = importIntake(
      reviewed({ ...DSP, Decision: "keep" }, { ...kit, Decision: "Check", Reason: "your call" }, { ...kit, "Part number": "910-M", Decision: "" }, { ...kit, "Part number": "910-N", Decision: "Maybe" }),
      [], [], "r.xlsx",
    );
    expect(r.unresolved.map((u) => [u.row, u.partNumber, u.decision])).toEqual([[3, "910-K", "Check"], [4, "910-M", ""], [5, "910-N", "Maybe"]]);
    expect(r.fatal).toEqual(["3 rows are not decided (Decision must be Keep or Exclude; Check means the review is not finished)"]);
    expect(r.write).toEqual([]);
    const report = formatIntakeReport(r, "r.xlsx", false);
    expect(report).toContain('row 3    910-K: Decision "Check" (your call)');
    expect(report).toContain("row 4    910-M: Decision empty");
    expect(report).toContain("FAILED: nothing imported");
  });

  it("without a Decision column every row is imported, as before", () => {
    const r = importIntake(sheet(DSP, { ...DSP, "Part number": "910-10" }), [], [], "a.xlsx");
    expect(r.excluded).toEqual([]);
    expect(r.actions.length).toBe(2);
  });
});

describe("reviewed forms, vendor names, prices", () => {
  const WS: Row = {
    Vendor: "Wyrestorm", Category: "AV distribution / Extenders", "Device type": "hdbaset-extender", Model: "WyreStorm EX-70-H2L-TX",
    "Part number": "EX-70-H2L-TX", "Alt part number": "EX-70-H2L", "Rack form": "Shelf", "Reference URL": "https://www.wyrestorm.com/product/ex-70-h2l/",
    "MSRP (USD)": "500", Source: "Manufacturer site",
  };
  const rev = (...rows: Row[]) => {
    const names = [...HEADER.map((h) => h.replace(/\s*\*$/, "")), "Decision", "Reason", "Data gaps"];
    return [[...HEADER, "Decision", "Reason", "Data gaps"], ...rows.map((r) => names.map((n) => r[n] ?? ""))];
  };

  it("the model starts with the canonical vendor name; MSRP is not written; the report says both", () => {
    const r = importIntake(rev({ ...WS, Decision: "Keep", "Data gaps": "no dimensions" }), [], [], "w.xlsx");
    const t = r.write[0].template;
    expect(t.label).toBe("Wyrestorm EX-70-H2L-TX");
    expect(t).not.toHaveProperty("unitCost");
    const report = formatIntakeReport(r, "w.xlsx", true);
    expect(report).toContain("Model names written with the canonical vendor name: 1");
    expect(report).toContain("MSRP (USD) filled in 1 rows: not imported (the repository is public, prices stay out)");
  });

  it("a reviewed Keep row without Reference URL or rack dimensions is a warning; without a review, an error", () => {
    const { "Reference URL": _u, ...noUrl } = WS;
    const kept = importIntake(rev({ ...noUrl, Decision: "Keep" }), [], [], "w.xlsx");
    expect(kept.rows[0].errors).toEqual([]);
    expect(kept.rows[0].warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Reference URL is empty \(kept by the review\)/), expect.stringMatching(/kept by the review: level B until filled/)]));
    expect(kept.write[0].template).not.toHaveProperty("referenceUrl");
    const plain = validateIntake(sheet(noUrl));
    expect(plain.rows[0].errors).toEqual(["Reference URL is empty", 'Height (mm), Width (mm), Depth (mm), Weight (kg) empty: required for rack form "Shelf"']);
  });
});

describe("kits (sheet Kits, TX/RX pairs)", () => {
  const row = (pn: string, alt?: string): Row => ({
    Vendor: "Wyrestorm", Category: "AV distribution / Extenders", "Device type": "hdbaset-extender", Model: `Wyrestorm ${pn}`, "Part number": pn,
    ...(alt ? { "Alt part number": alt } : {}), "Rack form": "Non-rack", "Reference URL": "https://www.wyrestorm.com/x", Source: "Manufacturer site",
  });
  const KITS = [
    ["Kit part number (price list)", "Component part number", "Qty", "Source"],
    ["MX-0404-KIT", "MX-0404-KIT-MATRIX", "1", "https://example.com/kit.pdf"],
    ["MX-0404-KIT", "MX-KIT-RX", "3", "https://example.com/kit.pdf"],
    ["", "", "", ""],
    ["Extender kits: kit = 1 × TX + 1 × RX (a note under the table)", "", "", ""],
  ];

  it("kits from the sheet and from TX/RX pairs; the kit part number leaves Alt part number; components name their kits", () => {
    const r = importIntake(
      sheet(row("EX-70-H2L-TX", "EX-70-H2L"), row("EX-70-H2L-RX", "EX-70-H2L"), row("MX-0404-KIT-MATRIX", "MX-0404-KIT"), row("MX-KIT-RX"), row("EX-1-TX", "EX-1")),
      [], [], "w.xlsx", KITS,
    );
    expect(r.kits).toEqual([
      { vendor: "Wyrestorm", partNumber: "MX-0404-KIT", components: [{ partNumber: "MX-0404-KIT-MATRIX", qty: 1 }, { partNumber: "MX-KIT-RX", qty: 3 }], source: "https://example.com/kit.pdf" },
      { vendor: "Wyrestorm", partNumber: "EX-70-H2L", components: [{ partNumber: "EX-70-H2L-TX", qty: 1 }, { partNumber: "EX-70-H2L-RX", qty: 1 }], source: PAIR_SOURCE },
    ]);
    const card = (pn: string) => r.write.find((f) => f.template.modelNumber === pn)!.template._avail;
    expect(card("EX-70-H2L-TX")).toMatchObject({ kit: { kitPartNumbers: ["EX-70-H2L"] } });
    expect(card("EX-70-H2L-TX")).not.toHaveProperty("altPartNumber");
    expect(card("MX-0404-KIT-MATRIX")).toMatchObject({ kit: { kitPartNumbers: ["MX-0404-KIT"] } });
    expect(card("MX-0404-KIT-MATRIX")).not.toHaveProperty("altPartNumber");
    expect(card("MX-KIT-RX")).toMatchObject({ kit: { kitPartNumbers: ["MX-0404-KIT"] } });
    // A TX without its RX: the alt part number stays, with a warning.
    expect(card("EX-1-TX")).toMatchObject({ altPartNumber: "EX-1" });
    expect(r.kitWarnings).toEqual(["Alt part number EX-1 of EX-1-TX looks like a kit, but its RX row is missing: left as Alt part number"]);
    expect(formatIntakeReport(r, "w.xlsx", true)).toContain("MX-0404-KIT = 1 × MX-0404-KIT-MATRIX + 3 × MX-KIT-RX");
  });

  it("mergeKits: the form's kits replace those with the same vendor and part number, sorted", () => {
    const old = { about: "x", kits: [{ vendor: "Wyrestorm", partNumber: "EX-70-H2L", components: [], source: "old" }, { vendor: "Biamp", partNumber: "K", components: [], source: "b" }] };
    const next = mergeKits(old, [{ vendor: "Wyrestorm", partNumber: "EX-70-H2L", components: [{ partNumber: "A", qty: 1 }], source: "new" }]);
    expect(next.kits.map((k) => `${k.vendor} ${k.partNumber} ${k.source}`)).toEqual(["Biamp K b", "Wyrestorm EX-70-H2L new"]);
    expect(canonicalModel("WYRESTORM EX-1", "Wyrestorm")).toBe("Wyrestorm EX-1");
    expect(canonicalModel("EX-1", "Wyrestorm")).toBe("Wyrestorm EX-1");
  });
});

describe("withoutPrices", () => {
  it("drops the clauses that name a price, keeps the rest", () => {
    expect(withoutPrices("Split by AVAIL from set EX-70-H2L (TX + RX). Set MSRP 984.4 USD; per-unit price not published. Dimensions published once for the set - applied to both units."))
      .toBe("Split by AVAIL from set EX-70-H2L (TX + RX). Dimensions published once for the set - applied to both units.");
    expect(withoutPrices("Kit MSRP 6352.6 USD; Price list status: New.")).toBe("Price list status: New.");
    expect(withoutPrices("Costs $120 street.")).toBe("");
    expect(withoutPrices("PoE class 1 only published - class maximum 3.84 W used.")).toBe("PoE class 1 only published - class maximum 3.84 W used.");
  });
});
