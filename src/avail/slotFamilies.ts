/**
 * Slot families (standard, "Slots and cards"): a family names the physical slot type, not a
 * card — <vendor>-<platform>-<slot-type> in lower case, one family per physical format.
 * Industry form factors keep their standard name (sfp, qsfp, sd-card, microsd-card, intel-ops).
 *
 * A slot accepts its slotFamily plus the optional slotFamilies list (backward compatible: a
 * template with only slotFamily works as before). The registry docs/avail/slot-families.json
 * holds each family's platform, the category of the chassis and cards that use it, older names
 * (aliases, renamed by the normalizer) and families a slot also accepts (alsoAccepts).
 *
 * Pure functions, no browser or Node dependencies.
 */
import registryJson from "../../docs/avail/slot-families.json";

export interface SlotFamilyInfo {
  name: string;
  vendor: string;
  platform: string;
  /** Category of the chassis and of the cards for this slot type (taxonomy leaf). */
  category?: string | null;
  /** Earlier names of this family; the normalizer renames them. */
  aliases?: string[];
  /** Families a slot of this type also accepts (e.g. Quantum Ultra II takes Quantum Ultra cards). */
  alsoAccepts?: string[];
  note?: string;
}

export const SLOT_FAMILIES = (registryJson as unknown as { families: SlotFamilyInfo[] }).families;

const byName = new Map<string, SlotFamilyInfo>();
const byAlias = new Map<string, SlotFamilyInfo>();
for (const f of SLOT_FAMILIES) {
  byName.set(f.name, f);
  for (const a of f.aliases ?? []) byAlias.set(a.trim().toLowerCase(), f);
}

export function familyInfo(name: string | null | undefined): SlotFamilyInfo | undefined {
  return name ? byName.get(name) : undefined;
}

/** Canonical family for a name in the registry or one of its aliases (any case); otherwise the name itself. */
export function canonicalFamily(name: string): string {
  if (byName.has(name)) return name;
  return byAlias.get(name.trim().toLowerCase())?.name ?? name;
}

/** Families a slot accepts: its slotFamily, then slotFamilies (no duplicates, empty names dropped). */
export function acceptedFamilies(slot: { slotFamily?: string | null; slotFamilies?: readonly string[] | null } | null | undefined): string[] {
  if (!slot) return [];
  const out: string[] = [];
  for (const f of [slot.slotFamily, ...(slot.slotFamilies ?? [])]) {
    if (typeof f === "string" && f.trim() && !out.includes(f)) out.push(f);
  }
  return out;
}

/** true when a card of `cardFamily` fits the slot. */
export function fitsSlot(slot: { slotFamily?: string | null; slotFamilies?: readonly string[] | null }, cardFamily: string | null | undefined): boolean {
  return !!cardFamily && acceptedFamilies(slot).includes(cardFamily);
}

/** What the library holds for slots, for the linter's slot/card checks (standard "Slots and cards"). */
export interface SlotLibraryContext {
  /** Families at least one card template belongs to. */
  familiesWithCards: ReadonlySet<string>;
  /** Families at least one chassis slot accepts (slotFamily, slotFamilies, registry alsoAccepts). */
  familiesWithHosts: ReadonlySet<string>;
}

/** Families a slot accepts, including what the registry says its family also accepts. */
function slotAccepts(slot: { slotFamily?: string | null; slotFamilies?: readonly string[] | null }): string[] {
  const out = acceptedFamilies(slot);
  for (const f of [...out]) for (const a of familyInfo(canonicalFamily(f))?.alsoAccepts ?? []) if (!out.includes(a)) out.push(a);
  return out;
}

export function slotLibraryContext(
  templates: Iterable<{ slotFamily?: string | null; slots?: readonly { slotFamily?: string | null; slotFamilies?: readonly string[] | null }[] | null }>,
): SlotLibraryContext {
  const familiesWithCards = new Set<string>();
  const familiesWithHosts = new Set<string>();
  for (const t of templates) {
    if (t.slotFamily) familiesWithCards.add(t.slotFamily);
    for (const s of t.slots ?? []) for (const f of slotAccepts(s)) familiesWithHosts.add(f);
  }
  return { familiesWithCards, familiesWithHosts };
}

/** Lint messages (W) for a template's slots and card family against the library. */
export function slotLibraryWarnings(
  t: { slotFamily?: unknown; slots?: unknown },
  ctx: SlotLibraryContext,
): string[] {
  const out: string[] = [];
  const empty = new Set<string>();
  for (const s of Array.isArray(t.slots) ? (t.slots as { slotFamily?: string; slotFamilies?: string[] }[]) : []) {
    if (!s || typeof s !== "object" || !s.slotFamily) continue;
    if (!slotAccepts(s).some((f) => ctx.familiesWithCards.has(f))) empty.add(s.slotFamily);
  }
  for (const f of empty) out.push(`slots of family "${f}": no card in the library fits`);
  if (typeof t.slotFamily === "string" && t.slotFamily && !ctx.familiesWithHosts.has(t.slotFamily)) {
    out.push(`card family "${t.slotFamily}": no chassis in the library has this slot`);
  }
  return out;
}
