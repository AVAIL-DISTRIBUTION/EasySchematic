/**
 * Duplicate control (step 2.4): templates that are probably the same product.
 *
 * Two templates are a duplicate pair when, and both are not hidden,
 *   (a) they have the same manufacturer and the same modelNumber, or
 *   (b) they have the same normalized model: the label without the manufacturer (and its aliases
 *       and abbreviations: "A&H" for Allen & Heath), without punctuation and case, without the
 *       variant words (colour, MM / SM, region, LinkLicense …);
 * and their variant is the same. Templates that differ only by the variant ("Black" / "White",
 * "MM" / "SM", the catalog's variant field) are variants, not duplicates.
 *
 * Groups join pairs transitively. Each group proposes a primary block: verified > draft > raw;
 * catalog / curated library > community; ports from a manufacturer document > database > none;
 * then level, then more ports. Pure: the CLI, the server (409 on save) and the workspace use it.
 *
 * A librarian may decide that two templates are not duplicates (step 2.4, "Not duplicates"): such
 * a pair (pairKey) is never joined, and findDuplicate does not answer with it. Other pairs of the
 * same templates still count, so a group stays together through a third template.
 */
import { findVendor } from "./library";

export type DupStatus = "verified" | "draft" | "raw" | "hidden";

export interface DupCandidate {
  id: string;
  label: string;
  manufacturer: string;
  modelNumber: string;
  status: DupStatus;
  /** Meta source: avail-catalog, avail-library, easyschematic.live… */
  source: string | null;
  portsOrigin: "manufacturer" | "community" | "none";
  level: "A" | "B" | "FIX" | null;
  ports: number;
  /** The catalog's variant field ("Black", "Black, MM"), when the template came from the catalog. */
  variant?: string | null;
}

export interface DupGroup {
  /** The proposed primary's id: the group's key. */
  primary: string;
  members: DupCandidate[];
  /** Why the group exists: "same part number", "same model". */
  reasons: ("same part number" | "same model")[];
}

/** Words that name a variant of the same product, not another product. */
const VARIANT_WORDS = new Set([
  "black", "white", "grey", "gray", "silver", "aluminum", "aluminium", "brushed", "bronze",
  "mm", "sm", "multimode", "singlemode",
  "us", "uk", "eu", "aus", "au", "nz", "fr", "cn", "jp", "sw", "dk", "br", "kr", "za", "multi", "multiregion",
  "linklicense", "ll", "standard",
]);

/** Abbreviations of manufacturers that are not in avail-vendors.json aliases. */
const ABBREVIATIONS: Readonly<Record<string, string[]>> = {
  "allen & heath": ["a&h", "ah"],
  "audio-technica": ["at"],
  "bose professional": ["bose"],
};

