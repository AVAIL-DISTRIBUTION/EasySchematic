/**
 * AVAIL reference data: category taxonomy and vendor list.
 *
 * The source of truth is docs/avail/avail-taxonomy.json (categories of our
 * accounting system, Odoo) and docs/avail/avail-vendors.json (vendor portfolio with
 * name aliases). Pure functions, no browser or Node dependencies: used by the block
 * linter (src/avail/blockLint.ts), the editor and the API (api-avail import).
 */
import taxonomyJson from "../../docs/avail/avail-taxonomy.json";
import vendorsJson from "../../docs/avail/avail-vendors.json";

export interface TaxonomyCategory {
  /** Full path, "Group / Leaf"; this is what a template's `category` holds. */
  path: string;
  group: string;
  leaf: boolean;
  /** "odoo" — from the accounting system; "avail" — ours (Other / Generic). */
  source: string;
  /** false — the item never appears as a block on a schematic (BoQ/BoM only). */
  schematic: boolean;
  usage?: string;
  note?: string;
}

export interface Taxonomy {
  version: number;
  categories: TaxonomyCategory[];
  /** deviceType → leaf category path; null = no default category. */
  deviceTypeDefaults: Record<string, string | null>;
}

export interface Vendor {
  /** Canonical name: the only allowed value of `manufacturer`. */
  name: string;
  /** true — the AVAIL portfolio; false — supported vendor outside it (vendor-decisions.json). */
  portfolio: boolean;
  aliases: string[];
  scope?: string;
}

export const TAXONOMY = taxonomyJson as Taxonomy;
export const VENDORS = (vendorsJson as { vendors: Vendor[] }).vendors;

/** Vendor for items that are needed in a project but are not in the AVAIL portfolio. */
export const GENERIC_VENDOR = "Generic";

const categoryByPath = new Map(TAXONOMY.categories.map((c) => [c.path, c]));

/** The taxonomy entry with exactly this path, if any. */
export function findCategory(path: string | null | undefined): TaxonomyCategory | undefined {
  return path ? categoryByPath.get(path) : undefined;
}

/**
 * Default category for a device type, from deviceTypeDefaults. Unknown types and
 * types mapped to null have no category.
 */
export function defaultCategoryFor(deviceType: string | null | undefined): string | null {
  if (!deviceType) return null;
  return Object.prototype.hasOwnProperty.call(TAXONOMY.deviceTypeDefaults, deviceType)
    ? TAXONOMY.deviceTypeDefaults[deviceType]
    : null;
}

/** Case- and spacing-insensitive form used to compare vendor names. */
function vendorKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const vendorByKey = new Map<string, Vendor>();
for (const v of VENDORS) {
  vendorByKey.set(vendorKey(v.name), v);
  for (const a of v.aliases) vendorByKey.set(vendorKey(a), v);
}

/** Our vendor for a manufacturer name or one of its aliases (any case); undefined if not ours. */
export function findVendor(manufacturer: string | null | undefined): Vendor | undefined {
  return manufacturer ? vendorByKey.get(vendorKey(manufacturer)) : undefined;
}

/**
 * Manufacturer as stored in the library: the canonical name for our vendors and
 * their aliases ("Biamp Systems" → "Biamp"), the trimmed original for anyone else.
 */
export function normalizeManufacturer(manufacturer: string | null | undefined): string | undefined {
  if (!manufacturer?.trim()) return undefined;
  return findVendor(manufacturer)?.name ?? manufacturer.trim().replace(/\s+/g, " ");
}
