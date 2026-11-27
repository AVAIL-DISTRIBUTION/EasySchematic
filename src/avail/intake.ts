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
 * Kits (sheet Kits and the TX/RX pair rule, kitsOfIntake): a kit is sold under its own part number
 * and consists of components that are blocks of their own (a matrix and its receivers, an extender's
 * TX and RX). The kits go to docs/avail/kits.json; each component card gets _avail.kit.kitPartNumbers.
 * Alt part number stays for an alternative part number of the same device: a kit part number there
 * (the TX/RX rows of an extender kit) moves to the kit.
 *
 * Prices (MSRP) are not imported: the repository is public.
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
import { isPriceKey } from "./prices";
import { INTAKE_LIFECYCLES, isLifecycleDate, normalizeLifecycleDate } from "./lifecycle";
import { canonicalFamily } from "./slotFamilies";

/** Columns of the Products sheet, in template order; `*` marks the required ones. */
export const INTAKE_COLUMNS = [
  "Vendor *", "Category *", "Device type *", "Model *", "Part number *", "Alt part number", "Variant", "Short name",
  "Input voltage", "Power draw (W)", "PoE draw (W)", "PoE budget (W)", "Heat (BTU/h)", "Height (mm)", "Width (mm)",
  "Depth (mm)", "Weight (kg)", "Rack form", "Slot families (chassis)", "Card for slot families", "Reference URL *",
  "Datasheet URL", "Description", "Source *", "Note", "Lifecycle", "Lifecycle date",
] as const;

type Column = (typeof INTAKE_COLUMNS)[number] extends `${infer N} *` | infer N ? N : never;
const name = (c: string) => c.replace(/\s*\*$/, "").trim();
export const REQUIRED_COLUMNS = INTAKE_COLUMNS.filter((c) => c.endsWith("*")).map(name);

/**
 * Review columns a reviewed form may add after the template's columns: Decision (Keep / Exclude /
 * Check), Reason and Data gaps (the reviewer's notes, not imported). With a Decision column only Keep rows are imported; Exclude rows are skipped
 * (counted with their reasons in the report); a Check row — or an empty or unknown decision — stops
 * the import: the review is not finished. Without a Decision column every row is imported.
 */
