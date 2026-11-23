/**
 * AVAIL template status (table avail_template_meta, migration 9001), next to the
 * upstream `templates` table. A template without a meta row is "raw".
 */
import type Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel, type BlockLintResult } from "../../src/avail/blockLint";

export const TEMPLATE_STATUSES = ["verified", "draft", "raw", "hidden"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Statuses an import from outside never overwrites. */
export const PROTECTED_STATUSES: readonly TemplateStatus[] = ["verified", "draft"];

export function isTemplateStatus(v: unknown): v is TemplateStatus {
  return typeof v === "string" && (TEMPLATE_STATUSES as readonly string[]).includes(v);
}

export interface TemplateMeta {
  templateId: string;
  status: TemplateStatus;
  source: string | null;
  upstreamId: string | null;
  lintLevel: BlockLevel | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface TemplateMetaRow {
  template_id: string;
  status: TemplateStatus;
  source: string | null;
  upstream_id: string | null;
  lint_level: BlockLevel | null;
  updated_by: string | null;
  updated_at: string | null;
  linted_version?: number | null;
}

export function metaFromRow(r: TemplateMetaRow): TemplateMeta {
  return {
    templateId: r.template_id,
    status: r.status,
    source: r.source,
    upstreamId: r.upstream_id,
    lintLevel: r.lint_level,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

/** Every template with its status; templates without a meta row come back as raw. */
export const SELECT_META = `SELECT t.id AS template_id, COALESCE(m.status, 'raw') AS status, m.source, m.upstream_id,
       m.lint_level, m.updated_by, m.updated_at
  FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id`;

/** Standard level of a stored template row. */
export function lintRow(row: TemplateRow): BlockLevel {
  return lintBlock(rowToTemplate(row)).level;
}

/** Roll the library ETag (library_meta.version) so clients refetch GET /templates. */
export const BUMP_LIBRARY_VERSION = "UPDATE library_meta SET version = version + 1 WHERE id = 1";

/**
 * Re-lints every template whose lint is missing or older than its current version, and
 * gives templates without a meta row one (status raw). Upstream bumps templates.version
 * on each save, so running this after every write request keeps lint_level current
 * whichever route saved the template. Returns the number of templates re-linted.
 */
export function syncLintLevels(sqlite: Database.Database): number {
  const stale = sqlite
    .prepare(
      `SELECT t.* FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
        WHERE m.template_id IS NULL OR m.lint_level IS NULL OR m.linted_version IS NULL OR m.linted_version <> t.version`,
    )
    .all() as TemplateRow[];
  if (stale.length === 0) return 0;
  const upsert = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at)
     VALUES (?, 'raw', ?, ?, 'lint', datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET lint_level = excluded.lint_level, linted_version = excluded.linted_version`,
  );
  sqlite.transaction(() => {
    for (const row of stale) upsert.run(row.id, lintRow(row), row.version);
  })();
  return stale.length;
}

export async function getTemplateMeta(db: D1Database, templateId: string): Promise<TemplateMeta | null> {
  const row = await db.prepare(`${SELECT_META} WHERE t.id = ?`).bind(templateId).first<TemplateMetaRow>();
  return row ? metaFromRow(row) : null;
}

export async function listTemplateMeta(db: D1Database, status?: TemplateStatus): Promise<TemplateMeta[]> {
  // Same visibility as GET /templates: templates flagged for deletion are left out.
  const where = status ? "WHERE t.flagged_for_deletion = 0 AND COALESCE(m.status, 'raw') = ?" : "WHERE t.flagged_for_deletion = 0";
  const stmt = db.prepare(`${SELECT_META} ${where} ORDER BY t.sort_order, t.label`);
  const { results } = await (status ? stmt.bind(status) : stmt).all<TemplateMetaRow>();
  return results.map(metaFromRow);
}

export type SetStatusResult =
  | { ok: true; meta: TemplateMeta }
  | { ok: false; reason: "not_found" }
  /** verified needs standard level A; lint carries the errors and warnings that block it. */
  | { ok: false; reason: "not_level_a"; lint: BlockLintResult };

/**
 * Sets the status of an existing template and re-lints it. Keeps source/upstream_id.
 * verified is refused unless the template is at level A. Rolls the library ETag:
 * GET /templates is filtered by status.
 */
export async function setTemplateStatus(
  db: D1Database,
  templateId: string,
  status: TemplateStatus,
  updatedBy: string,
): Promise<SetStatusResult> {
  const row = await db.prepare("SELECT * FROM templates WHERE id = ?").bind(templateId).first<TemplateRow>();
  if (!row) return { ok: false, reason: "not_found" };
  const lint = lintBlock(rowToTemplate(row));
  if (status === "verified" && lint.level !== "A") return { ok: false, reason: "not_level_a", lint };
  await db.batch([
    db
      .prepare(
        `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(template_id) DO UPDATE SET status = excluded.status, lint_level = excluded.lint_level,
           linted_version = excluded.linted_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(templateId, status, lint.level, row.version, updatedBy),
    db.prepare(BUMP_LIBRARY_VERSION),
  ]);
  const meta = await getTemplateMeta(db, templateId);
  return { ok: true, meta: meta! };
}
