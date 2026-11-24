/**
 * Pure helpers behind the AVAIL library UI: taxonomy grouping, the review checklist,
 * unverified blocks on a schematic.
 */
import { TAXONOMY } from "./library";
import { blockStatus, type TemplateStatus } from "./libraryMode";

export interface LibrarySection<T> {
  /** Leaf name shown under the group ("Extenders"). */
  label: string;
  /** Full category path ("AV distribution / Extenders"). */
  path: string;
  templates: T[];
}

export interface LibraryGroup<T> {
  group: string;
  sections: LibrarySection<T>[];
}

/** Title of the trailing group for templates outside the schematic categories. */
export const UNCATEGORIZED_GROUP = "Uncategorized";

/**
 * Library sections by the accounting-system taxonomy: group → subcategory, taxonomy
 * order, only schematic=true leaves. Templates with any other category (none, a group,
 * an EasySchematic one, schematic=false) go to "Uncategorized" at the end, one section
 * per category value, so nothing silently disappears from the library.
 */
export function groupByTaxonomy<T>(categories: readonly { label: string; templates: T[] }[]): LibraryGroup<T>[] {
  const byPath = new Map(categories.map((c) => [c.label, c.templates]));
  const groups: LibraryGroup<T>[] = [];
  const used = new Set<string>();
  for (const c of TAXONOMY.categories) {
    if (!c.leaf || !c.schematic) continue;
    const templates = byPath.get(c.path);
    if (!templates?.length) continue;
    used.add(c.path);
    let g = groups.find((x) => x.group === c.group);
    if (!g) groups.push((g = { group: c.group, sections: [] }));
    g.sections.push({ label: c.path.slice(c.group.length).replace(/^\s*\/\s*/, "") || c.path, path: c.path, templates });
  }
  const rest = categories.filter((c) => !used.has(c.label) && c.templates.length > 0);
  if (rest.length) {
    groups.push({
      group: UNCATEGORIZED_GROUP,
      sections: rest.map((c) => ({ label: c.label === "Other" ? "—" : c.label, path: c.label, templates: c.templates })),
    });
  }
  return groups;
}

/**
 * The engineer's review checklist, word for word from the English list in
 * docs/avail/device-block-standard.md (section 8): what the linter cannot check.
 * src/__tests__/availLibrary.test.ts keeps the two in sync.
 */
export const REVIEW_CHECKLIST = [
  "Number and type of ports match the rear and front panels in the datasheet.",
  "Port labels match the panel silkscreen in meaning.",
  "Ports within a section are in panel order.",
  "Signal type matches the port's real protocol (RS-232 vs RS-485, Dante vs AVB, relay vs GPIO).",
  "Dimensions, weight and power are checked against the datasheet of the same revision.",
  "referenceUrl leads to the page of exactly this model.",
] as const;

export interface UnverifiedBlock {
  nodeId: string;
  label: string;
  status: TemplateStatus;
}

/**
 * Device blocks of a schematic made from templates that are not verified or draft
 * (raw, hidden or unknown to the library). Empty outside AVAIL mode.
 */
export function unverifiedBlocks(
  nodes: readonly { id: string; type?: string; data: unknown }[],
  statusOf: (templateId: string | undefined) => TemplateStatus | null = blockStatus,
): UnverifiedBlock[] {
  const out: UnverifiedBlock[] = [];
  for (const n of nodes) {
    if (n.type !== "device") continue;
    const d = n.data as { templateId?: string; label?: string };
    const status = statusOf(d.templateId);
    if (status === "raw" || status === "hidden") out.push({ nodeId: n.id, label: d.label ?? n.id, status });
  }
  return out;
}

/** Section title for ports without one. */
export const NO_SECTION = "No section";

export interface PortRowView {
  label: string;
  direction: string;
  signal: string;
  connector: string;
  notes: string;
}

/** Ports of a template grouped by section, in the order the sections first appear. */
export function portsBySection(
  ports: readonly { label?: string; direction?: string; signalType?: string; connectorType?: string; section?: string; notes?: string }[],
): { section: string; ports: PortRowView[] }[] {
  const groups = new Map<string, PortRowView[]>();
  for (const p of ports) {
    const section = p.section?.trim() || NO_SECTION;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push({
      label: p.label ?? "",
      direction: p.direction ?? "",
      signal: p.signalType ?? "",
      connector: p.connectorType ?? "",
      notes: p.notes ?? "",
    });
  }
  return [...groups].map(([section, rows]) => ({ section, ports: rows }));
}

export interface CardRow {
  label: string;
  value: string;
  /** Set for the manufacturer page row. */
  href?: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0;

/** The device card of the review dialog; a missing value shows as "—". */
export function deviceCardRows(t: {
  label?: string; manufacturer?: string; modelNumber?: string; shortName?: string; deviceType?: string; category?: string;
  heightMm?: number; widthMm?: number; depthMm?: number; weightKg?: number; powerDrawW?: number; voltage?: string;
  poeDrawW?: number; poeBudgetW?: number; referenceUrl?: string;
}): CardRow[] {
  const dash = "—";
  const dims = num(t.heightMm) || num(t.widthMm) || num(t.depthMm)
    ? `${t.heightMm ?? "?"} × ${t.widthMm ?? "?"} × ${t.depthMm ?? "?"} mm (H × W × D)`
    : dash;
  const power: string[] = [];
  if (num(t.powerDrawW)) power.push(`${t.powerDrawW} W`);
  if (t.voltage) power.push(t.voltage);
  if (num(t.poeDrawW)) power.push(`PoE draw ${t.poeDrawW} W`);
  if (num(t.poeBudgetW)) power.push(`PoE budget ${t.poeBudgetW} W`);
  return [
    { label: "Model", value: t.label || dash },
    { label: "Manufacturer", value: t.manufacturer || dash },
    { label: "Part number", value: t.modelNumber || dash },
    { label: "Short name", value: t.shortName || dash },
    { label: "Device type", value: t.deviceType || dash },
    { label: "Category", value: t.category || dash },
    { label: "Dimensions", value: dims },
    { label: "Weight", value: num(t.weightKg) ? `${t.weightKg} kg` : dash },
    { label: "Power", value: power.length ? power.join(", ") : dash },
    t.referenceUrl ? { label: "Manufacturer page", value: t.referenceUrl, href: t.referenceUrl } : { label: "Manufacturer page", value: dash },
  ];
}
