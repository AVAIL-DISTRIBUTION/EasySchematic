/**
 * Product data intake (step 1.10): the vendor intake form tools/avail/intake/avail-intake-template.xlsx
 * (sheet Products, rules in docs/avail/intake.md) → catalog cards in library/catalog/<vendor>/*.json,
 * the same format as the Extron and Biamp catalog (see src/avail/catalogPorts.ts).
 *
 * validateIntake() checks every row against the rules and the AVAIL reference data (vendors,
 * taxonomy, device types, slot families); importIntake() turns the valid rows into catalog cards:
 * a new card is created with _avail.status "awaiting-ports"; an existing card (same id or same
 * manufacturer + part number) gets the non-empty values of the row — empty cells never erase a
 * value — and keeps its ports, slots and port provenance.
 *
 * Pure functions, no Node or browser dependencies: the CLI (api-avail/src/importIntakeCli.ts) reads
 * the workbook and writes the files.
 */
import slotFamiliesJson from "../../docs/avail/slot-families.json";
import { DEVICE_TYPE_ALIASES, DEVICE_TYPE_TO_CATEGORY } from "../deviceTypeCategories";
import { isRoomMounted } from "./blockLint";
import { AWAITING_PORTS, type CatalogAvail, type CatalogFile, type CatalogTemplate } from "./catalogPorts";
import { findCategory, findVendor, TAXONOMY, VENDORS } from "./library";
import { libraryFileName, slug } from "./libraryFiles";

/** Columns of the Products sheet, in template order; `*` marks the required ones. */
export const INTAKE_COLUMNS = [
  "Vendor *", "Category *", "Device type *", "Model *", "Part number *", "Alt part number", "Variant", "Short name",
  "Input voltage", "Power draw (W)", "PoE draw (W)", "PoE budget (W)", "Heat (BTU/h)", "Height (mm)", "Width (mm)",
  "Depth (mm)", "Weight (kg)", "Rack form", "Slot families (chassis)", "Card for slot families", "Reference URL *",
  "Datasheet URL", "Description", "MSRP (USD)", "Source *", "Note",
] as const;

type Column = (typeof INTAKE_COLUMNS)[number] extends `${infer N} *` | infer N ? N : never;
const name = (c: string) => c.replace(/\s*\*$/, "").trim();
export const REQUIRED_COLUMNS = INTAKE_COLUMNS.filter((c) => c.endsWith("*")).map(name);

/** Rack form values (Lists sheet) → catalog rackForm and rack units. */
export const RACK_FORMS: Record<string, { rackForm?: "full" | "half" | "shelf-only"; rackUnits?: number }> = {
  "Non-rack": {},
  "1U Full rack": { rackForm: "full", rackUnits: 1 },
  "1U 1/2 rack": { rackForm: "half", rackUnits: 1 },
  "1U 1/4 rack": { rackForm: "shelf-only", rackUnits: 1 },
  "1U 1/8 rack": { rackForm: "shelf-only", rackUnits: 1 },
  "2U Full rack": { rackForm: "full", rackUnits: 2 },
  "3U Full rack": { rackForm: "full", rackUnits: 3 },
  "4U Full rack": { rackForm: "full", rackUnits: 4 },
  "5U Full rack": { rackForm: "full", rackUnits: 5 },
  "6U Full rack": { rackForm: "full", rackUnits: 6 },
  "8U Full rack": { rackForm: "full", rackUnits: 8 },
  "10U Full rack": { rackForm: "full", rackUnits: 10 },
  Shelf: { rackForm: "shelf-only" },
};

export const SOURCES = ["Manufacturer site", "Manufacturer datasheet", "Price list", "Distributor site", "Vendor reply", "AVAIL estimate"] as const;

/** Device types the intake accepts: the editor's types and the taxonomy defaults. */
export const DEVICE_TYPES: ReadonlySet<string> = new Set([...Object.keys(DEVICE_TYPE_TO_CATEGORY), ...Object.keys(TAXONOMY.deviceTypeDefaults)]);

