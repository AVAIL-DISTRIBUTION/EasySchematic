/**
 * Import of raw templates from a public EasySchematic library (GET /templates of
 * api.easyschematic.live by default) into our library, with status raw.
 *
 * Per template:
 *   - manufacturer → canonical name from docs/avail/avail-vendors.json (aliases, case);
 *     other vendors keep their (trimmed) name;
 *   - category → deviceTypeDefaults of docs/avail/avail-taxonomy.json; types mapped to
 *     null or missing there get no category (the source's own category is dropped);
 *   - lint_level → src/avail/blockLint.ts on the normalized template.
 *
 * Duplicates: one template per manufacturer + model (modelNumber, or label when there
 * is none), compared case- and spacing-insensitively after normalization. Within the
 * source the first one wins; a local template is matched by upstream id (meta), then
 * by id (our seed uses upstream ids), then by manufacturer + model.
 *
 * Vendor decisions (docs/avail/vendor-decisions.json, src/avail/vendorDecisions.ts) come
 * first: templates without a manufacturer, of manufacturers outside keep/rename/generic, and
 * outside a vendor's scope (Sony, NETGEAR) are skipped; kept ones get the canonical
 * manufacturer; a brand folded into Generic is imported only as "Generic <type>" and only
 * when no Generic of that type exists. So a repeated import after apply:vendor-decisions
 * does not bring back what the cleanup removed. Ids deleted by docs/avail/generic-plan.json
 * are skipped too, and rows written by either cleanup are not overwritten.
 *
 * Status rules: verified and draft templates are never touched; hidden ones get the
 * new data but stay hidden; everything else becomes raw. A second run with the same
 * source data changes nothing (all "unchanged").
 */
