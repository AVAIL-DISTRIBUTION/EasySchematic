/**
 * import:catalog — loads the product catalog (library/catalog/<vendor>/*.json, step 1.9) into
 * the database. Only files at the minimum level or above are loaded (options.minLevel, CLI
 * --min-level, default B: A and B go in as draft); FIX files wait in the catalog.
 *
 * Per loaded file:
 *   - match: the template loaded from this file before (meta source "avail-catalog" +
 *     upstream_id = file id), else the template with the file's id, else the template with
 *     the same manufacturer + part number (modelNumber, also _avail.altPartNumber);
 *   - curated library (library/avail: meta source "avail-library", its ids, its manufacturer +
 *     part number) → not touched, library/avail is the more authoritative source;
 *   - deleted for good (docs/avail/deleted-templates.json: by id, or vendor + partNumber) → skipped;
 *   - file unchanged since the last load (same sha-256 in meta.source_hash) → not touched;
 *   - otherwise found → updated, not found → created. Status: new / raw / draft → draft;
 *     hidden stays hidden; verified stays verified when the data did not change and the file
 *     is at level A, else draft with status_reason "catalog file changed" / "level B".
 * The template gets the file without `_avail` and `rackForm`; those go to
 * avail_template_meta.catalog (migration 9005) with the file path.
 *
 * Superseded: other templates of a model the catalog loaded (colour variant or base model, matched
 * by label without the variant) — raw ones become hidden with status_reason "superseded by catalog
 * (<file>)", verified and draft are only listed in the report. Rows any catalog file matched by part
 * number are never superseded (their own file may still be below A).
 *
 * Entries of deleted-templates.json with a partNumber are also removed from the database when
 * still there (by id, vendor + part number or vendor + model label), curated templates excepted.
 *
 * One transaction; idempotent: a second run with the same files changes nothing.
 */
