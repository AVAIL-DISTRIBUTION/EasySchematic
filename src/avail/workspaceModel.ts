/**
 * Library workspace (step 2.2, the /library page): the model behind the table — rows, lint per
 * template, filters and saved filters, columns, bulk-action summaries, proposal diffs.
 *
 * Pure functions, no browser or Node dependencies (the page and the tests use them).
 */
import type { DeviceTemplate } from "../types";
import { lintBlock, type BlockLevel, type BlockLintResult } from "./blockLint";
import { findCategory } from "./library";
import { slotLibraryContext } from "./slotFamilies";

export type WsStatus = "verified" | "draft" | "raw" | "hidden";
export type WsApproval = "review" | "bulk" | "bulk-source";

/** What GET /avail/workspace/templates returns next to each template (api-avail/src/workspace.ts). */
export interface WsInfo {
  status: WsStatus;
  level: BlockLevel | null;
  statusReason: string | null;
  statusChangedAt: string | null;
  updatedAt: string | null;
  approvedBy: string | null;
  approvedVia: WsApproval | null;
  approvedAt: string | null;
  portsOrigin: "manufacturer" | "community" | "none";
  portsSource: string | null;
  portsFrom: string | null;
  datasheetUrl: string | null;
  source: string | null;
  editors: string[];
  lastActor: string | null;
  lastAt: string | null;
  /** Possible duplicate (step 2.4): the group's proposed primary and size. */
  duplicate?: { primary: string; size: number } | null;
}

export type WsTemplate = DeviceTemplate & { avail: WsInfo };

export interface WsRow {
  id: string;
  template: WsTemplate;
  vendor: string;
  model: string;
  partNumber: string;
  category: string;
  deviceType: string;
  status: WsStatus;
  /** Level as stored (the server lints with the whole library), else the page's own lint. */
  level: BlockLevel;
  lint: BlockLintResult;
  /** Rule keys of the lint messages ("E no power port", "W \"…\": label in all caps"). */
  rules: string[];
  portsSource: string;
  updatedAt: string;
  approvedBy: string;
  approvedVia: string;
  /** Possible duplicate: "<primary label> (n)" — the primary's own row says "primary (n)"; "" when none. */
  duplicateOf: string;
  /** Sort key keeping a duplicate group together, primary first. */
  duplicateKey: string;
  /** Lower-case text searched by the search box. */
  haystack: string;
}

