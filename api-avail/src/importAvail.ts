/**
 * import:avail — loads the curated AVAIL library from the repository (library/avail/*.json,
 * see src/avail/libraryFiles.ts) into the database.
 *
 * Per file:
 *   - match: the template loaded from this file before (meta source "avail-library" +
 *     upstream_id = file id), else the template with the file's id, else the template
 *     with the same manufacturer + model;
 *   - file unchanged since the last load (same sha-256 in meta.source_hash) → not touched,
 *     whatever happened to the template in the editor since;
 *   - otherwise the template data is replaced by the file. Status:
 *       new / raw / draft  → draft (verified is set only by a person in the editor);
 *       hidden             → stays hidden;
 *       verified           → stays verified when the data did not actually change,
 *                            else draft with status_reason "library file changed".
 * library/hidden.json: listed templates that exist become hidden (reason recorded); a
 * template it hid earlier and no longer lists goes back to raw.
 *
 * Idempotent: a second run with the same files changes nothing.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { templateToRow, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { productKey, type HiddenEntry, type LibraryEntry } from "../../src/avail/libraryFiles";
import { BUMP_LIBRARY_VERSION, type TemplateMetaRow, type TemplateStatus } from "./templateMeta";

export const AVAIL_LIBRARY_SOURCE = "avail-library";
/** status_reason of templates hidden by library/hidden.json. */
export const HIDDEN_REASON_PREFIX = "library/hidden.json:";

export interface AvailLibraryFile extends LibraryEntry {
  /** Exact file content: its sha-256 decides whether the file changed since the last load. */
  text: string;
}

export interface ImportAvailRow {
  file: string;
  id: string;
  label: string;
  level: BlockLevel;
  action: "inserted" | "updated" | "unchanged" | "invalid";
  status?: TemplateStatus;
  /** Status before the run, when it changed. */
  previousStatus?: TemplateStatus | null;
  note?: string;
}

export interface ImportAvailReport {
  dryRun: boolean;
  rows: ImportAvailRow[];
  hidden: { id: string; action: "hidden" | "already-hidden" | "missing" | "unhidden" }[];
  inserted: number;
  updated: number;
  unchanged: number;
  invalid: number;
}

export interface ImportAvailOptions {
  dryRun?: boolean;
  /** Written to avail_template_meta.updated_by. */
  updatedBy?: string;
  hidden?: HiddenEntry[];
}

export function fileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Row = Record<string, string | number | null>;
type Template = Parameters<typeof templateToRow>[0];

class DryRun extends Error {}

function isTemplate(v: unknown): v is Template & { id: string } {
  const t = v as Template;
  return (
    !!t && typeof t === "object" && typeof t.id === "string" && t.id !== "" && typeof t.label === "string" &&
    typeof t.deviceType === "string" && Array.isArray(t.ports)
  );
}