import type Database from "better-sqlite3";
import { templateToRow, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { modelKey, type CatalogTemplate } from "../../src/avail/catalogPorts";
import { normalizeManufacturer } from "../../src/avail/library";
import type { CatalogFileText } from "./catalogFiles";
import { AVAIL_LIBRARY_SOURCE, fileHash } from "./importAvail";
import { BUMP_LIBRARY_VERSION, type TemplateMetaRow, type TemplateStatus } from "./templateMeta";
import { DELETED_TEMPLATES, type DeletedTemplatesFile } from "./vendorResponses";

export const AVAIL_CATALOG_SOURCE = "avail-catalog";

export type ImportCatalogAction = "inserted" | "updated" | "unchanged" | "below-min" | "curated" | "deleted" | "duplicate" | "invalid";

export interface ImportCatalogRow {
  file: string;
  /** Template id in the database (the matched row's, else the file's). */
  id: string;
  label: string;
  level: BlockLevel;
  action: ImportCatalogAction;
  status?: TemplateStatus;
  previousStatus?: TemplateStatus | null;
  note?: string;
}

export interface ImportCatalogReport {
  dryRun: boolean;
  minLevel: "A" | "B";
  /** Files in the database after the run (inserted, updated, unchanged), by level. */
  loadedByLevel: Record<"A" | "B", number>;
  rows: ImportCatalogRow[];
  counts: Record<ImportCatalogAction, number>;
  /** Removed from the database by deleted-templates.json entries with a partNumber. */
  removed: { id: string; label: string; entry: string }[];
  /**
   * Other templates of a model the catalog brought (colour variant or base model, "Desono C-IC6"
   * for "Desono C-IC6 Black"): raw ones are hidden ("superseded by catalog"), verified and draft
   * are only listed.
   */
  superseded: { id: string; label: string; status: TemplateStatus; action: "hidden" | "listed"; by: string }[];
}

export const SUPERSEDED_REASON = "superseded by catalog";

export interface ImportCatalogOptions {
  dryRun?: boolean;
  /** Lowest level loaded into the database (default B: A and B load, FIX stays in the catalog). */
  minLevel?: "A" | "B";
  updatedBy?: string;
  /** Templates of library/avail (id, manufacturer, modelNumber): never touched. */
  curated?: { id: string; manufacturer?: string; modelNumber?: string }[];
  deletedList?: DeletedTemplatesFile;
}

type Row = TemplateRow & Record<string, string | number | null>;
type Template = Parameters<typeof templateToRow>[0];

class DryRun extends Error {}

const LEVEL_RANK: Record<BlockLevel, number> = { A: 0, B: 1, FIX: 2 };

/** Parses --min-level: "A" or "B" (FIX is never loaded). */
export function parseMinLevel(v: string | undefined): "A" | "B" {
  const x = (v ?? "B").toUpperCase();
  if (x !== "A" && x !== "B") throw new Error(`--min-level must be A or B, got "${v}"`);
  return x;
}

const norm = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").toLowerCase() : "");

/** Manufacturer + part number key: "extron|60-1885-52". */
export function partKey(manufacturer: unknown, partNumber: unknown): string {
  const n = norm(partNumber);
  if (!n) return "";
  return `${norm(normalizeManufacturer(typeof manufacturer === "string" ? manufacturer : undefined) ?? manufacturer)}|${n}`;
}

function isCatalogTemplate(v: unknown): v is CatalogTemplate {
  const t = v as CatalogTemplate;
  return (
    !!t && typeof t === "object" && typeof t.id === "string" && t.id !== "" && typeof t.label === "string" &&
    typeof t.deviceType === "string" && Array.isArray(t.ports)
  );
}

/** The template as stored (no _avail, no rackForm) and the meta catalog JSON. */
export function splitCatalogTemplate(t: CatalogTemplate, file: string): { template: Template & { id: string }; catalog: string } {
  const { _avail, rackForm, ...rest } = t;
  const catalog = { file, ...(rackForm !== undefined ? { rackForm } : {}), ...(_avail ?? {}) };
  return { template: rest as unknown as Template & { id: string }, catalog: JSON.stringify(catalog) };
}

export function importCatalog(sqlite: Database.Database, files: readonly CatalogFileText[], options: ImportCatalogOptions = {}): ImportCatalogReport {
  const updatedBy = options.updatedBy ?? "import:catalog";
  const deletedList = options.deletedList ?? DELETED_TEMPLATES;
  const counts = { inserted: 0, updated: 0, unchanged: 0, "below-min": 0, curated: 0, deleted: 0, duplicate: 0, invalid: 0 };
  const minLevel = options.minLevel ?? "B";
  const report: ImportCatalogReport = { dryRun: !!options.dryRun, minLevel, loadedByLevel: { A: 0, B: 0 }, rows: [], counts, removed: [], superseded: [] };

  const curatedIds = new Set((options.curated ?? []).map((c) => c.id));
  const curatedKeys = new Set((options.curated ?? []).map((c) => partKey(c.manufacturer, c.modelNumber)).filter(Boolean));
  const deletedIds = new Set(deletedList.templates.map((d) => d.id));
  const withPart = deletedList.templates.filter((d): d is typeof d & { partNumber: string } => typeof (d as { partNumber?: unknown }).partNumber === "string");
  const deletedKeys = new Set(withPart.map((d) => partKey(d.vendor, d.partNumber)));

  const getMeta = () => new Map((sqlite.prepare("SELECT * FROM avail_template_meta").all() as (TemplateMetaRow & { catalog?: string | null })[]).map((m) => [m.template_id, m]));

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] }));
  const insertTemplate = sqlite.prepare(`INSERT INTO templates (${columns.join(", ")}, version) VALUES (${columns.map((c) => `@${c}`).join(", ")}, 1)`);
  const updateTemplate = sqlite.prepare(
    `UPDATE templates SET ${columns.filter((c) => c !== "id").map((c) => `${c} = @${c}`).join(", ")},
       version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const versionOf = sqlite.prepare("SELECT version FROM templates WHERE id = ?");
  const upsertMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, source, upstream_id, lint_level, linted_version, updated_by, updated_at,
       status_reason, status_changed_at, source_hash, catalog)
     VALUES (@template_id, @status, @source, @upstream_id, @lint_level, @linted_version, @updated_by, datetime('now'),
       @status_reason, CASE WHEN @status_changed = 1 THEN datetime('now') END, @source_hash, @catalog)
     ON CONFLICT(template_id) DO UPDATE SET status = excluded.status, source = excluded.source,
       upstream_id = excluded.upstream_id, lint_level = excluded.lint_level, linted_version = excluded.linted_version,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at, source_hash = excluded.source_hash,
       catalog = excluded.catalog,
       status_reason = CASE WHEN @status_changed = 1 THEN excluded.status_reason ELSE avail_template_meta.status_reason END,
       status_changed_at = CASE WHEN @status_changed = 1 THEN excluded.status_changed_at ELSE avail_template_meta.status_changed_at END`,
  );

  const run = sqlite.transaction(() => {
    let changed = false;

    // deleted-templates.json entries with a part number: remove what is still in the database.
    if (withPart.length) {
      const meta = getMeta();
      const all = sqlite.prepare("SELECT id, label, manufacturer, model_number FROM templates").all() as Pick<TemplateRow, "id" | "label" | "manufacturer" | "model_number">[];
      for (const d of withPart) {
        const key = partKey(d.vendor, d.partNumber);
        const label = norm(`${d.vendor} ${d.model}`);
        for (const r of all) {
          const hit = r.id === d.id || partKey(r.manufacturer, r.model_number) === key || (norm(r.manufacturer) === norm(d.vendor) && norm(r.label) === label);
          if (!hit) continue;
          if (curatedIds.has(r.id) || meta.get(r.id)?.source === AVAIL_LIBRARY_SOURCE) continue;
          sqlite.prepare("DELETE FROM avail_template_meta WHERE template_id = ?").run(r.id);
          sqlite.prepare("DELETE FROM templates WHERE id = ?").run(r.id);
          report.removed.push({ id: r.id, label: r.label, entry: `${d.vendor} ${d.model} (${d.partNumber})` });
          changed = true;
        }
      }
    }

    const meta = getMeta();
    const local = sqlite.prepare("SELECT * FROM templates").all() as Row[];
    const byId = new Map(local.map((r) => [r.id, r]));
    const bySourceId = new Map<string, Row>();
    for (const m of meta.values()) {
      const row = byId.get(m.template_id);
      if (row && m.source === AVAIL_CATALOG_SOURCE && m.upstream_id) bySourceId.set(m.upstream_id, row);
    }
    // Several rows with one part number: the best status first (verified > draft > raw > hidden).
    const rank: Record<string, number> = { verified: 0, draft: 1, raw: 2, hidden: 3 };
    const byPart = new Map<string, Row>();
    for (const r of [...local].sort((a, b) => (rank[meta.get(a.id)?.status ?? "raw"] - rank[meta.get(b.id)?.status ?? "raw"]) || a.id.localeCompare(b.id))) {
      const k = partKey(r.manufacturer, r.model_number);
      if (k && !byPart.has(k)) byPart.set(k, r);
    }
    const claimed = new Map<string, string>();
    /** Rows a catalog file matched (loaded or not): never superseded by another file. */
    const matchedByFile = new Set<string>();
    /** Model key → catalog file loaded into the database for it. */
    const loadedModels = new Map<string, string>();

    files.forEach((file, index) => {
      const t = file.template;
      if (!isCatalogTemplate(t)) {
        counts.invalid++;
        report.rows.push({ file: file.file, id: "?", label: "?", level: "FIX", action: "invalid", note: "not a template (id, label, deviceType, ports)" });
        return;
      }
      const level = lintBlock(t).level;
      const parts = [t.modelNumber, t._avail?.altPartNumber].map((p) => partKey(t.manufacturer, p)).filter(Boolean);
      const existing = bySourceId.get(t.id) ?? byId.get(t.id) ?? parts.map((k) => byPart.get(k)).find(Boolean);
      const m = existing ? meta.get(existing.id) : undefined;
      const id = existing?.id ?? t.id;
      if (existing) matchedByFile.add(existing.id);
      const base = { file: file.file, id, label: t.label, level };
      const loaded = () => {
        const k = modelKey(t.label, t.manufacturer);
        if (k && !loadedModels.has(k)) loadedModels.set(k, file.file);
      };
      const skip = (action: ImportCatalogAction, note: string) => {
        counts[action]++;
        report.rows.push({ ...base, action, ...(m ? { status: m.status } : {}), note });
      };

      if (LEVEL_RANK[level] > LEVEL_RANK[minLevel]) return skip("below-min", `level ${level}: stays in the catalog (minimum ${minLevel})`);
      if (curatedIds.has(id) || m?.source === AVAIL_LIBRARY_SOURCE || parts.some((k) => curatedKeys.has(k))) {
        return skip("curated", "library/avail has this product");
      }
      if (deletedIds.has(t.id) || deletedIds.has(id) || parts.some((k) => deletedKeys.has(k))) {
        return skip("deleted", "docs/avail/deleted-templates.json");
      }
      const prev = claimed.get(id);
      if (prev) return skip("duplicate", `same template as ${prev}`);
      claimed.set(id, file.file);

      const hash = fileHash(file.text);
      if (existing && m?.source === AVAIL_CATALOG_SOURCE && m.upstream_id === t.id && m.source_hash === hash) {
        counts.unchanged++;
        report.rows.push({ ...base, action: "unchanged", status: m.status });
        loaded();
        return;
      }

      const { template, catalog } = splitCatalogTemplate(t, file.file);
      const sortOrder = existing ? existing.sort_order : 200000 + index;
      const row = templateToRow({ ...template, id, sortOrder }) as Row;
      const dataChanged = !existing || columns.some((c) => (existing[c] ?? null) !== (row[c] ?? null));
      const before: TemplateStatus | null = existing ? (m?.status ?? "raw") : null;
      let status: TemplateStatus = "draft";
      let reason: string | null = null;
      if (before === "hidden") status = "hidden";
      else if (before === "verified" && !dataChanged && level === "A") status = "verified";
      else if (before === "verified" && dataChanged) reason = `Catalog file changed (library/catalog/${file.file}); verify again`;
      else if (before === "verified") reason = `Catalog file is at level ${level} (library/catalog/${file.file}); verified needs A`;

      if (!existing) insertTemplate.run(row);
      else if (dataChanged) updateTemplate.run(row);
      const version = (versionOf.get(id) as { version: number }).version;
      upsertMeta.run({
        template_id: id,
        status,
        source: AVAIL_CATALOG_SOURCE,
        upstream_id: t.id,
        lint_level: level,
        linted_version: version,
        updated_by: updatedBy,
        status_reason: reason,
        status_changed: before !== status ? 1 : 0,
        source_hash: hash,
        catalog,
      });
      changed = true;
      loaded();
      const action = existing ? "updated" : "inserted";
      counts[action]++;
      report.rows.push({
        ...base,
        action,
        status,
        ...(before !== status ? { previousStatus: before } : {}),
        ...(reason ? { note: reason } : existing && !dataChanged ? { note: "data already matched the file" } : {}),
      });
    });

    // Superseded: other templates of a loaded model. Raw → hidden; verified / draft → listed.
    const hideMeta = sqlite.prepare(
      `INSERT INTO avail_template_meta (template_id, status, updated_by, updated_at, status_reason, status_changed_at)
       VALUES (@id, 'hidden', @by, datetime('now'), @reason, datetime('now'))
       ON CONFLICT(template_id) DO UPDATE SET status = 'hidden', updated_by = excluded.updated_by, updated_at = excluded.updated_at,
         status_reason = excluded.status_reason, status_changed_at = excluded.status_changed_at`,
    );
    const metaNow = getMeta();
    for (const r of local) {
      if (matchedByFile.has(r.id) || curatedIds.has(r.id)) continue;
      const mr = metaNow.get(r.id);
      if (mr?.source === AVAIL_CATALOG_SOURCE || mr?.source === AVAIL_LIBRARY_SOURCE) continue;
      const status: TemplateStatus = mr?.status ?? "raw";
      if (status === "hidden") continue;
      const keys = [modelKey(r.label, r.manufacturer), modelKey(r.model_number, r.manufacturer)];
      const by = keys.map((k) => (k ? loadedModels.get(k) : undefined)).find(Boolean);
      if (!by) continue;
      if (status === "raw") {
        hideMeta.run({ id: r.id, by: updatedBy, reason: `${SUPERSEDED_REASON} (library/catalog/${by})` });
        changed = true;
        report.superseded.push({ id: r.id, label: r.label, status, action: "hidden", by });
      } else report.superseded.push({ id: r.id, label: r.label, status, action: "listed", by });
    }

    for (const x of report.rows) {
      if ((x.action === "inserted" || x.action === "updated" || x.action === "unchanged") && (x.level === "A" || x.level === "B")) report.loadedByLevel[x.level]++;
    }
    if (changed) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
    if (options.dryRun) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

export function formatImportCatalogReport(r: ImportCatalogReport, dir: string, verbose = false): string {
  const c = r.counts;
  const lines = [
    `Catalog import: ${dir}${r.dryRun ? " (dry run, nothing written)" : ""}; minimum level ${r.minLevel}`,
    `In the database from the catalog: A ${r.loadedByLevel.A}, B ${r.loadedByLevel.B}`,
    `Files: ${r.rows.length}; inserted ${c.inserted}, updated ${c.updated}, unchanged ${c.unchanged}; ` +
      `skipped: below level ${r.minLevel} ${c["below-min"]}, curated ${c.curated}, deleted ${c.deleted}, duplicate ${c.duplicate}, invalid ${c.invalid}`,
  ];
  const vendors = [...new Set(r.rows.map((x) => x.file.split("/")[0]))].sort();
  for (const v of vendors) {
    const rows = r.rows.filter((x) => x.file.startsWith(`${v}/`));
    const n = (a: ImportCatalogAction) => rows.filter((x) => x.action === a).length;
    lines.push(`  ${v.padEnd(10)} inserted ${n("inserted")}, updated ${n("updated")}, unchanged ${n("unchanged")}, below ${r.minLevel} ${n("below-min")}, curated ${n("curated")}, deleted ${n("deleted")}`);
  }
  if (r.removed.length) {
    lines.push("", "Removed from the database (docs/avail/deleted-templates.json):");
    for (const x of r.removed) lines.push(`  ${x.id} ${x.label} — ${x.entry}`);
  }
  const hidden = r.superseded.filter((x) => x.action === "hidden");
  const listed = r.superseded.filter((x) => x.action === "listed");
  if (hidden.length) {
    lines.push("", `Hidden, superseded by catalog (raw): ${hidden.length}`);
    for (const x of hidden) lines.push(`  ${x.id} ${x.label} — ${x.by}`);
  }
  if (listed.length) {
    lines.push("", `Same model as a catalog file, left as is (verified / draft): ${listed.length}`);
    for (const x of listed) lines.push(`  ${x.status.padEnd(8)} ${x.id} ${x.label} — ${x.by}`);
  }
  lines.push("");
  for (const x of r.rows) {
    if (!verbose && (x.action === "below-min" || x.action === "unchanged")) continue;
    const status = x.status ? (x.previousStatus !== undefined ? `${x.previousStatus ?? "new"} → ${x.status}` : x.status) : "";
    lines.push(`  ${x.action.padEnd(9)} ${x.level.padEnd(3)} ${status.padEnd(18)} ${x.file}${x.note ? ` — ${x.note}` : ""}`);
  }
  return lines.join("\n") + "\n";
}