/** A lint message without its specifics: quoted port labels and parenthesised values. */
export function ruleKey(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/; use .*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Human labels of the commonest rules, for the rule filter (anything else shows its key). */
export const RULE_LABELS: Readonly<Record<string, string>> = {
  "E no power port": "No power port",
  "W no powerDrawW/voltage": "No power draw / voltage",
  "E \"…\": no connectorType": "Port without a connector",
  "E \"…\": no section": "Port without a section",
  "E no ports": "No ports",
  "E no category": "No category",
  "E no modelNumber": "No part number",
  "W no heightMm": "No dimensions",
  "W no referenceUrl": "No reference link",
  "W no searchTerms": "No search terms",
  "W no shortName": "No short name",
  "W \"…\": label in all caps": "Port label in all caps",
  "W \"…\": label longer than 28 characters": "Port label too long",
  "W sections are not in the standard order": "Sections out of order",
  "W header is not {{deviceType}}": "Header is not the device type",
};

export function ruleLabel(key: string): string {
  return RULE_LABELS[key] ?? key.replace(/^([EW]) /, (_m, k: string) => (k === "E" ? "Error: " : "Warning: "));
}

const PORTS_SOURCE_LABELS: Readonly<Record<string, string>> = {
  stencil: "Extron stencil",
  datasheet: "Data sheet",
  library: "Curated library",
  db: "Database",
  variant: "Variant",
  upstream: "Community library",
};

export function portsSourceLabel(info: Pick<WsInfo, "portsSource" | "portsOrigin">): string {
  if (!info.portsSource) return info.portsOrigin === "community" ? "Community library" : "None recorded";
  return PORTS_SOURCE_LABELS[info.portsSource] ?? info.portsSource;
}

export const ORIGIN_LABELS: Readonly<Record<WsInfo["portsOrigin"], string>> = { manufacturer: "Manufacturer document", community: "Community database", none: "Nothing recorded" };

export const APPROVAL_LABELS: Readonly<Record<WsApproval, string>> = { review: "Review card", bulk: "Bulk approve", "bulk-source": "By source (CLI)" };
export const STATUS_LABELS: Readonly<Record<WsStatus, string>> = { verified: "Verified", draft: "Draft", raw: "Unverified", hidden: "Hidden" };
export const WS_STATUSES: readonly WsStatus[] = ["verified", "draft", "raw", "hidden"];
export const LEVELS: readonly BlockLevel[] = ["A", "B", "FIX"];

/** Model name without the manufacturer: "Extron DTP3 T 203" → "DTP3 T 203". */
function modelOf(t: DeviceTemplate): string {
  const man = t.manufacturer ?? "";
  return man && t.label.toLowerCase().startsWith(`${man.toLowerCase()} `) ? t.label.slice(man.length + 1) : t.label;
}

/** Table rows: one per template, linted with the whole library's slot context. */
export function buildRows(templates: readonly WsTemplate[]): WsRow[] {
  const labels = new Map(templates.map((t) => [t.id ?? "", t.label]));
  const ctx = slotLibraryContext(templates.map((t) => ({ slotFamily: t.slotFamily ?? null, slots: (t.slots as { slotFamily?: string; slotFamilies?: string[] }[] | undefined) ?? null })));
  return templates.map((t) => {
    const lint = lintBlock(t, ctx);
    const a = t.avail;
    const row: WsRow = {
      id: t.id ?? "",
      template: t,
      vendor: t.manufacturer ?? "",
      model: modelOf(t),
      partNumber: t.modelNumber ?? "",
      category: typeof t.category === "string" ? t.category : "",
      deviceType: t.deviceType,
      status: a.status,
      level: a.level ?? lint.level,
      lint,
      rules: [...new Set([...lint.errors.map((m) => `E ${ruleKey(m)}`), ...lint.warnings.map((m) => `W ${ruleKey(m)}`)])],
      portsSource: portsSourceLabel(a),
      updatedAt: a.updatedAt ?? "",
      approvedBy: a.approvedBy ?? "",
      approvedVia: a.approvedVia ? APPROVAL_LABELS[a.approvedVia] : "",
      duplicateOf: a.duplicate
        ? a.duplicate.primary === t.id
          ? `primary (${a.duplicate.size})`
          : `${labels.get(a.duplicate.primary) ?? a.duplicate.primary} (${a.duplicate.size})`
        : "",
      duplicateKey: a.duplicate ? `${labels.get(a.duplicate.primary) ?? ""}|${a.duplicate.primary}|${a.duplicate.primary === t.id ? 0 : 1}` : "",
      haystack: "",
    };
    row.haystack = [t.label, row.partNumber, row.vendor, row.category, row.deviceType, ...(t.searchTerms ?? []), t.id ?? ""].join(" ").toLowerCase();
    return row;
  });
}

// ---------------------------------------------------------------------------- filters

export interface WsFilter {
  vendors: string[];
  /** Category paths or groups ("Audio Products" matches every "Audio Products / …"). */
  categories: string[];
  deviceTypes: string[];
  statuses: WsStatus[];
  levels: BlockLevel[];
  portsSources: string[];
  rules: string[];
  /** Changed on or after this day (YYYY-MM-DD), empty = any. */
  changedSince: string;
  approvedBy: string[];
  /** Where the ports come from: manufacturer documents, the community database, nothing recorded. */
  origins: WsInfo["portsOrigin"][];
  /** How the template was approved: Review card, bulk Approve, by source (CLI). */
  approvedVia: WsApproval[];
  /** Somebody in the template's editors (audit log). */
  editedBy: string;
  /** Only templates in a possible duplicate group (step 2.4). */
  duplicates: boolean;
  text: string;
}

export const EMPTY_FILTER: WsFilter = {
  vendors: [], categories: [], deviceTypes: [], statuses: [], levels: [], portsSources: [], rules: [],
  changedSince: "", approvedBy: [], origins: [], approvedVia: [], editedBy: "", duplicates: false, text: "",
};

/** A filter with every field (saved filters from an older page may lack the newer ones). */
export function completeFilter(f: Partial<WsFilter>): WsFilter {
  return { ...EMPTY_FILTER, ...f };
}

export function filterRows(rows: readonly WsRow[], f: WsFilter): WsRow[] {
  const text = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inCategory = (c: string) => f.categories.some((x) => c === x || c.startsWith(`${x} /`));
  return rows.filter(
    (r) =>
      (!f.vendors.length || f.vendors.includes(r.vendor)) &&
      (!f.categories.length || inCategory(r.category)) &&
      (!f.deviceTypes.length || f.deviceTypes.includes(r.deviceType)) &&
      (!f.statuses.length || f.statuses.includes(r.status)) &&
      (!f.levels.length || f.levels.includes(r.level)) &&
      (!f.portsSources.length || f.portsSources.includes(r.portsSource)) &&
      (!f.rules.length || f.rules.some((k) => r.rules.includes(k))) &&
      (!f.changedSince || (r.updatedAt !== "" && r.updatedAt.slice(0, 10) >= f.changedSince)) &&
      (!f.approvedBy.length || f.approvedBy.includes(r.approvedBy)) &&
      (!f.origins.length || f.origins.includes(r.template.avail.portsOrigin)) &&
      (!f.approvedVia.length || (r.template.avail.approvedVia !== null && f.approvedVia.includes(r.template.avail.approvedVia))) &&
      (!f.editedBy || r.template.avail.editors.includes(f.editedBy)) &&
      (!f.duplicates || r.duplicateOf !== "") &&
      text.every((w) => r.haystack.includes(w)),
  );
}

export function activeFilterCount(f: WsFilter): number {
  return (
    f.vendors.length + f.categories.length + f.deviceTypes.length + f.statuses.length + f.levels.length + f.portsSources.length +
    f.rules.length + f.approvedBy.length + f.origins.length + f.approvedVia.length + (f.changedSince ? 1 : 0) + (f.editedBy ? 1 : 0) + (f.duplicates ? 1 : 0) + (f.text.trim() ? 1 : 0)
  );
}

export interface SavedFilter {
  name: string;
  filter: WsFilter;
  /** Built-in presets cannot be deleted. */
  builtIn?: boolean;
}

/** Built-in saved filters; "My edits" needs the signed-in user's email. */
export function builtInFilters(me: string | null): SavedFilter[] {
  return [
    { name: "Review queue", builtIn: true, filter: { ...EMPTY_FILTER, statuses: ["draft"], levels: ["A"] } },
    { name: "Drafts to fix", builtIn: true, filter: { ...EMPTY_FILTER, statuses: ["draft"], levels: ["B", "FIX"] } },
    { name: "Unverified", builtIn: true, filter: { ...EMPTY_FILTER, statuses: ["raw"] } },
    // Bulk-approved although the ports come from the community database, not from a manufacturer document.
    {
      name: "Approved without document check",
      builtIn: true,
      filter: { ...EMPTY_FILTER, statuses: ["verified"], origins: ["community"], approvedVia: ["bulk"] },
    },
    ...(me ? [{ name: "My edits", builtIn: true, filter: { ...EMPTY_FILTER, editedBy: me } }] : []),
    { name: "Possible duplicates", builtIn: true, filter: { ...EMPTY_FILTER, duplicates: true } },
    { name: "Hidden", builtIn: true, filter: { ...EMPTY_FILTER, statuses: ["hidden"] } },
  ];
}

/** Distinct values of a row field with counts, most frequent first (filter option lists). */
export function facet(rows: readonly WsRow[], pick: (r: WsRow) => string | readonly string[]): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = pick(r);
    for (const x of typeof v === "string" ? [v] : v) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Category tree of the rows: group → leaves, with counts. */
export function categoryTree(rows: readonly WsRow[]): { group: string; count: number; leaves: { path: string; leaf: string; count: number }[] }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const path = r.category || "Uncategorized";
    const group = path.includes(" / ") ? path.split(" / ")[0] : path;
    const g = groups.get(group) ?? new Map<string, number>();
    g.set(path, (g.get(path) ?? 0) + 1);
    groups.set(group, g);
  }
  return [...groups.entries()]
    .map(([group, leaves]) => ({
      group,
      count: [...leaves.values()].reduce((a, b) => a + b, 0),
      leaves: [...leaves.entries()].map(([path, count]) => ({ path, leaf: path.includes(" / ") ? path.slice(group.length + 3) : path, count })).sort((a, b) => a.leaf.localeCompare(b.leaf)),
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

// ---------------------------------------------------------------------------- columns

export type ColumnId =
  | "vendor" | "model" | "partNumber" | "category" | "deviceType" | "level" | "status" | "portsSource" | "ew" | "updatedAt" | "approved" | "duplicateOf";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  width: number;
  value: (r: WsRow) => string;
  /** Sort key (defaults to value). */
  sort?: (r: WsRow) => string | number;
}

const LEVEL_ORDER: Record<BlockLevel, number> = { A: 0, B: 1, FIX: 2 };

export const COLUMNS: readonly ColumnDef[] = [
  { id: "vendor", label: "Vendor", width: 110, value: (r) => r.vendor },
  { id: "model", label: "Model", width: 260, value: (r) => r.model },
  { id: "partNumber", label: "Part number", width: 140, value: (r) => r.partNumber },
  { id: "category", label: "Category", width: 220, value: (r) => r.category },
  { id: "deviceType", label: "Device type", width: 140, value: (r) => r.deviceType },
  { id: "level", label: "Level", width: 56, value: (r) => r.level, sort: (r) => LEVEL_ORDER[r.level] },
  { id: "status", label: "Status", width: 90, value: (r) => STATUS_LABELS[r.status] },
  { id: "portsSource", label: "Ports source", width: 130, value: (r) => r.portsSource },
  { id: "ew", label: "E / W", width: 64, value: (r) => `${r.lint.errors.length} / ${r.lint.warnings.length}`, sort: (r) => r.lint.errors.length * 1000 + r.lint.warnings.length },
  { id: "updatedAt", label: "Updated", width: 140, value: (r) => r.updatedAt },
  { id: "approved", label: "Approved by", width: 200, value: (r) => (r.approvedBy ? `${r.approvedBy}${r.approvedVia ? ` (${r.approvedVia})` : ""}` : "") },
  { id: "duplicateOf", label: "Duplicate of", width: 220, value: (r) => r.duplicateOf, sort: (r) => r.duplicateKey },
];

export const DEFAULT_COLUMNS: readonly ColumnId[] = ["vendor", "model", "partNumber", "category", "deviceType", "level", "status", "portsSource", "ew", "updatedAt", "approved"];

export function sortRows(rows: readonly WsRow[], by: ColumnId, desc: boolean): WsRow[] {
  const col = COLUMNS.find((c) => c.id === by)!;
  const key = col.sort ?? col.value;
  const out = [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c || a.model.localeCompare(b.model);
  });
  return desc ? out.reverse() : out;
}

// ---------------------------------------------------------------------------- bulk actions

export type BulkAction = "approve" | "draft" | "hide" | "unhide" | "category" | "merge";

export const BULK_LABELS: Readonly<Record<BulkAction, string>> = {
  approve: "Approve",
  draft: "Move to draft",
  hide: "Hide",
  unhide: "Unhide",
  category: "Change category",
  merge: "Merge into…",
};

/** Target status of a status action. */
export const BULK_STATUS: Readonly<Record<Exclude<BulkAction, "category" | "merge">, WsStatus>> = { approve: "verified", draft: "draft", hide: "hidden", unhide: "draft" };

export interface BulkPlan {
  action: BulkAction;
  /** Templates that will change, with what changes. */
  change: { row: WsRow; from: string; to: string }[];
  /** Already in the target state. */
  unchanged: WsRow[];
  /** Will be refused (approve below level A; unhide of a template that is not hidden). */
  refused: { row: WsRow; reason: string }[];
  /** For category: the target path. */
  category?: string;
  /** For merge: the primary template (stays), the others become hidden as its duplicates. */
  primary?: WsRow;
}

/** The reason a merged duplicate is hidden with (api-avail duplicates.ts duplicateReason). */
export const duplicateReason = (primaryId: string) => `duplicate of ${primaryId}`;

/**
 * The primary a merge proposes for a selection: the group's proposed primary when it is selected
 * (workspace duplicate info), else the first selected row.
 */
export function suggestedPrimary(rows: readonly WsRow[]): WsRow | undefined {
  const ids = new Set(rows.map((r) => r.id));
  const counts = new Map<string, number>();
  for (const r of rows) {
    const p = r.template.avail.duplicate?.primary;
    if (p && ids.has(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return rows.find((r) => r.id === best) ?? rows[0];
}

/** Merge: every selected row but the primary becomes hidden "duplicate of <primary>". */
export function planMerge(rows: readonly WsRow[], primary: WsRow): BulkPlan {
  const plan: BulkPlan = { action: "merge", change: [], unchanged: [], refused: [], primary };
  const reason = duplicateReason(primary.id);
  for (const row of rows) {
    if (row.id === primary.id) continue;
    if (row.status === "hidden" && row.template.avail.statusReason === reason) plan.unchanged.push(row);
    else plan.change.push({ row, from: STATUS_LABELS[row.status], to: `Hidden (duplicate of ${primary.template.label})` });
  }
  return plan;
}

/** What a bulk action would do to the selection: the summary shown before it runs. */
export function planBulk(action: Exclude<BulkAction, "merge">, rows: readonly WsRow[], category?: string): BulkPlan {
  const plan: BulkPlan = { action, change: [], unchanged: [], refused: [], ...(category ? { category } : {}) };
  for (const row of rows) {
    if (action === "category") {
      const c = category ? findCategory(category) : undefined;
      if (!c || !c.leaf) plan.refused.push({ row, reason: "not a leaf category" });
      else if (row.category === c.path) plan.unchanged.push(row);
      else plan.change.push({ row, from: row.category || "(none)", to: c.path });
      continue;
    }
    const to = BULK_STATUS[action];
    if (action === "unhide" && row.status !== "hidden") {
      plan.unchanged.push(row);
      continue;
    }
    if (row.status === to) {
      plan.unchanged.push(row);
      continue;
    }
    if (action === "approve" && row.level !== "A") {
      plan.refused.push({ row, reason: `level ${row.level}: verified needs level A` });
      continue;
    }
    plan.change.push({ row, from: STATUS_LABELS[row.status], to: STATUS_LABELS[to] });
  }
  return plan;
}

// ---------------------------------------------------------------------------- export

/** Rows of the selection for the xlsx export: header + one line per template. */
export function exportTable(rows: readonly WsRow[]): (string | number)[][] {
  return [
    ["Vendor", "Model", "Part number", "Category", "Device type", "Level", "Status", "Ports source", "Errors", "Warnings", "Updated", "Approved by", "Approved how", "Reference URL", "Data sheet", "Template id", "Lint messages"],
    ...rows.map((r) => [
      r.vendor, r.model, r.partNumber, r.category, r.deviceType, r.level, STATUS_LABELS[r.status], r.portsSource,
      r.lint.errors.length, r.lint.warnings.length, r.updatedAt, r.approvedBy, r.approvedVia, r.template.referenceUrl ?? "",
      r.template.avail.datasheetUrl ?? "", r.id, [...r.lint.errors.map((m) => `E ${m}`), ...r.lint.warnings.map((m) => `W ${m}`)].join("\n"),
    ]),
  ];
}

// ---------------------------------------------------------------------------- proposals

/** Template fields compared in a proposal ("was → becomes"); ports and slots separately. */
const DIFF_FIELDS = [
  "label", "shortName", "manufacturer", "modelNumber", "deviceType", "category", "referenceUrl", "searchTerms", "heightMm", "widthMm",
  "depthMm", "weightKg", "powerDrawW", "voltage", "poeDrawW", "poeBudgetW", "powerCapacityW", "thermalBtuh", "unitCost", "slotFamily",
  "auxiliaryData", "color",
] as const;

const PORT_FIELDS = ["label", "signalType", "direction", "section", "connectorType", "notes", "gender", "frontConnectorType", "rearConnectorType", "exclusiveGroup"] as const;

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface PortChange {
  kind: "added" | "removed" | "changed";
  label: string;
  changes: FieldChange[];
}

export interface TemplateDiff {
  fields: FieldChange[];
  ports: PortChange[];
  slots: FieldChange | null;
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? v.join(", ") : JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type PortLike = Record<string, unknown> & { id?: string; label?: string };

/** "Was → becomes" of a proposed template against the current one: fields, ports (by id, else label), slots. */
export function diffTemplates(before: Record<string, unknown>, after: Record<string, unknown>): TemplateDiff {
  const fields: FieldChange[] = [];
  for (const f of DIFF_FIELDS) if (!same(before[f], after[f])) fields.push({ field: f, before: show(before[f]), after: show(after[f]) });

  const ports: PortChange[] = [];
  const oldPorts = (Array.isArray(before.ports) ? before.ports : []) as PortLike[];
  const newPorts = (Array.isArray(after.ports) ? after.ports : []) as PortLike[];
  const matched = new Set<PortLike>();
  const find = (p: PortLike) => oldPorts.find((o) => !matched.has(o) && o.id && o.id === p.id) ?? oldPorts.find((o) => !matched.has(o) && o.label === p.label);
  for (const p of newPorts) {
    const o = find(p);
    if (!o) {
      ports.push({ kind: "added", label: String(p.label ?? "?"), changes: PORT_FIELDS.filter((k) => p[k] !== undefined).map((k) => ({ field: k, before: "—", after: show(p[k]) })) });
      continue;
    }
    matched.add(o);
    const changes = PORT_FIELDS.filter((k) => !same(o[k], p[k])).map((k) => ({ field: k, before: show(o[k]), after: show(p[k]) }));
    if (changes.length) ports.push({ kind: "changed", label: String(o.label ?? p.label ?? "?"), changes });
  }
  for (const o of oldPorts) if (!matched.has(o)) ports.push({ kind: "removed", label: String(o.label ?? "?"), changes: [] });
  const slots = same(before.slots, after.slots) ? null : { field: "slots", before: show(before.slots), after: show(after.slots) };
  return { fields, ports, slots };
}

export function diffIsEmpty(d: TemplateDiff): boolean {
  return !d.fields.length && !d.ports.length && !d.slots;
}