const SLOT_FAMILIES = new Set(
  (slotFamiliesJson as { families: { name: string; aliases?: string[] }[] }).families.flatMap((f) => [f.name, ...(f.aliases ?? [])]),
);

/** Numeric columns and the card field each one fills. */
const NUMBERS: [Column, keyof CatalogTemplate & string][] = [
  ["Power draw (W)", "powerDrawW"],
  ["PoE draw (W)", "poeDrawW"],
  ["PoE budget (W)", "poeBudgetW"],
  ["Heat (BTU/h)", "thermalBtuh"],
  ["Height (mm)", "heightMm"],
  ["Width (mm)", "widthMm"],
  ["Depth (mm)", "depthMm"],
  ["Weight (kg)", "weightKg"],
  ["MSRP (USD)", "unitCost"],
];
const DIMENSIONS: Column[] = ["Height (mm)", "Width (mm)", "Depth (mm)", "Weight (kg)"];
export const EXAMPLE_NOTE_RE = /^\s*EXAMPLE ROW\b/i;

export type IntakeRow = Partial<Record<Column, string>>;

export interface IntakeRowReport {
  /** Row number in the sheet (1-based, the header is row 1). */
  row: number;
  partNumber: string;
  errors: string[];
  warnings: string[];
}

export interface IntakeValidation {
  /** Problems with the sheet itself (missing required columns): nothing is imported. */
  fatal: string[];
  rows: (IntakeRowReport & { values: IntakeRow; example: boolean })[];
}

/** A number cell: "12.5" → 12.5; Excel float noise is rounded to 6 decimals. */
function parseNumber(s: string): number | null {
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 1e6) / 1e6;
}

