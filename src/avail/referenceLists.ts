/**
 * Choice from the reference lists in the AVAIL build (Device Editor, bulk Change category):
 * Category — the leaves of docs/avail/avail-taxonomy.json, grouped by their top level, "BoQ only"
 * for schematic=false; Manufacturer — docs/avail/avail-vendors.json (portfolio, supported vendors
 * and Generic), an alias typed in picks the canonical name.
 *
 * A value outside the list is shown as it is with "not in the list"; a new value can only be one
 * of the list (listFieldErrors guards Save to library).
 *
 * Pure functions, no browser or Node dependencies.
 */
import { defaultCategoryFor, findCategory, findVendor, GENERIC_VENDOR, TAXONOMY, VENDORS } from "./library";

export interface PickOption {
  /** What is stored: the category path or the vendor's canonical name. */
  value: string;
  /** What the list shows: the leaf name, the vendor name. */
  label: string;
  /** Heading the option is listed under. */
  group: string;
  /** Short mark next to the label ("BoQ only"). */
  tag?: string;
  /** Muted text after the label (aliases). */
  hint?: string;
  /** Lower-case words the search matches: value, label, aliases. */
  keys: string;
  /** Exact spellings that pick this option (value and aliases, lower case). */
  exact: string[];
}

export const NOT_IN_LIST = "not in the list";
export const BOQ_ONLY = "BoQ only";

const leafName = (path: string, group: string) => (path.startsWith(`${group} / `) ? path.slice(group.length + 3) : path);

/** Leaf categories of the taxonomy, grouped by their top level, in taxonomy order. */
export function categoryOptions(): PickOption[] {
  return TAXONOMY.categories
    .filter((c) => c.leaf)
    .map((c) => ({
      value: c.path,
      label: leafName(c.path, c.group),
      group: c.group,
      ...(c.schematic ? {} : { tag: BOQ_ONLY }),
      keys: c.path.toLowerCase(),
      exact: [c.path.toLowerCase()],
    }));
}

export const VENDOR_GROUPS = { portfolio: "AVAIL portfolio", supported: "Supported vendors", generic: "Generic" } as const;

/** Vendors: the portfolio, then supported vendors outside it, then Generic; aliases are searchable. */
export function vendorOptions(): PickOption[] {
  const group = (v: (typeof VENDORS)[number]) =>
    v.name === GENERIC_VENDOR ? VENDOR_GROUPS.generic : v.portfolio ? VENDOR_GROUPS.portfolio : VENDOR_GROUPS.supported;
  const order = [VENDOR_GROUPS.portfolio, VENDOR_GROUPS.supported, VENDOR_GROUPS.generic];
  return [...VENDORS]
    .sort((a, b) => order.indexOf(group(a)) - order.indexOf(group(b)) || a.name.localeCompare(b.name))
    .map((v) => {
      const aliases = v.aliases.filter((a) => a.toLowerCase() !== v.name.toLowerCase());
      return {
        value: v.name,
        label: v.name,
        group: group(v),
        ...(aliases.length ? { hint: aliases.join(", ") } : {}),
        keys: [v.name, ...v.aliases].join(" ").toLowerCase(),
        exact: [v.name, ...v.aliases].map((a) => a.trim().replace(/\s+/g, " ").toLowerCase()),
      };
    });
}

/** Options whose words contain every word of the query (any order, any case). */
export function filterOptions(options: readonly PickOption[], query: string): PickOption[] {
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (!words.length) return [...options];
  return options.filter((o) => words.every((w) => o.keys.includes(w)));
}

/** The option a typed text names exactly (its value or an alias, any case): "WyreStorm" → Wyrestorm. */
export function exactOption(options: readonly PickOption[], text: string): PickOption | undefined {
  const t = text.trim().replace(/\s+/g, " ").toLowerCase();
  return t ? options.find((o) => o.exact.includes(t)) : undefined;
}

/** Options by group, groups in the order they first appear. */
export function groupOptions(options: readonly PickOption[]): { group: string; options: PickOption[] }[] {
  const out: { group: string; options: PickOption[] }[] = [];
  for (const o of options) {
    const g = out.find((x) => x.group === o.group);
    if (g) g.options.push(o);
    else out.push({ group: o.group, options: [o] });
  }
  return out;
}

export function inList(options: readonly PickOption[], value: string): boolean {
  return options.some((o) => o.value === value);
}

/** True when a category is a leaf of the taxonomy. */
export const isListedCategory = (v: string) => !!findCategory(v)?.leaf;
/** True when a manufacturer is a canonical vendor name (an alias is not: it must be replaced). */
export const isListedVendor = (v: string) => findVendor(v)?.name === v;

/**
 * Category and manufacturer that would be saved with a value outside the lists. A value that was
 * already there (`before`) may stay; an empty value is not this check's business (the linter's).
 */
export function listFieldErrors(
  before: { category?: unknown; manufacturer?: unknown } | null | undefined,
  after: { category?: unknown; manufacturer?: unknown },
): string[] {
  const out: string[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const cat = str(after.category);
  if (cat && !isListedCategory(cat) && cat !== str(before?.category)) out.push(`Category "${cat}" is not in the list: pick a leaf category of the taxonomy`);
  const man = str(after.manufacturer);
  if (man && !isListedVendor(man) && man !== str(before?.manufacturer)) {
    const v = findVendor(man);
    out.push(v ? `Manufacturer "${man}" is an alias: pick "${v.name}"` : `Manufacturer "${man}" is not in the list: pick a vendor (outside the list use Generic)`);
  }
  return out;
}

/**
 * The category the Device Editor fills in when a device type is picked and the category is empty:
 * in the AVAIL build the taxonomy default for the type (deviceTypeDefaults), never upstream's
 * own category names, which are not in the list.
 */
export function categoryForDeviceType(deviceType: string, upstreamCategory: string | undefined, avail: boolean): string | undefined {
  if (!avail) return upstreamCategory;
  const c = defaultCategoryFor(deviceType);
  return c && isListedCategory(c) ? c : undefined;
}