export const REVIEW_COLUMNS = ["Decision", "Reason", "Data gaps"] as const;
export const DECISIONS = ["Keep", "Exclude", "Check"] as const;
export type Decision = (typeof DECISIONS)[number];

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
  /** Problems with the sheet itself (missing required columns, unresolved review): nothing is imported. */
  fatal: string[];
  rows: (IntakeRowReport & { values: IntakeRow; example: boolean })[];
  /** Rows the review excluded (Decision = Exclude): not validated, not imported. */
  excluded: { row: number; partNumber: string; reason: string }[];
  /** Rows the review has not decided yet (Decision = Check, empty or unknown): the import stops. */
  unresolved: { row: number; partNumber: string; decision: string; reason: string }[];
  /** Price columns of an older form (MSRP (USD)…): accepted and ignored — no prices in the public repository. */
  ignored?: string[];
  /** Rows with a value in an ignored price column. */
  pricedRows?: number;
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
  const none = { rows: [], excluded: [], unresolved: [] };
  if (headerAt < 0) return { fatal: ["the Products sheet is empty"], ...none };
  const header = sheet[headerAt].map(name);
  const fatal = REQUIRED_COLUMNS.filter((c) => !header.includes(c)).map((c) => `required column "${c}" is missing`);
  const ignored = header.filter((h) => h && isPriceKey(h));
  const known = [...INTAKE_COLUMNS.map(name), ...REVIEW_COLUMNS] as string[];
  const unknown = header.filter((h) => h && !ignored.includes(h) && !known.includes(h));
  if (unknown.length) fatal.push(`unknown columns: ${unknown.join(", ")} (use the template avail-intake-template.xlsx)`);
  if (fatal.length) return { fatal, ...none };

  const rows: IntakeValidation["rows"] = [];
  const excluded: IntakeValidation["excluded"] = [];
  const unresolved: IntakeValidation["unresolved"] = [];
  const decisionAt = header.indexOf("Decision");
  const reasonAt = header.indexOf("Reason");
  const seen = new Map<string, number>();
  let pricedRows = 0;
  sheet.slice(headerAt + 1).forEach((cells, i) => {
    if (!cells.some((c) => c && c.trim())) return;
    const v: IntakeRow = {};
    header.forEach((h, k) => {
      const x = (cells[k] ?? "").trim();
      if (h && x && !ignored.includes(h) && !(REVIEW_COLUMNS as readonly string[]).includes(h)) v[h as Column] = x;
    });
    const rowNo = headerAt + i + 2;
    if (ignored.length && ignored.some((h) => (cells[header.indexOf(h)] ?? "").trim())) pricedRows++;
    if (decisionAt >= 0 && !EXAMPLE_NOTE_RE.test(v.Note ?? "")) {
      const raw = (cells[decisionAt] ?? "").trim();
      const decision = DECISIONS.find((d) => d.toLowerCase() === raw.toLowerCase());
      const reason = reasonAt >= 0 ? (cells[reasonAt] ?? "").trim() : "";
      const partNumber = v["Part number"] ?? "";
      if (decision === "Exclude") return void excluded.push({ row: rowNo, partNumber, reason });
      if (decision !== "Keep") return void unresolved.push({ row: rowNo, partNumber, decision: raw, reason });
    }
    const errors: string[] = [];
    const warnings: string[] = [];
    const example = EXAMPLE_NOTE_RE.test(v.Note ?? "");
    const pn = v["Part number"] ?? "";

    for (const c of REQUIRED_COLUMNS) {
      if (v[c as Column]) continue;
      // A reviewed form (Decision Keep) may keep a product without a manufacturer page: the reviewer saw it.
      if (c === "Reference URL" && decisionAt >= 0) warnings.push("Reference URL is empty (kept by the review): the card has no referenceUrl, at most level B");
      else errors.push(`${c} is empty`);
    }

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
    // Lifecycle: Active / Upcoming / EoL; the date is when an upcoming product ships or an EoL one ended.
    const lc = v.Lifecycle ? INTAKE_LIFECYCLES[v.Lifecycle] : undefined;
    if (v.Lifecycle && !lc) errors.push(`Lifecycle "${v.Lifecycle}" is not in the list`);
    const lcDate = v["Lifecycle date"];
    if (lcDate && !isLifecycleDate(normalizeLifecycleDate(lcDate))) errors.push(`Lifecycle date "${lcDate}" must be 2027, 2027-Q3, 2027-09 or 2027-09-15`);
    else if (lcDate && lc !== "upcoming" && lc !== "eol") errors.push("Lifecycle date is only for Upcoming (available from) or EoL (end of life)");
    if (lc === "upcoming" && !lcDate) warnings.push("Lifecycle Upcoming without Lifecycle date: when does it ship?");

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
    if (missingDims.length && rack && v["Rack form"] !== "Non-rack" && decisionAt >= 0) {
      // A reviewed form keeps such a row (the reviewer saw the gap): the card waits for the data at level B.
      warnings.push(`${missingDims.join(", ")} empty: required for rack form "${v["Rack form"]}" (kept by the review: level B until filled)`);
    } else if (missingDims.length && rack && v["Rack form"] !== "Non-rack") {
      errors.push(`${missingDims.join(", ")} empty: required for rack form "${v["Rack form"]}"`);
    } else if (missingDims.length && !v["Rack form"] && !isRoomMounted({ category: v.Category, deviceType: v["Device type"] })) {
      warnings.push(`${missingDims.join(", ")} empty: required for anything that can go into a cabinet (set Rack form "Non-rack" if it is room-mounted)`);
    }

    // Power: PoE devices need PoE draw, mains/DC devices power draw.
    const volt = v["Input voltage"] ?? "";
    if (/poe/i.test(volt) && !v["PoE draw (W)"]) warnings.push(`Input voltage "${volt}" is PoE but PoE draw (W) is empty`);
    if (volt && !/poe/i.test(volt) && !v["Power draw (W)"]) warnings.push("Power draw (W) is empty");

    // A model starting with another spelling of the vendor ("WyreStorm …") is renamed silently (report total).
    if (v.Model && vendor && canonicalModel(v.Model, vendor.name) === `${vendor.name} ${v.Model}`) {
      warnings.push(`Model does not start with the vendor: "${vendor.name} ${v.Model}" will be used`);
    }
    if (!v["Datasheet URL"]) warnings.push("Datasheet URL is empty: ports are read from it later");
    if (v["Device type"] === "expansion-card" && !v["Card for slot families"]) warnings.push('expansion-card without "Card for slot families"');
    for (const f of [...list(v["Slot families (chassis)"]), ...list(v["Card for slot families"])]) {
      if (!SLOT_FAMILIES.has(f)) warnings.push(`slot family "${f}" is not in docs/avail/slot-families.json`);
    }
    rows.push({ row: rowNo, partNumber: pn, errors, warnings, values: v, example });
  });
  if (unresolved.length) {
    fatal.push(`${unresolved.length} rows are not decided (Decision must be Keep or Exclude; Check means the review is not finished)`);
  }
  return { fatal, rows, excluded, unresolved, ...(ignored.length ? { ignored, pricedRows } : {}) };
}

