/**
 * The intake template (tools/avail/intake/avail-intake-template.xlsx) is the format's source of
 * truth: its Products header must be INTAKE_COLUMNS and its Lists sheet must match the reference
 * data (src/avail/intake.ts, docs/avail/intake.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importIntake, INTAKE_COLUMNS, intakeListsDiff, KITS_COLUMNS, kitsOfIntake, validateIntake } from "../../src/avail/intake";
import { readXlsx } from "../src/xlsx";

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tools/avail/intake/avail-intake-template.xlsx");
const sheets = readXlsx(readFileSync(template));

describe("intake template", () => {
  it("has the Products columns of the format, in order", () => {
    expect(sheets.get("Products")![0]).toEqual([...INTAKE_COLUMNS]);
  });

  it("has a Kits sheet with the columns the import reads, and no kit rows (only notes)", () => {
    const kits = sheets.get("Kits")!;
    expect(kits[0]).toEqual([...KITS_COLUMNS]);
    expect(kitsOfIntake([], kits)).toMatchObject({ kits: [], warnings: [] });
  });

  it("Lists match the reference data (vendors, categories, device types, rack forms, sources, lifecycles)", () => {
    const lists = sheets.get("Lists")!;
    const col = (i: number) => lists.slice(1).map((r) => (r[i] ?? "").trim()).filter(Boolean);
    expect(intakeListsDiff({ vendors: col(0), categories: col(1), deviceTypes: col(3), rackForms: col(4), sources: col(5), lifecycles: col(6) })).toEqual([]);
  });

  it("example rows are recognised and valid", () => {
    const v = validateIntake(sheets.get("Products")!);
    expect(v.fatal).toEqual([]);
    expect(v.rows.length).toBeGreaterThan(0);
    for (const r of v.rows) {
      expect(r.example).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });

  it("has no price column (the repository is public)", () => {
    expect(sheets.get("Products")![0].some((h) => /msrp|price|cost/i.test(h))).toBe(false);
  });

  it("import:intake reads the Kits sheet of a form made from this template", () => {
    const products = sheets.get("Products")!;
    const header = products[0];
    const note = header.indexOf("Note");
    const pnAt = header.indexOf("Part number *");
    const row = [...products[1]];
    row[note] = "";
    const pn = row[pnAt];
    const kits = [sheets.get("Kits")![0], ["KIT-TEST-1", pn, "2", "https://example.com/kit"]];
    const r = importIntake([header, row], [], [], "avail-intake-test.xlsx", kits);
    expect(r.fatal).toEqual([]);
    expect(r.kits).toEqual([expect.objectContaining({ partNumber: "KIT-TEST-1", components: [expect.objectContaining({ partNumber: pn, qty: 2 })] })]);
    expect(r.write[0].template).not.toHaveProperty("unitCost");
  });
});
