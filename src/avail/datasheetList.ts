/**
 * Data sheets to download (step 2.3): catalog cards whose ports come from the community database
 * (db, or a variant of a db card), grouped so that one A&E specification covers as many part
 * numbers as possible. A group joins cards that share the product page (referenceUrl: one page,
 * one spec sheet for its variants) or the model without the variant (colour, MM / SM, region).
 * Sorted by how many cards a document closes. Pure: the CLI reads the catalog and writes the files.
 */
import { modelKey, modelName, variantBase, type CatalogFile } from "./catalogPorts";
import { catalogIndex, portsOrigin, type CatalogMeta } from "./portsOrigin";

export interface DatasheetGroup {
  vendor: string;
  family: string;
  /** Model names (labels without the manufacturer) in the group. */
  models: string[];
  partNumbers: string[];
  /** Product pages of the group (normally one). */
  pages: string[];
  /** Cards the document would close. */
  cards: number;
  /** Catalog files of the group. */
  files: string[];
}

/**
 * Family of a model, as written: the leading words up to the first one with a digit, at most two
 * ("Cable Cubby 100" → "Cable Cubby", "CA 163 LP" → "CA", "Quantum IN4DTP3" → "Quantum");
 * a first word with a digit is the family itself ("FOX3 Matrix 24x" → "FOX3").
 */
export function familyOf(t: { label?: unknown; manufacturer?: unknown }): string {
  const label = typeof t.label === "string" ? t.label : "";
  const man = typeof t.manufacturer === "string" ? t.manufacturer : "";
  const base = label.replace(/\s*\([^()]*\)\s*$/, "");
  const model = base.toLowerCase().startsWith(`${man.toLowerCase()} `) ? base.slice(man.length + 1) : base;
  const words = model.trim().split(/\s+/);
  if (/\d/.test(words[0] ?? "")) return words[0] ?? modelName(variantBase(label), man);
  const out: string[] = [];
  for (const w of words) {
    if (/\d/.test(w) || out.length === 2) break;
    out.push(w);
  }
  return out.join(" ") || words[0] || "";
}

const META = (f: CatalogFile) => ({ file: f.file, ...(f.template._avail ?? {}) }) as CatalogMeta;

/** Cards with community ports: portsSource db, or a variant whose donor is db. */
export function communityCards(files: readonly CatalogFile[]): CatalogFile[] {
  const byFile = catalogIndex(files.map(META));
  return files.filter((f) => portsOrigin({ source: "avail-catalog", catalog: META(f) }, byFile).origin === "community");
}

function pageKey(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return "";
  return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

export function datasheetGroups(files: readonly CatalogFile[]): DatasheetGroup[] {
  const cards = communityCards(files);
  // Union-find over cards: same product page, or same model without the variant.
  const parent = cards.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const first = new Map<string, number>();
  cards.forEach((f, i) => {
    for (const key of [`page:${pageKey(f.template.referenceUrl)}`, `model:${modelKey(f.template.label, f.template.manufacturer)}`]) {
      if (key.endsWith(":")) continue;
      const j = first.get(key);
      if (j === undefined) first.set(key, i);
      else join(j, i);
    }
  });
  const groups = new Map<number, CatalogFile[]>();
  cards.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));

  const modelOf = (f: CatalogFile) => f.template.label.replace(new RegExp(`^${f.template.manufacturer}\\s+`, "i"), "");
  const out: DatasheetGroup[] = [...groups.values()].map((g) => {
    const sorted = [...g].sort((a, b) => a.template.label.localeCompare(b.template.label));
    const fams = new Map<string, number>();
    for (const f of sorted) fams.set(familyOf(f.template), (fams.get(familyOf(f.template)) ?? 0) + 1);
    const family = [...fams.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return {
      vendor: sorted[0].template.manufacturer,
      family,
      models: [...new Set(sorted.map(modelOf))],
      partNumbers: [...new Set(sorted.flatMap((f) => [f.template.modelNumber, f.template._avail?.altPartNumber].filter((p): p is string => !!p)))],
      pages: [...new Set(sorted.map((f) => String(f.template.referenceUrl ?? "")).filter(Boolean))],
      cards: sorted.length,
      files: sorted.map((f) => f.file),
    };
  });
  return out.sort((a, b) => b.cards - a.cards || a.vendor.localeCompare(b.vendor) || a.family.localeCompare(b.family) || a.models[0].localeCompare(b.models[0]));
}

export const DATASHEET_COLUMNS = ["Vendor", "Family", "Models", "Part numbers", "Product page", "Cards it closes"] as const;

export function datasheetRows(groups: readonly DatasheetGroup[]): (string | number)[][] {
  return groups.map((g) => [g.vendor, g.family, g.models.join("; "), g.partNumbers.join(", "), g.pages.join(" "), g.cards]);
}

export function formatDatasheetList(groups: readonly DatasheetGroup[], date: string): string {
  const total = groups.reduce((n, g) => n + g.cards, 0);
  const by = (v: string) => groups.filter((g) => g.vendor === v);
  const vendors = [...new Set(groups.map((g) => g.vendor))].sort();
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "# Data sheets to download",
    "",
    `Catalog cards whose ports come from the community database (portsSource db, or a variant of a db card): **${total}** cards, ` +
      `**${groups.length}** documents. Generated ${date} by \`npm run report:datasheets\` (api-avail); the same table — \`datasheets-to-download.xlsx\`.`,
    "",
    vendors.map((v) => `${v}: ${by(v).reduce((n, g) => n + g.cards, 0)} cards, ${by(v).length} documents`).join(" · ") + ".",
    "",
    "One row — one document (the A&E specification / data sheet from the product page): the cards that share the product page or the model " +
      "without the variant. Sorted by how many cards it closes. Put the PDF into `/Users/dmartakov/avail/datasheets/<vendor>/` and process it " +
      "as CLAUDE.md describes (\"Data sheets: processing\").",
    "",
    `| ${DATASHEET_COLUMNS.join(" | ")} |`,
    "|---|---|---|---|---|---:|",
  ];
  for (const r of datasheetRows(groups)) {
    const [vendor, family, models, parts, pages, cards] = r as [string, string, string, string, string, number];
    const links = pages.split(" ").filter(Boolean).map((u) => `[${u.replace(/^https?:\/\/(www\.)?/, "")}](${u})`).join(" ");
    lines.push(`| ${vendor} | ${esc(family)} | ${esc(models)} | ${esc(parts)} | ${links} | ${cards} |`);
  }
  return lines.join("\n") + "\n";
}