/** Catalog id of a part number: "avail-extron-60-1572-15". */
export function intakeId(vendor: string, partNumber: string): string {
  return `avail-${slug(vendor)}-${slug(partNumber)}`;
}

/**
 * The model name with the canonical vendor name first: "WyreStorm EX-70-H2L" → "Wyrestorm EX-70-H2L"
 * (a vendor alias or another spelling at the start is replaced), "EX-70-H2L" → "Wyrestorm EX-70-H2L".
 */
export function canonicalModel(model: string, vendor: string): string {
  const v = findVendor(vendor);
  const names = [vendor, ...(v?.aliases ?? [])].sort((a, b) => b.length - a.length);
  const m = model.trim();
  for (const n of names) {
    if (m.toLowerCase() === n.toLowerCase()) return vendor;
    if (m.toLowerCase().startsWith(`${n.toLowerCase()} `)) return `${vendor} ${m.slice(n.length).trim()}`;
  }
  return `${vendor} ${m}`;
}

/**
 * A note without prices: clauses (". " / "; ") that name a price — MSRP, an amount in a currency, "per-unit price
 * not published" — are dropped. The repository is public; the price list stays with the form.
 */
export function withoutPrices(note: string): string {
  const PRICE_RE = /\bMSRP\b|\b\d[\d.,]*\s*(?:USD|EUR|GBP|AED|RUB)\b|(?:\$|€|£)\s?\d|\bprices?\b[^.;]*\bnot published\b/i;
  return note
    .split(/(?<=[.;])\s+(?=[A-Z(])/)
    .filter((c) => !PRICE_RE.test(c))
    .join(" ")
    .replace(/;\s*$/, ".")
    .trim();
}

/** The card a valid row describes (only the fields the row fills). */
export function cardFromRow(v: IntakeRow, intakeFile: string): CatalogTemplate {
  const vendor = findVendor(v.Vendor)!.name;
  const model = canonicalModel(v.Model!, vendor);
  const variant = v.Variant;
  const label = variant ? `${model} (${variant})` : model;
  const shortName = v["Short name"] ?? model.slice(vendor.length).trim();
  const pn = v["Part number"]!;
  const words = [...shortName.toLowerCase().split(/\s+/), ...(variant ? variant.toLowerCase().split(/[\s,]+/) : [])].filter(Boolean);
  const rack = v["Rack form"] ? RACK_FORMS[v["Rack form"]] : undefined;
  // Slot families by their registry name (an alias such as "sfp-plus" → "sfp").
  const cards = [...new Set(list(v["Card for slot families"]).map(canonicalFamily))];
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
    ...(v["Reference URL"] ? { referenceUrl: v["Reference URL"] } : {}),
    searchTerms: [...new Set([pn.toLowerCase(), shortName.toLowerCase(), vendor.toLowerCase(), ...words])],
  } as Record<string, unknown>;
  const num = (col: Column) => (v[col] !== undefined ? parseNumber(v[col]!) : undefined);
  for (const [col, field] of [
    ["Height (mm)", "heightMm"], ["Width (mm)", "widthMm"], ["Depth (mm)", "depthMm"], ["Weight (kg)", "weightKg"],
    ["Power draw (W)", "powerDrawW"],
  ] as [Column, string][]) if (num(col) !== undefined) t[field] = num(col);
  if (v["Input voltage"]) t.voltage = v["Input voltage"];
  for (const [col, field] of [
    ["PoE draw (W)", "poeDrawW"], ["PoE budget (W)", "poeBudgetW"], ["Heat (BTU/h)", "thermalBtuh"],
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
  const chassis = [...new Set(list(v["Slot families (chassis)"]).map(canonicalFamily))];
  if (chassis.length) a.slotFamilies = chassis;
  if (cards.length > 1) a.cardFamilies = cards;
  if (v.Description) a.description = v.Description;
  a.source = v.Source!;
  if (v["Datasheet URL"]) a.datasheetUrl = v["Datasheet URL"];
  const note = v.Note ? withoutPrices(v.Note) : "";
  if (note) a.note = note;
  const lc = v.Lifecycle ? INTAKE_LIFECYCLES[v.Lifecycle] : undefined;
  if (lc) {
    a.lifecycle = lc;
    const date = v["Lifecycle date"] ? normalizeLifecycleDate(v["Lifecycle date"]) : undefined;
    if (date && lc === "upcoming") a.availableFrom = date;
    if (date && lc === "eol") a.eolDate = date;
  }
  a.intakeFile = intakeFile;
  return card;
}

/** Card keys the intake owns (a row may set them on an existing card). */
const CARD_KEYS = [
  "label", "shortName", "manufacturer", "modelNumber", "deviceType", "category", "referenceUrl", "searchTerms", "voltage",
  "powerDrawW", "poeDrawW", "poeBudgetW", "thermalBtuh", "heightMm", "widthMm", "depthMm", "weightKg",
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
      // A lifecycle in the row replaces the card's whole lifecycle (state and date).
      const base = { ...existing._avail };
      if (rowAvail.lifecycle) {
        delete base.availableFrom;
        delete base.eolDate;
      }
      set("_avail", { ...base, ...rowAvail, ...src });
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

// ---------------------------------------------------------------------------- kits

export interface KitComponent {
  partNumber: string;
  qty: number;
}

/** A kit sold under its own part number: its components (each a block of its own) and where that comes from. */
export interface KitDef {
  vendor: string;
  partNumber: string;
  components: KitComponent[];
  source: string;
}

export interface KitsFile {
  about?: string;
  kits: KitDef[];
}

/** Columns of the Kits sheet (the first one names where the kit part number comes from). */
export const KITS_COLUMNS = ["Kit part number (price list)", "Component part number", "Qty", "Source"] as const;
export const PAIR_SOURCE = "TX/RX pair: Alt part number of the …-TX and …-RX rows (Products sheet)";

const TXRX_RE = /^(.*)-(TX|RX)$/i;

/**
 * The kits of an intake form: the Kits sheet (kit part number, component, qty, source) and the TX/RX
 * pair rule — rows "<base>-TX" and "<base>-RX" whose Alt part number is the same kit part number make
 * the kit 1 × TX + 1 × RX. Returns the kits, the kits of each component part number and the rows whose
 * Alt part number is a kit (it moves to the kit), with warnings.
 */
export function kitsOfIntake(
  rows: readonly IntakeRow[],
  kitsSheet: string[][] | undefined,
): { kits: KitDef[]; kitsOf: Map<string, string[]>; altIsKit: Set<string>; warnings: string[] } {
  const warnings: string[] = [];
  const kits = new Map<string, KitDef>();
  const vendorOfPart = new Map(rows.filter((r) => r["Part number"]).map((r) => [r["Part number"]!.toLowerCase(), findVendor(r.Vendor)?.name ?? r.Vendor ?? ""]));
  const formVendor = [...new Set(vendorOfPart.values())].length === 1 ? [...vendorOfPart.values()][0] : "";

  // Kits sheet.
  if (kitsSheet?.length) {
    const headerAt = kitsSheet.findIndex((r) => r.some((c) => c.trim()));
    const header = kitsSheet[headerAt].map((c) => c.trim());
    const col = (prefix: string) => header.findIndex((h) => h.toLowerCase().startsWith(prefix.toLowerCase()));
    const [kitAt, compAt, qtyAt, srcAt] = [col("Kit part number"), col("Component part number"), col("Qty"), col("Source")];
    if (kitAt < 0 || compAt < 0 || qtyAt < 0) warnings.push(`Kits sheet: columns ${KITS_COLUMNS.join(", ")} expected; the sheet is skipped`);
    else {
      kitsSheet.slice(headerAt + 1).forEach((cells, i) => {
        const kit = (cells[kitAt] ?? "").trim();
        const comp = (cells[compAt] ?? "").trim();
        if (!kit || !comp) return; // empty rows and notes under the table
        const qty = Number((cells[qtyAt] ?? "").trim());
        if (!Number.isInteger(qty) || qty < 1) return void warnings.push(`Kits sheet row ${headerAt + i + 2}: Qty "${cells[qtyAt] ?? ""}" is not a whole number ≥ 1`);
        const vendor = vendorOfPart.get(comp.toLowerCase()) ?? formVendor;
        if (!vendorOfPart.has(comp.toLowerCase())) warnings.push(`Kits sheet: component ${comp} of ${kit} is not a row of the Products sheet`);
        const k = kits.get(kit) ?? { vendor, partNumber: kit, components: [], source: (cells[srcAt] ?? "").trim() || "Kits sheet" };
        k.components.push({ partNumber: comp, qty });
        kits.set(kit, k);
      });
    }
  }

  // TX/RX pairs whose Alt part number is the kit.
  const pairs = new Map<string, { tx?: string; rx?: string; vendor: string }>();
  for (const r of rows) {
    const pn = r["Part number"];
    const alt = r["Alt part number"];
    const m = pn ? TXRX_RE.exec(pn) : null;
    if (!pn || !alt || !m || kits.has(alt)) continue;
    const p = pairs.get(alt) ?? { vendor: findVendor(r.Vendor)?.name ?? r.Vendor ?? "" };
    if (m[2].toUpperCase() === "TX") p.tx = pn;
    else p.rx = pn;
    pairs.set(alt, p);
  }
  for (const [kit, p] of pairs) {
    if (!p.tx || !p.rx) {
      warnings.push(`Alt part number ${kit} of ${p.tx ?? p.rx} looks like a kit, but its ${p.tx ? "RX" : "TX"} row is missing: left as Alt part number`);
      continue;
    }
    kits.set(kit, { vendor: p.vendor, partNumber: kit, components: [{ partNumber: p.tx, qty: 1 }, { partNumber: p.rx, qty: 1 }], source: PAIR_SOURCE });
  }

  const kitsOf = new Map<string, string[]>();
  for (const k of kits.values()) for (const c of k.components) kitsOf.set(c.partNumber.toLowerCase(), [...(kitsOf.get(c.partNumber.toLowerCase()) ?? []), k.partNumber]);
  const altIsKit = new Set(rows.filter((r) => r["Part number"] && r["Alt part number"] && kits.has(r["Alt part number"]!)).map((r) => r["Part number"]!.toLowerCase()));
  return { kits: [...kits.values()], kitsOf, altIsKit, warnings };
}

/** docs/avail/kits.json after an import: the form's kits replace those with the same vendor and part number. */
export function mergeKits(file: KitsFile, kits: readonly KitDef[]): KitsFile {
  const key = (k: KitDef) => `${k.vendor}|${k.partNumber}`.toLowerCase();
  const fresh = new Set(kits.map(key));
  const all = [...file.kits.filter((k) => !fresh.has(key(k))), ...kits];
  all.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.partNumber.localeCompare(b.partNumber));
  return { ...(file.about ? { about: file.about } : {}), kits: all };
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
  /** Kits of the form (sheet Kits, TX/RX pairs): for docs/avail/kits.json. */
  kits: KitDef[];
  kitWarnings: string[];
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
export function importIntake(
  sheet: string[][],
  catalog: readonly CatalogFile[],
  index: readonly IntakeIndexEntry[],
  intakeFile: string,
  kitsSheet?: string[][],
): IntakeResult {
  const byId = new Map(catalog.map((f) => [f.template.id, f]));
  const byPart = new Map(catalog.map((f) => [`${f.template.manufacturer}|${f.template.modelNumber.toLowerCase()}`, f]));
  const lookup = (vendor: string, pn: string) => (byId.get(intakeId(vendor, pn)) ?? byPart.get(`${vendor}|${pn.toLowerCase()}`))?.template;
  const validation = validateIntake(sheet, lookup);
  const result: IntakeResult = { ...validation, actions: [], write: [], remove: [], index: [...index], kits: [], kitWarnings: [] };
  if (validation.fatal.length) return result;
  const kitInfo = kitsOfIntake(validation.rows.filter((r) => !r.example).map((r) => r.values), kitsSheet);
  result.kits = kitInfo.kits;
  result.kitWarnings = kitInfo.warnings;

  const taken = new Map(catalog.map((f) => [f.file, f.template.id]));

  for (const r of validation.rows) {
    if (r.example || r.errors.length) continue;
    const card = cardFromRow(r.values, intakeFile);
    // Kits: a kit part number in Alt part number moves to the kit; the component names its kits.
    const pnKey = card.modelNumber.toLowerCase();
    const altKit = kitInfo.altIsKit.has(pnKey) ? card._avail.altPartNumber : undefined;
    if (altKit) delete card._avail.altPartNumber;
    const inKits = kitInfo.kitsOf.get(pnKey);
    if (inKits) card._avail.kit = { kitPartNumbers: inKits };
    const found = byId.get(card.id) ?? byPart.get(`${card.manufacturer}|${card.modelNumber.toLowerCase()}`);
    const next = found ? mergeCard(found.template, card) : card;
    if (altKit && next._avail.altPartNumber === altKit) delete next._avail.altPartNumber;
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
    for (const u of r.unresolved) {
      const what = u.decision ? `Decision "${u.decision}"` : "Decision empty";
      lines.push(`  row ${String(u.row).padEnd(4)} ${u.partNumber || "(no part number)"}: ${what}${u.reason ? ` (${u.reason})` : ""}`);
    }
    lines.push("FAILED: nothing imported");
    return lines.join("\n") + "\n";
  }
  if (r.ignored?.length) {
    lines.push(`Ignored columns (prices are not stored in the repository): ${r.ignored.join(", ")}; filled in ${r.pricedRows ?? 0} rows, not imported`);
  }
  const n = (a: string) => r.actions.filter((x) => x.action === a).length;
  const invalid = r.rows.filter((x) => !x.example && x.errors.length).length;
  const examples = r.rows.filter((x) => x.example).length;
  if (r.excluded.length) {
    lines.push(`Excluded by the review (Decision = Exclude): ${r.excluded.length}`);
    const reasons = new Map<string, number>();
    for (const x of r.excluded) reasons.set(x.reason || "(no reason)", (reasons.get(x.reason || "(no reason)") ?? 0) + 1);
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }
  lines.push(
    `Rows: ${r.rows.length}; created ${n("created")}, updated ${n("updated")}, unchanged ${n("unchanged")}, with errors (not imported) ${invalid}, example rows skipped ${examples}`,
  );
  const real = r.rows.filter((x) => !x.example);
  const renamed = real.filter((x) => x.values.Model && x.values.Vendor && findVendor(x.values.Vendor) && !x.values.Model.startsWith(`${findVendor(x.values.Vendor)!.name} `)).length;
  if (renamed) lines.push(`Model names written with the canonical vendor name: ${renamed}`);
  if (r.kits.length) {
    lines.push("", `Kits (docs/avail/kits.json): ${r.kits.length}`);
    for (const k of r.kits) lines.push(`  ${k.partNumber} = ${k.components.map((c) => `${c.qty} × ${c.partNumber}`).join(" + ")}  [${k.source}]`);
  }
  for (const w of r.kitWarnings) lines.push(`  W ${w}`);
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
export function intakeListsDiff(lists: {
  vendors: string[];
  categories: string[];
  deviceTypes: string[];
  rackForms: string[];
  sources: string[];
  lifecycles: string[];
}): string[] {
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
  cmp("Lifecycle", lists.lifecycles, Object.keys(INTAKE_LIFECYCLES));
  const unknownTypes = lists.deviceTypes.filter((t) => !DEVICE_TYPES.has(t));
  if (unknownTypes.length) out.push(`Device types: not in the reference data: ${unknownTypes.join(", ")}`);
  return out;
}