import type Database from "better-sqlite3";
import { templateToRow, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { defaultCategoryFor, findVendor, GENERIC_VENDOR, normalizeManufacturer, VENDORS } from "../../src/avail/library";
import { genericTemplate, VendorRules } from "../../src/avail/vendorDecisions";
import { GENERIC_PLAN_SOURCE, plannedDeletions } from "./genericPlan";
import { PROTECTED_STATUSES, type TemplateMetaRow, type TemplateStatus } from "./templateMeta";

/** meta.source of templates written by apply:vendor-decisions (vendorCleanup.ts). */
export const VENDOR_DECISIONS_SOURCE = "vendor-decisions";
/** Rows written by our cleanups: import:upstream does not overwrite them. */
const WRITTEN_SOURCES = new Set([VENDOR_DECISIONS_SOURCE, GENERIC_PLAN_SOURCE]);

export const DEFAULT_UPSTREAM_URL = "https://api.easyschematic.live/templates";
export const UPSTREAM_SOURCE = "easyschematic.live";

export interface UpstreamTemplate {
  id: string;
  version?: number;
  deviceType: string;
  category?: string | null;
  label: string;
  manufacturer?: string;
  modelNumber?: string;
  ports: unknown[];
  [key: string]: unknown;
}

export interface ImportReport {
  source: string;
  received: number;
  invalid: number;
  /** Same manufacturer + model as an earlier template of the source. */
  duplicates: number;
  /** inserted + updated + unchanged: source templates now in the library as raw (or hidden). */
  imported: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Matched a verified/draft template, or one written by apply:vendor-decisions: left as it is. */
  skippedProtected: number;
  /** Matched a hidden template: data refreshed, still hidden. */
  keptHidden: number;
  /** Imported templates per vendor of avail-vendors.json (every vendor listed, 0 included). */
  ourVendors: Record<string, number>;
  otherVendors: { templates: number; manufacturers: number };
  noManufacturer: number;
  noCategory: number;
  levels: Record<BlockLevel, number>;
  /** Skipped by vendor decisions. */
  skipped: { noManufacturer: number; notDecided: number; scope: number; genericExists: number; genericPlan: number };
  /** "Generic <type>" templates created from brands folded into Generic. */
  genericCreated: string[];
  dryRun: boolean;
}

export interface ImportOptions {
  source?: string;
  dryRun?: boolean;
  /** Written to avail_template_meta.updated_by. */
  updatedBy?: string;
  /** Vendor decisions; defaults to docs/avail/vendor-decisions.json. */
  rules?: VendorRules;
  /** Ids deleted by docs/avail/generic-plan.json: never imported again. */
  planDeleted?: Set<string>;
}

function isUpstreamTemplate(v: unknown): v is UpstreamTemplate {
  const t = v as UpstreamTemplate;
  return (
    !!t && typeof t === "object" && typeof t.id === "string" && t.id !== "" && typeof t.label === "string" &&
    t.label.trim() !== "" && typeof t.deviceType === "string" && Array.isArray(t.ports)
  );
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Duplicate key: normalized manufacturer + model (modelNumber, else label). */
export function dedupeKey(t: { manufacturer?: string | null; modelNumber?: string | null; label: string }): string {
  return `${norm(normalizeManufacturer(t.manufacturer))}|${norm(t.modelNumber || t.label)}`;
}

/** The template as it goes into our library: canonical manufacturer, AVAIL category. */
export function normalizeTemplate(t: UpstreamTemplate): UpstreamTemplate {
  const { manufacturer, category: _sourceCategory, ...rest } = t;
  const m = normalizeManufacturer(manufacturer);
  return { ...rest, ...(m && { manufacturer: m }), category: defaultCategoryFor(t.deviceType) };
}

type Row = Record<string, string | number | null>;

const META_UPSERT = `INSERT INTO avail_template_meta (template_id, status, source, upstream_id, lint_level, linted_version, updated_by, updated_at)
  VALUES (@template_id, @status, @source, @upstream_id, @lint_level, @linted_version, @updated_by, datetime('now'))
  ON CONFLICT(template_id) DO UPDATE SET status = excluded.status, source = excluded.source,
    upstream_id = excluded.upstream_id, lint_level = excluded.lint_level, linted_version = excluded.linted_version,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at`;

class DryRun extends Error {}

export function importTemplates(
  sqlite: Database.Database,
  input: unknown[],
  options: ImportOptions = {},
): ImportReport {
  const source = options.source ?? UPSTREAM_SOURCE;
  const updatedBy = options.updatedBy ?? "import";
  const report: ImportReport = {
    source,
    received: input.length,
    invalid: 0,
    duplicates: 0,
    imported: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skippedProtected: 0,
    keptHidden: 0,
    ourVendors: Object.fromEntries(VENDORS.map((v) => [v.name, 0])),
    otherVendors: { templates: 0, manufacturers: 0 },
    noManufacturer: 0,
    noCategory: 0,
    levels: { A: 0, B: 0, FIX: 0 },
    skipped: { noManufacturer: 0, notDecided: 0, scope: 0, genericExists: 0, genericPlan: 0 },
    genericCreated: [],
    dryRun: !!options.dryRun,
  };
  const rules = options.rules ?? new VendorRules();
  const planDeleted = options.planDeleted ?? plannedDeletions();
  const otherManufacturers = new Set<string>();

  // ---- local state
  const local = sqlite.prepare("SELECT * FROM templates").all() as (TemplateRow & Row)[];
  const metaRows = sqlite.prepare("SELECT * FROM avail_template_meta").all() as TemplateMetaRow[];
  const meta = new Map(metaRows.map((m) => [m.template_id, m]));
  const byId = new Map(local.map((r) => [r.id, r]));
  const byUpstreamId = new Map<string, TemplateRow & Row>();
  for (const m of metaRows) {
    const row = byId.get(m.template_id);
    if (row && m.source === source && m.upstream_id) byUpstreamId.set(m.upstream_id, row);
  }
  // manufacturer + model → local row, kept current as rows are written: a row matched by
  // id may take a template whose pair differs from its old content, and a later
  // template with the old pair must not find it there.
  const rowKey = (r: TemplateRow) => dedupeKey({ manufacturer: r.manufacturer, modelNumber: r.model_number, label: r.label });
  const byKey = new Map<string, TemplateRow & Row>();
  for (const r of local) {
    const key = rowKey(r);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const reindex = (before: (TemplateRow & Row) | undefined, after: TemplateRow & Row) => {
    if (before) {
      const old = rowKey(before);
      if (byKey.get(old) === before) byKey.delete(old);
    }
    const key = rowKey(after);
    if (!byKey.has(key)) byKey.set(key, after);
    byId.set(after.id, after);
  };

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).concat("version");
  const insertTemplate = sqlite.prepare(
    `INSERT INTO templates (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  );
  const updateTemplate = sqlite.prepare(
    `UPDATE templates SET ${columns.filter((c) => c !== "id").map((c) => `${c} = @${c}`).join(", ")},
       updated_at = datetime('now') WHERE id = @id`,
  );
  const upsertMeta = sqlite.prepare(META_UPSERT);

  // deviceTypes that already have a Generic template (same rule as apply:vendor-decisions).
  const genericTypes = new Set(local.filter((r) => r.manufacturer === GENERIC_VENDOR).map((r) => r.device_type));

  const seenKeys = new Set<string>();
  const claimed = new Set<string>();

  const run = sqlite.transaction(() => {
    let contentChanged = false;
    input.forEach((raw, index) => {
      if (!isUpstreamTemplate(raw)) {
        report.invalid++;
        return;
      }
      if (planDeleted.has(raw.id)) return void report.skipped.genericPlan++;
      const decision = rules.classify(raw);
      if (decision.kind === "none") return void report.skipped.noManufacturer++;
      if (decision.kind === "drop") return void report.skipped.notDecided++;
      if (decision.kind === "scope") return void report.skipped.scope++;
      let t: UpstreamTemplate;
      if (decision.kind === "generic") {
        if (genericTypes.has(raw.deviceType)) return void report.skipped.genericExists++;
        t = genericTemplate(normalizeTemplate(raw));
        genericTypes.add(raw.deviceType);
        report.genericCreated.push(t.label);
      } else {
        t = { ...normalizeTemplate(raw), manufacturer: decision.manufacturer };
      }
      const key = dedupeKey(t);
      if (seenKeys.has(key)) {
        report.duplicates++;
        return;
      }
      seenKeys.add(key);

      const existing = byUpstreamId.get(raw.id) ?? byId.get(raw.id) ?? byKey.get(key);
      if (existing && claimed.has(existing.id)) {
        // The row already holds this pair (e.g. a verified template matched earlier by id).
        report.duplicates++;
        return;
      }
      if (existing) claimed.add(existing.id);
      const existingStatus: TemplateStatus | undefined = existing ? meta.get(existing.id)?.status : undefined;
      // Written by apply:vendor-decisions or apply:generic-plan: not the source's any more.
      const writtenByDecisions = existing ? WRITTEN_SOURCES.has(meta.get(existing.id)?.source ?? "") : false;
      if (writtenByDecisions || (existingStatus && PROTECTED_STATUSES.includes(existingStatus))) {
        report.skippedProtected++;
        return;
      }

      const level = lintBlock(t).level;
      const id = existing?.id ?? raw.id;
      const row: Row = {
        ...(templateToRow({ ...(t as unknown as Parameters<typeof templateToRow>[0]), id, sortOrder: index }) as Row),
        version: typeof raw.version === "number" ? raw.version : 1,
      };
      const status: TemplateStatus = existingStatus === "hidden" ? "hidden" : "raw";
      const metaRow = {
        template_id: id,
        status,
        source,
        upstream_id: raw.id,
        lint_level: level,
        linted_version: row.version,
        updated_by: updatedBy,
      };

      if (!existing) {
        insertTemplate.run(row);
        reindex(undefined, row as TemplateRow & Row);
        upsertMeta.run(metaRow);
        report.inserted++;
        contentChanged = true;
      } else {
        const rowChanged = columns.some((c) => (existing[c] ?? null) !== (row[c] ?? null));
        const m = meta.get(id);
        const metaChanged =
          !m || m.status !== status || m.source !== source || m.upstream_id !== raw.id || m.lint_level !== level ||
          m.linted_version !== row.version;
        if (rowChanged) {
          updateTemplate.run(row);
          reindex(existing, row as TemplateRow & Row);
          contentChanged = true;
        }
        if (metaChanged) upsertMeta.run(metaRow);
        if (rowChanged || metaChanged) report.updated++;
        else report.unchanged++;
      }
      if (status === "hidden") report.keptHidden++;

      // ---- stats over the imported templates
      report.imported++;
      report.levels[level]++;
      if (!t.category) report.noCategory++;
      if (!t.manufacturer) report.noManufacturer++;
      else {
        const vendor = findVendor(t.manufacturer);
        if (vendor) report.ourVendors[vendor.name]++;
        else {
          report.otherVendors.templates++;
          otherManufacturers.add(t.manufacturer.toLowerCase());
        }
      }
    });
    // Roll the library ETag so clients holding a cached copy refetch.
    if (contentChanged) sqlite.prepare("UPDATE library_meta SET version = version + 1 WHERE id = 1").run();
    if (options.dryRun) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  report.otherVendors.manufacturers = otherManufacturers.size;
  return report;
}

export async function fetchUpstreamTemplates(url: string = DEFAULT_UPSTREAM_URL): Promise<unknown[]> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "easyschematic-self-hosted-import" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`GET ${url}: expected a JSON array of templates`);
  return body;
}

export function formatImportReport(r: ImportReport, origin: string): string {
  const ours = Object.entries(r.ourVendors);
  const oursTotal = ours.reduce((n, [, c]) => n + c, 0);
  const width = Math.max(...ours.map(([name]) => name.length));
  return [
    `Template import: ${origin}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `Received: ${r.received} (invalid ${r.invalid}, manufacturer + model duplicates ${r.duplicates})`,
    `Skipped by vendor decisions: no manufacturer ${r.skipped.noManufacturer}, manufacturer not decided ${r.skipped.notDecided}, outside scope ${r.skipped.scope}, Generic of the type exists ${r.skipped.genericExists}, deleted by the Generic plan ${r.skipped.genericPlan}`,
    `Generic created: ${r.genericCreated.length ? r.genericCreated.join(", ") : "-"}`,
    `Imported: ${r.imported}; new ${r.inserted}, updated ${r.updated}, unchanged ${r.unchanged}`,
    `Not touched (verified/draft, written by vendor decisions): ${r.skippedProtected}; kept hidden: ${r.keptHidden}`,
    ``,
    `AVAIL vendors: ${oursTotal}`,
    ...ours.map(([name, n]) => `  ${name.padEnd(width)}  ${n}`),
    `Other vendors: ${r.otherVendors.templates} (manufacturers: ${r.otherVendors.manufacturers})`,
    `No manufacturer: ${r.noManufacturer}`,
    `No category: ${r.noCategory}`,
    ``,
    `Standard levels: A ${r.levels.A} / B ${r.levels.B} / FIX ${r.levels.FIX}`,
  ].join("\n") + "\n";
}