function list(s: string | undefined): string[] {
  return (s ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Reads the Products sheet (rows of cell strings, header first) and checks every row. Rows with
 * errors are not imported; warnings are reported and the row is imported. Example rows (Note
 * "EXAMPLE ROW …") are skipped.
 */
export function validateIntake(sheet: string[][], existing?: (vendor: string, partNumber: string) => CatalogTemplate | undefined): IntakeValidation {
  const headerAt = sheet.findIndex((r) => r.some((c) => c.trim()));
  if (headerAt < 0) return { fatal: ["the Products sheet is empty"], rows: [] };
  const header = sheet[headerAt].map(name);
  const fatal = REQUIRED_COLUMNS.filter((c) => !header.includes(c)).map((c) => `required column "${c}" is missing`);
  const unknown = header.filter((h) => h && !INTAKE_COLUMNS.map(name).includes(h));
  if (unknown.length) fatal.push(`unknown columns: ${unknown.join(", ")} (use the template avail-intake-template.xlsx)`);
  if (fatal.length) return { fatal, rows: [] };

  const rows: IntakeValidation["rows"] = [];
  const seen = new Map<string, number>();
  sheet.slice(headerAt + 1).forEach((cells, i) => {
    if (!cells.some((c) => c && c.trim())) return;
    const v: IntakeRow = {};
    header.forEach((h, k) => {
      const x = (cells[k] ?? "").trim();
      if (h && x) v[h as Column] = x;
    });
    const rowNo = headerAt + i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const example = EXAMPLE_NOTE_RE.test(v.Note ?? "");
    const pn = v["Part number"] ?? "";

    for (const c of REQUIRED_COLUMNS) if (!v[c as Column]) errors.push(`${c} is empty`);

    const vendor = v.Vendor ? findVendor(v.Vendor) : undefined;
    if (v.Vendor && !vendor) errors.push(`Vendor "${v.Vendor}" is not in the vendor list (add it to docs/avail/avail-vendors.json first)`);
    else if (vendor && v.Vendor !== vendor.name) errors.push(`Vendor "${v.Vendor}" is an alias, use "${vendor.name}"`);

    if (v.Category) {
      const c = findCategory(v.Category);
      if (!c || !c.leaf) errors.push(`Category "${v.Category}" is not a leaf category of the list`);
      else if (!c.schematic) warnings.push(`Category "${c.path}" is BoQ-only (not a schematic block): the card will not pass the linter`);
    }
    const alias = v["Device type"] ? DEVICE_TYPE_ALIASES[v["Device type"]] : undefined;
    if (alias) errors.push(`Device type "${v["Device type"]}" is an old spelling, use "${alias}"`);
    else if (v["Device type"] && !DEVICE_TYPES.has(v["Device type"])) errors.push(`Device type "${v["Device type"]}" is not in the list`);
    if (v["Rack form"] && !(v["Rack form"] in RACK_FORMS)) errors.push(`Rack form "${v["Rack form"]}" is not in the list`);
    if (v.Source && !(SOURCES as readonly string[]).includes(v.Source)) errors.push(`Source "${v.Source}" is not in the list`);

    for (const [col] of NUMBERS) {
      const x = v[col];
      if (x === undefined) continue;
      const n = parseNumber(x);
      if (n === null) errors.push(`${col}: "${x}" is not a number (no units, decimal point)`);
      else if (n < 0) errors.push(`${col}: ${n} is negative`);
    }
    for (const col of ["Reference URL", "Datasheet URL"] as const) {
      const x = v[col];
      if (x && !/^https?:\/\/\S+$/i.test(x)) errors.push(`${col}: "${x}" is not an http(s) link`);
    }

    // Uniqueness: one row per manufacturer part number.
    if (pn && vendor) {
      const key = `${vendor.name}|${pn.toLowerCase()}`;
      const prev = seen.get(key);
      if (prev && !example) errors.push(`Part number ${pn} repeats row ${prev}`);
      else if (!example) seen.set(key, rowNo);
    }

    // Dimensions: required for what goes into a cabinet (rack form), else for what is not room-mounted.
    // Updating an existing card: an empty cell keeps the card's value, so that counts too.
    const card = vendor && pn ? existing?.(vendor.name, pn) : undefined;
    const fieldOf = (c: Column) => NUMBERS.find(([col]) => col === c)![1];
    const missingDims = DIMENSIONS.filter((c) => v[c] === undefined && (card?.[fieldOf(c)] ?? null) === null);
    const rack = v["Rack form"] ? RACK_FORMS[v["Rack form"]] : undefined;
    if (missingDims.length && rack && v["Rack form"] !== "Non-rack") {
      errors.push(`${missingDims.join(", ")} empty: required for rack form "${v["Rack form"]}"`);
    } else if (missingDims.length && !v["Rack form"] && !isRoomMounted({ category: v.Category, deviceType: v["Device type"] })) {
      warnings.push(`${missingDims.join(", ")} empty: required for anything that can go into a cabinet (set Rack form "Non-rack" if it is room-mounted)`);
    }

    // Power: PoE devices need PoE draw, mains/DC devices power draw.
    const volt = v["Input voltage"] ?? "";
    if (/poe/i.test(volt) && !v["PoE draw (W)"]) warnings.push(`Input voltage "${volt}" is PoE but PoE draw (W) is empty`);
    if (volt && !/poe/i.test(volt) && !v["Power draw (W)"]) warnings.push("Power draw (W) is empty");

    if (v.Model && vendor && !v.Model.toLowerCase().startsWith(vendor.name.toLowerCase())) {
      warnings.push(`Model does not start with the vendor: "${vendor.name} ${v.Model}" will be used`);
    }
    if (!v["Datasheet URL"]) warnings.push("Datasheet URL is empty: ports are read from it later");
    if (v["Device type"] === "expansion-card" && !v["Card for slot families"]) warnings.push('expansion-card without "Card for slot families"');
    for (const f of [...list(v["Slot families (chassis)"]), ...list(v["Card for slot families"])]) {
      if (!SLOT_FAMILIES.has(f)) warnings.push(`slot family "${f}" is not in docs/avail/slot-families.json`);
    }
    rows.push({ row: rowNo, partNumber: pn, errors, warnings, values: v, example });
  });
  return { fatal, rows };
}

/** Catalog id of a part number: "avail-extron-60-1572-15". */
export function intakeId(vendor: string, partNumber: string): string {
  return `avail-${slug(vendor)}-${slug(partNumber)}`;
}

/** The card a valid row describes (only the fields the row fills). */
export function cardFromRow(v: IntakeRow, intakeFile: string): CatalogTemplate {
  const vendor = findVendor(v.Vendor)!.name;
  const model = v.Model!.toLowerCase().startsWith(vendor.toLowerCase()) ? v.Model! : `${vendor} ${v.Model}`;
  const variant = v.Variant;
  const label = variant ? `${model} (${variant})` : model;
  const shortName = v["Short name"] ?? model.slice(vendor.length).trim();
  const pn = v["Part number"]!;
  const words = [...shortName.toLowerCase().split(/\s+/), ...(variant ? variant.toLowerCase().split(/[\s,]+/) : [])].filter(Boolean);
  const rack = v["Rack form"] ? RACK_FORMS[v["Rack form"]] : undefined;
  const cards = list(v["Card for slot families"]);
  // Key order of the catalog files: card, then _avail, then ports.
  const t = {
    id: intakeId(vendor, pn),
    label,
    shortName,
    manufacturer: vendor,
    modelNumber: pn,
    deviceType: v["Device type"]!,
    category: v.Category!,
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    referenceUrl: v["Reference URL"]!,
    searchTerms: [...new Set([pn.toLowerCase(), shortName.toLowerCase(), vendor.toLowerCase(), ...words])],
  } as Record<string, unknown>;
  const num = (col: Column) => (v[col] !== undefined ? parseNumber(v[col]!) : undefined);
  for (const [col, field] of [
    ["Height (mm)", "heightMm"], ["Width (mm)", "widthMm"], ["Depth (mm)", "depthMm"], ["Weight (kg)", "weightKg"],
    ["Power draw (W)", "powerDrawW"],
  ] as [Column, string][]) if (num(col) !== undefined) t[field] = num(col);
  if (v["Input voltage"]) t.voltage = v["Input voltage"];
  for (const [col, field] of [
    ["PoE draw (W)", "poeDrawW"], ["PoE budget (W)", "poeBudgetW"], ["Heat (BTU/h)", "thermalBtuh"], ["MSRP (USD)", "unitCost"],
  ] as [Column, string][]) if (num(col) !== undefined) t[field] = num(col);
  if (rack?.rackForm) t.rackForm = rack.rackForm;
  if (cards.length) t.slotFamily = cards[0];
  t._avail = { status: AWAITING_PORTS };
  t.ports = [];
  const card = t as CatalogTemplate;

  const a: CatalogAvail = card._avail;
  if (variant) a.variant = variant;
  if (v["Alt part number"]) a.altPartNumber = v["Alt part number"];
  if (v["Rack form"]) a.rackFormSource = v["Rack form"];
  if (rack?.rackUnits) a.rackUnits = rack.rackUnits;
  const chassis = list(v["Slot families (chassis)"]);
  if (chassis.length) a.slotFamilies = chassis;
  if (cards.length > 1) a.cardFamilies = cards;
  if (v.Description) a.description = v.Description;
  a.source = v.Source!;
  if (v["Datasheet URL"]) a.datasheetUrl = v["Datasheet URL"];
  if (v.Note) a.note = v.Note;
  a.intakeFile = intakeFile;
  return card;
}

/** Card keys the intake owns (a row may set them on an existing card). */
const CARD_KEYS = [
  "label", "shortName", "manufacturer", "modelNumber", "deviceType", "category", "referenceUrl", "searchTerms", "voltage",
  "powerDrawW", "poeDrawW", "poeBudgetW", "thermalBtuh", "heightMm", "widthMm", "depthMm", "weightKg", "unitCost",
  "rackForm", "slotFamily",
] as const;

/**
 * Merges a row's card into an existing catalog card: non-empty values of the row win, everything
 * else stays (ports, slots, _avail.portsSource / portsMissing / status of a card with ports). An
 * existing _avail.source stays; the intake's Source then goes to _avail.intakeSource.
 * Key order of the existing card is kept; new keys go before _avail.
 */
export function mergeCard(existing: CatalogTemplate, row: CatalogTemplate): CatalogTemplate {
  const out: Record<string, unknown> = {};
  const set = (k: string, val: unknown) => {
    out[k] = val;
  };
  for (const [k, val] of Object.entries(existing)) {
    if (k === "_avail") {
      for (const key of CARD_KEYS) if (!(key in existing) && row[key] !== undefined) set(key, row[key]);
      const { status: _s, source, ...rowAvail } = row._avail;
      // The card keeps where it first came from; the intake's source is recorded next to it.
      const prev = existing._avail?.source;
      const src = prev && prev !== source ? { intakeSource: source } : { source };
      set("_avail", { ...existing._avail, ...rowAvail, ...src });
    } else if ((CARD_KEYS as readonly string[]).includes(k) && row[k] !== undefined) set(k, row[k]);
    else set(k, val);
  }
  if (!("_avail" in existing)) set("_avail", row._avail);
  // A card without ports or slots is still awaiting them.
  const t = out as CatalogTemplate;
  const hasPorts = (t.ports?.length ?? 0) > 0 || (Array.isArray(t.slots) && t.slots.length > 0);
  if (!hasPorts) t._avail.status = AWAITING_PORTS;
  return t;
}

export interface IntakeIndexEntry {
  file: string;
  id: string;
  label: string;
  partNumber: string;
  deviceType: string;
  category: string;
}

export interface IntakeResult extends IntakeValidation {
  /** Per valid row: what happens to its card. */
  actions: { row: number; partNumber: string; file: string; action: "created" | "updated" | "unchanged"; renamedFrom?: string }[];
  /** Files to write (new content) and to delete (a card renamed because its label changed). */
  write: CatalogFile[];
  remove: string[];
  /** index.json entries after the import, in catalog order (new cards appended). */
  index: IntakeIndexEntry[];
}

const indexEntry = (file: string, t: CatalogTemplate): IntakeIndexEntry => ({
  file,
  id: t.id,
  label: t.label,
  partNumber: t.modelNumber,
  deviceType: t.deviceType,
  category: String(t.category ?? ""),
});

/**
 * Validates the sheet and turns its valid rows into catalog changes against the current catalog
 * (files and index.json entries). Nothing is written here.
 */
export function importIntake(sheet: string[][], catalog: readonly CatalogFile[], index: readonly IntakeIndexEntry[], intakeFile: string): IntakeResult {
  const byId = new Map(catalog.map((f) => [f.template.id, f]));
  const byPart = new Map(catalog.map((f) => [`${f.template.manufacturer}|${f.template.modelNumber.toLowerCase()}`, f]));
  const lookup = (vendor: string, pn: string) => (byId.get(intakeId(vendor, pn)) ?? byPart.get(`${vendor}|${pn.toLowerCase()}`))?.template;
  const validation = validateIntake(sheet, lookup);
  const result: IntakeResult = { ...validation, actions: [], write: [], remove: [], index: [...index] };
  if (validation.fatal.length) return result;

  const taken = new Map(catalog.map((f) => [f.file, f.template.id]));

  for (const r of validation.rows) {
    if (r.example || r.errors.length) continue;
    const card = cardFromRow(r.values, intakeFile);
    const found = byId.get(card.id) ?? byPart.get(`${card.manufacturer}|${card.modelNumber.toLowerCase()}`);
    const next = found ? mergeCard(found.template, card) : card;
    // File name: slug of the label; the part number tells two labels with one slug apart.
    const vendorDir = slug(next.manufacturer);
    let file = `${vendorDir}/${libraryFileName(next)}`;
    if (taken.has(file) && taken.get(file) !== next.id) file = file.replace(/\.json$/, `-${slug(next.modelNumber)}.json`);
    if (found && JSON.stringify(found.template) === JSON.stringify(next) && found.file === file) {
      result.actions.push({ row: r.row, partNumber: r.partNumber, file, action: "unchanged" });
      continue;
    }
    if (found && found.file !== file) {
      result.remove.push(found.file);
      taken.delete(found.file);
    }
    taken.set(file, next.id);
    const updated: CatalogFile = { file, template: next };
    result.write.push(updated);
    byId.set(next.id, updated);
    byPart.set(`${next.manufacturer}|${next.modelNumber.toLowerCase()}`, updated);
    const at = result.index.findIndex((e) => e.id === next.id || (found && e.file === found.file));
    if (at >= 0) result.index[at] = indexEntry(file, next);
    else result.index.push(indexEntry(file, next));
    result.actions.push({
      row: r.row,
      partNumber: r.partNumber,
      file,
      action: found ? "updated" : "created",
      ...(found && found.file !== file ? { renamedFrom: found.file } : {}),
    });
  }
  return result;
}

export function formatIntakeReport(r: IntakeResult, intakeFile: string, dryRun: boolean): string {
  const lines = [`Intake: ${intakeFile}${dryRun ? " (dry run, nothing written)" : ""}`];
  if (r.fatal.length) {
    for (const f of r.fatal) lines.push(`! ${f}`);
    lines.push("FAILED: nothing imported");
    return lines.join("\n") + "\n";
  }
  const n = (a: string) => r.actions.filter((x) => x.action === a).length;
  const invalid = r.rows.filter((x) => !x.example && x.errors.length).length;
  const examples = r.rows.filter((x) => x.example).length;
  lines.push(
    `Rows: ${r.rows.length}; created ${n("created")}, updated ${n("updated")}, unchanged ${n("unchanged")}, with errors (not imported) ${invalid}, example rows skipped ${examples}`,
  );
  const issues = r.rows.filter((x) => !x.example && (x.errors.length || x.warnings.length));
  if (issues.length) lines.push("", "Rows with errors (E, not imported) and warnings (W):");
  for (const x of issues) {
    lines.push(`  row ${x.row} ${x.partNumber || "(no part number)"}`);
    for (const e of x.errors) lines.push(`      E ${e}`);
    for (const w of x.warnings) lines.push(`      W ${w}`);
  }
  const changed = r.actions.filter((x) => x.action !== "unchanged");
  if (changed.length) lines.push("", "Cards:");
  for (const a of changed) lines.push(`  ${a.action.padEnd(8)} row ${String(a.row).padEnd(4)} ${a.file}${a.renamedFrom ? ` (renamed from ${a.renamedFrom})` : ""}`);
  lines.push("", invalid ? `Rows with errors stay out of the catalog: fix them and run again.` : "OK: every row is in the catalog");
  return lines.join("\n") + "\n";
}

/** The Lists sheet of the template must match the reference data (vendors, categories, device types). */
export function intakeListsDiff(lists: { vendors: string[]; categories: string[]; deviceTypes: string[]; rackForms: string[]; sources: string[] }): string[] {
  const out: string[] = [];
  const cmp = (what: string, got: string[], want: string[]) => {
    const g = new Set(got);
    const w = new Set(want);
    const missing = want.filter((x) => !g.has(x));
    const extra = got.filter((x) => !w.has(x));
    if (missing.length) out.push(`${what}: missing in the template: ${missing.join(", ")}`);
    if (extra.length) out.push(`${what}: not in the reference data: ${extra.join(", ")}`);
  };
  cmp("Vendors", lists.vendors, VENDORS.map((v) => v.name));
  cmp("Categories", lists.categories, TAXONOMY.categories.filter((c) => c.leaf).map((c) => c.path));
  cmp("Rack form", lists.rackForms, Object.keys(RACK_FORMS));
  cmp("Source", lists.sources, [...SOURCES]);
  const unknownTypes = lists.deviceTypes.filter((t) => !DEVICE_TYPES.has(t));
  if (unknownTypes.length) out.push(`Device types: not in the reference data: ${unknownTypes.join(", ")}`);
  return out;
}