export function importAvailLibrary(
  sqlite: Database.Database,
  files: readonly AvailLibraryFile[],
  options: ImportAvailOptions = {},
): ImportAvailReport {
  const updatedBy = options.updatedBy ?? "import:avail";
  const report: ImportAvailReport = { dryRun: !!options.dryRun, rows: [], hidden: [], inserted: 0, updated: 0, unchanged: 0, invalid: 0 };

  const local = sqlite.prepare("SELECT * FROM templates").all() as (TemplateRow & Row)[];
  const metaRows = sqlite.prepare("SELECT * FROM avail_template_meta").all() as TemplateMetaRow[];
  const meta = new Map(metaRows.map((m) => [m.template_id, m]));
  const byId = new Map(local.map((r) => [r.id, r]));
  const bySourceId = new Map<string, TemplateRow & Row>();
  for (const m of metaRows) {
    const row = byId.get(m.template_id);
    if (row && m.source === AVAIL_LIBRARY_SOURCE && m.upstream_id) bySourceId.set(m.upstream_id, row);
  }
  const byKey = new Map<string, TemplateRow & Row>();
  for (const r of local) {
    const key = productKey({ manufacturer: r.manufacturer, modelNumber: r.model_number, label: r.label });
    if (!byKey.has(key)) byKey.set(key, r);
  }

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] }));
  const insertTemplate = sqlite.prepare(
    `INSERT INTO templates (${columns.join(", ")}, version) VALUES (${columns.map((c) => `@${c}`).join(", ")}, 1)`,
  );
  const updateTemplate = sqlite.prepare(
    `UPDATE templates SET ${columns.filter((c) => c !== "id").map((c) => `${c} = @${c}`).join(", ")},
       version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const versionOf = sqlite.prepare("SELECT version FROM templates WHERE id = ?");
  const upsertMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, source, upstream_id, lint_level, linted_version, updated_by, updated_at,
       status_reason, status_changed_at, source_hash)
     VALUES (@template_id, @status, @source, @upstream_id, @lint_level, @linted_version, @updated_by, datetime('now'),
       @status_reason, CASE WHEN @status_changed = 1 THEN datetime('now') END, @source_hash)
     ON CONFLICT(template_id) DO UPDATE SET status = excluded.status, source = excluded.source,
       upstream_id = excluded.upstream_id, lint_level = excluded.lint_level, linted_version = excluded.linted_version,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at, source_hash = excluded.source_hash,
       status_reason = CASE WHEN @status_changed = 1 THEN excluded.status_reason ELSE avail_template_meta.status_reason END,
       status_changed_at = CASE WHEN @status_changed = 1 THEN excluded.status_changed_at ELSE avail_template_meta.status_changed_at END`,
  );
  const unhideMeta = sqlite.prepare(
    `UPDATE avail_template_meta SET status = 'raw', updated_by = ?, updated_at = datetime('now'), status_reason = ?,
       status_changed_at = datetime('now') WHERE template_id = ?`,
  );
  const hideMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, updated_by, updated_at, status_reason, status_changed_at)
     VALUES (?, 'hidden', ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET status = 'hidden', updated_by = excluded.updated_by, updated_at = excluded.updated_at,
       status_reason = excluded.status_reason, status_changed_at = excluded.status_changed_at`,
  );

  const run = sqlite.transaction(() => {
    let changed = false;
    files.forEach((file, index) => {
      const t = file.template;
      if (!isTemplate(t)) {
        report.invalid++;
        report.rows.push({ file: file.file, id: "?", label: "?", level: "FIX", action: "invalid", note: "not a template (id, label, deviceType, ports)" });
        return;
      }
      const hash = fileHash(file.text);
      const level = lintBlock(t).level;
      const existing = bySourceId.get(t.id) ?? byId.get(t.id) ?? byKey.get(productKey(t));
      const m = existing ? meta.get(existing.id) : undefined;
      const id = existing?.id ?? t.id;
      const base = { file: file.file, id, label: t.label, level };

      if (existing && m?.source === AVAIL_LIBRARY_SOURCE && m.upstream_id === t.id && m.source_hash === hash) {
        report.unchanged++;
        report.rows.push({ ...base, action: "unchanged", status: m.status });
        return;
      }

      const sortOrder = existing ? existing.sort_order : 100000 + index;
      const row = templateToRow({ ...t, id, sortOrder }) as Row;
      const dataChanged = !existing || columns.some((c) => (existing[c] ?? null) !== (row[c] ?? null));
      const before: TemplateStatus | null = existing ? (m?.status ?? "raw") : null;
      let status: TemplateStatus = "draft";
      let reason: string | null = null;
      if (before === "hidden") status = "hidden";
      else if (before === "verified" && !dataChanged) status = "verified";
      else if (before === "verified") reason = `Library file changed (library/avail/${file.file}); verify again`;

      if (!existing) insertTemplate.run(row);
      else if (dataChanged) updateTemplate.run(row);
      const version = (versionOf.get(id) as { version: number }).version;
      upsertMeta.run({
        template_id: id,
        status,
        source: AVAIL_LIBRARY_SOURCE,
        upstream_id: t.id,
        lint_level: level,
        linted_version: version,
        updated_by: updatedBy,
        status_reason: reason,
        status_changed: before !== status ? 1 : 0,
        source_hash: hash,
      });
      if (dataChanged || before !== status) changed = true;
      if (existing) report.updated++;
      else report.inserted++;
      report.rows.push({
        ...base,
        action: existing ? "updated" : "inserted",
        status,
        ...(before !== status ? { previousStatus: before } : {}),
        ...(reason ? { note: reason } : !dataChanged ? { note: "data already matched the file" } : {}),
      });
    });

    for (const h of options.hidden ?? []) {
      const exists = sqlite.prepare("SELECT 1 FROM templates WHERE id = ?").get(h.id);
      if (!exists) {
        report.hidden.push({ id: h.id, action: "missing" });
        continue;
      }
      const cur = sqlite.prepare("SELECT status FROM avail_template_meta WHERE template_id = ?").get(h.id) as { status: TemplateStatus } | undefined;
      if (cur?.status === "hidden") {
        report.hidden.push({ id: h.id, action: "already-hidden" });
        continue;
      }
      hideMeta.run(h.id, updatedBy, `${HIDDEN_REASON_PREFIX} ${h.reason}`);
      report.hidden.push({ id: h.id, action: "hidden" });
      changed = true;
    }

    // Hidden earlier by library/hidden.json but no longer listed: back to raw (unverified).
    const listed = new Set((options.hidden ?? []).map((h) => h.id));
    const stale = sqlite
      .prepare(`SELECT template_id FROM avail_template_meta WHERE status = 'hidden' AND status_reason LIKE '${HIDDEN_REASON_PREFIX}%'`)
      .all() as { template_id: string }[];
    for (const { template_id } of stale) {
      if (listed.has(template_id)) continue;
      unhideMeta.run(updatedBy, `${HIDDEN_REASON_PREFIX} no longer listed`, template_id);
      report.hidden.push({ id: template_id, action: "unhidden" });
      changed = true;
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

export function formatImportAvailReport(r: ImportAvailReport, dir: string): string {
  const lines = [
    `Curated library import: ${dir}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `Files: ${r.rows.length}; inserted ${r.inserted}, updated ${r.updated}, unchanged ${r.unchanged}, invalid ${r.invalid}`,
    "",
  ];
  for (const x of r.rows) {
    const status = x.status ? (x.previousStatus !== undefined ? `${x.previousStatus ?? "new"} → ${x.status}` : x.status) : "";
    lines.push(`  ${x.action.padEnd(9)} ${x.level.padEnd(3)} ${status.padEnd(18)} ${x.file}${x.note ? ` — ${x.note}` : ""}`);
  }
  if (r.hidden.length) {
    lines.push("", "Hidden list (library/hidden.json):");
    for (const h of r.hidden) lines.push(`  ${h.action.padEnd(14)} ${h.id}`);
  }
  return lines.join("\n") + "\n";
}