const norm = (s: unknown) =>
  (typeof s === "string" ? s : "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Names a manufacturer goes by: its name, aliases, abbreviations (lower case). */
export function manufacturerNames(manufacturer: string): string[] {
  const v = findVendor(manufacturer);
  const names = [manufacturer, ...(v ? [v.name, ...v.aliases] : [])].map(norm).filter(Boolean);
  for (const n of [...names]) names.push(...(ABBREVIATIONS[n] ?? []));
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

/** Manufacturer key: the canonical vendor name when we know it. */
export function manufacturerKey(manufacturer: string): string {
  return norm(findVendor(manufacturer)?.name ?? manufacturer).replace(/[^a-z0-9]+/g, "");
}

/** Part number key: case, spaces and punctuation do not count. */
export function partKey(modelNumber: string): string {
  return norm(modelNumber).replace(/[^a-z0-9]+/g, "");
}

function words(label: string, manufacturer: string): string[] {
  let l = ` ${norm(label)} `;
  for (const n of manufacturerNames(manufacturer)) l = l.split(` ${n} `).join(" ");
  return l
    .replace(/[^a-z0-9+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The label as a model: no manufacturer, punctuation, case or variant words. */
export function normalizedModel(label: string, manufacturer: string): string {
  return words(label, manufacturer)
    .filter((w) => !VARIANT_WORDS.has(w))
    .join(" ");
}

/** The variant of a template: the catalog's variant field and the variant words of its label. */
export function variantOf(c: Pick<DupCandidate, "label" | "manufacturer" | "variant">): string {
  // Both: the field may name only part of it ("Lossless" for "FOX3 SR 201 MM (Lossless)").
  const fromField = norm(c.variant ?? "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const fromLabel = words(c.label, c.manufacturer).filter((w) => VARIANT_WORDS.has(w));
  return [...new Set([...fromField, ...fromLabel])].sort().join(" ");
}

const STATUS_RANK: Record<DupStatus, number> = { verified: 0, draft: 1, raw: 2, hidden: 3 };
const ORIGIN_RANK = { manufacturer: 0, community: 1, none: 2 } as const;
const LEVEL_RANK = { A: 0, B: 1, FIX: 2 } as const;
const curated = (s: string | null) => (s === "avail-catalog" || s === "avail-library" ? 0 : 1);

/** Primary first: verified > draft > raw; catalog > community; document > database; level; ports. */
export function comparePrimary(a: DupCandidate, b: DupCandidate): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    curated(a.source) - curated(b.source) ||
    ORIGIN_RANK[a.portsOrigin] - ORIGIN_RANK[b.portsOrigin] ||
    (a.level ? LEVEL_RANK[a.level] : 3) - (b.level ? LEVEL_RANK[b.level] : 3) ||
    b.ports - a.ports ||
    a.id.localeCompare(b.id)
  );
}

/** Key of an unordered pair of template ids ("Not duplicates" decisions). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Pairs decided "not duplicates": a set of pairKey. */
export type NotDuplicatePairs = ReadonlySet<string>;

/** Every pair of the ids, each once (the pairs a "Not duplicates" decision on a selection marks). */
export function allPairs(ids: readonly string[]): [string, string][] {
  const u = [...new Set(ids)].sort();
  const out: [string, string][] = [];
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) out.push([u[i], u[j]]);
  return out;
}

/**
 * Duplicate groups of the library (hidden templates left out), largest first. Pairs in
 * `notDuplicates` are not joined.
 */
export function duplicateGroups(all: readonly DupCandidate[], notDuplicates: NotDuplicatePairs = new Set()): DupGroup[] {
  const list = all.filter((c) => c.status !== "hidden");
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map<number, Set<DupGroup["reasons"][number]>>();
  const join = (a: number, b: number, reason: DupGroup["reasons"][number]) => {
    const ra = find(a);
    const rb = find(b);
    const reasons = new Set([...(why.get(ra) ?? []), ...(why.get(rb) ?? []), reason]);
    if (ra !== rb) parent[rb] = ra;
    why.set(find(a), reasons);
  };
  // Templates sharing a key; each joins every earlier one it is not decided apart from.
  const seen = new Map<string, number[]>();
  list.forEach((c, i) => {
    const variant = variantOf(c);
    const man = manufacturerKey(c.manufacturer);
    const keys: [string, DupGroup["reasons"][number]][] = [];
    const pk = partKey(c.modelNumber);
    if (man && pk) keys.push([`pn|${man}|${pk}|${variant}`, "same part number"]);
    const model = normalizedModel(c.label, c.manufacturer);
    if (man && model) keys.push([`model|${man}|${model}|${variant}`, "same model"]);
    for (const [k, reason] of keys) {
      const earlier = seen.get(k);
      if (!earlier) {
        seen.set(k, [i]);
        continue;
      }
      for (const j of earlier) if (!notDuplicates.has(pairKey(list[j].id, c.id))) join(j, i, reason);
      earlier.push(i);
    }
  });
  const groups = new Map<number, DupCandidate[]>();
  list.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });
  const out: DupGroup[] = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(comparePrimary);
    out.push({ primary: sorted[0].id, members: sorted, reasons: [...(why.get(root) ?? [])].sort() as DupGroup["reasons"] });
  }
  return out.sort((a, b) => b.members.length - a.members.length || a.members[0].label.localeCompare(b.members[0].label));
}

/** The primary of each duplicate's group: template id → { primary, group size }. */
export function duplicateIndex(groups: readonly DupGroup[]): Map<string, { primary: string; size: number }> {
  const m = new Map<string, { primary: string; size: number }>();
  for (const g of groups) for (const c of g.members) m.set(c.id, { primary: g.primary, size: g.members.length });
  return m;
}

/**
 * The template a new or changed one would duplicate (server, step 2.4): same manufacturer and
 * modelNumber, not hidden, not itself, not decided "not duplicates" with it, and the same variant
 * (a different variant is allowed).
 */
export function findDuplicate(
  t: { id?: string | null; label: string; manufacturer?: string | null; modelNumber?: string | null; variant?: string | null },
  existing: readonly Pick<DupCandidate, "id" | "label" | "manufacturer" | "modelNumber" | "status" | "variant">[],
  notDuplicates: NotDuplicatePairs = new Set(),
): Pick<DupCandidate, "id" | "label"> | null {
  const man = manufacturerKey(t.manufacturer ?? "");
  const pk = partKey(t.modelNumber ?? "");
  if (!man || !pk) return null;
  const variant = variantOf({ label: t.label, manufacturer: t.manufacturer ?? "", variant: t.variant ?? null });
  for (const e of existing) {
    if (e.id === t.id || e.status === "hidden") continue;
    if (t.id && notDuplicates.has(pairKey(t.id, e.id))) continue;
    if (manufacturerKey(e.manufacturer) !== man || partKey(e.modelNumber) !== pk) continue;
    if (variantOf(e) !== variant) continue;
    return { id: e.id, label: e.label };
  }
  return null;
}
