/**
 * src/avail/intake.ts — product intake form → catalog cards (docs/avail/intake.md).
 */
import { describe, expect, it } from "vitest";
import type { CatalogFile, CatalogTemplate } from "../avail/catalogPorts";
import { cardFromRow, importIntake, INTAKE_COLUMNS, intakeId, mergeCard, validateIntake, type IntakeIndexEntry } from "../avail/intake";

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
    expect(t).toMatchObject({ heightMm: 44, weightKg: 3.2, powerDrawW: 60, voltage: "100-240V AC", unitCost: 4000, rackForm: "full", slotFamily: "a" });
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
