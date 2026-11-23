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
export const UNCATEGORIZED_GROUP = "Без категории";

/**
 * Library sections by the accounting-system taxonomy: group → subcategory, taxonomy
 * order, only schematic=true leaves. Templates with any other category (none, a group,
 * an EasySchematic one, schematic=false) go to "Без категории" at the end, one section
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
 * The engineer's review checklist, word for word from docs/avail/device-block-standard.md
 * (section 8): what the linter cannot check. src/__tests__/availLibrary.test.ts keeps the
 * two in sync.
 */
export const REVIEW_CHECKLIST = [
  "Число и тип портов совпадают с задней и передней панелью по даташиту.",
  "Подписи по смыслу совпадают с шелкографией.",
  "Порядок портов внутри секции — как на панели.",
  "Тип сигнала соответствует реальному протоколу порта (RS-232 vs RS-485, Dante vs AVB, реле vs GPIO).",
  "Габариты, вес, потребление сверены с даташитом той же ревизии.",
  "referenceUrl ведёт на страницу именно этой модели.",
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
