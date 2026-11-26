/**
 * AVAIL template status (table avail_template_meta, migrations 9001–9003), next to the
 * upstream `templates` table. A template without a meta row is "raw".
 *
 * Status rule kept on every save: a verified template whose standard level falls below
 * A is moved to draft automatically, with the reason and time in status_reason /
 * status_changed_at (syncLintLevels). verified itself is only ever set by a person.
 */
import type Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel, type BlockLintResult } from "../../src/avail/blockLint";
import { slotLibraryContext, type SlotLibraryContext } from "../../src/avail/slotFamilies";
import { SYSTEM_ACTOR, writeAudit, writeAuditD1, type AuditEntry } from "./audit";
import { dropStaleNotDuplicates } from "./notDuplicates";

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
  /** Why the status was last changed automatically; null after a manual change. */
  statusReason: string | null;
  statusChangedAt: string | null;
  /** How the template was last approved: in the Review card or with bulk Approve. */
  approvedVia: ApprovalMethod | null;
  approvedAt: string | null;
  /** Who last approved it (email, "admin-token" or "approve-catalog"); migration 9008. */
  approvedBy: string | null;
}

export type ApprovalMethod = "review" | "bulk" | "bulk-source";

export interface TemplateMetaRow {
  template_id: string;
  status: TemplateStatus;
  source: string | null;
  upstream_id: string | null;
  lint_level: BlockLevel | null;
  updated_by: string | null;
  updated_at: string | null;
  linted_version?: number | null;
  status_reason?: string | null;
  status_changed_at?: string | null;
  source_hash?: string | null;
  approved_via?: ApprovalMethod | null;
  approved_at?: string | null;
  approved_by?: string | null;
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
    statusReason: r.status_reason ?? null,
    statusChangedAt: r.status_changed_at ?? null,
    approvedVia: r.approved_via ?? null,
    approvedAt: r.approved_at ?? null,
    approvedBy: r.approved_by ?? null,
  };
}

/** Every template with its status; templates without a meta row come back as raw. */
export const SELECT_META = `SELECT t.id AS template_id, COALESCE(m.status, 'raw') AS status, m.source, m.upstream_id,
       m.lint_level, m.updated_by, m.updated_at, m.status_reason, m.status_changed_at,
       m.approved_via, m.approved_at, m.approved_by
  FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id`;

/** Slots and cards of the whole library, for the linter's slot checks. */
export function slotContextOfRows(rows: { slot_family: string | null; slots: string | null }[]): SlotLibraryContext {
  return slotLibraryContext(
    rows.map((r) => ({ slotFamily: r.slot_family, slots: r.slots ? (JSON.parse(r.slots) as { slotFamily?: string; slotFamilies?: string[] }[]) : null })),
  );
}

const SLOT_ROWS = "SELECT slot_family, slots FROM templates WHERE flagged_for_deletion = 0";

export function slotContext(sqlite: Database.Database): SlotLibraryContext {
  return slotContextOfRows(sqlite.prepare(SLOT_ROWS).all() as { slot_family: string | null; slots: string | null }[]);
}

/**
 * A stored template as the linter sees it: the template, plus what import:catalog moved to
 * avail_template_meta.catalog and the standard reads — the catalog description (room-mounted by
 * name, 3.2) and rackForm. With it a template lints in the database as its catalog file does.
 */
export function blockOfRow(row: TemplateRow, catalogJson?: string | null): object {
  const t = rowToTemplate(row) as unknown as Record<string, unknown>;
  if (!catalogJson) return t;
  try {
    const c = JSON.parse(catalogJson) as { description?: unknown; rackForm?: unknown };
    return {
      ...t,
      ...(typeof c.rackForm === "string" ? { rackForm: c.rackForm } : {}),
      ...(typeof c.description === "string" ? { _avail: { description: c.description } } : {}),
    };
  } catch {
    return t;
  }
}

/** Standard level of a stored template row (with the library's slot context and its catalog meta when given). */
export function lintRow(row: TemplateRow & { avail_catalog?: string | null }, library?: SlotLibraryContext): BlockLevel {
  return lintBlock(blockOfRow(row, row.avail_catalog), library).level;
}

/**
 * Re-lints every template against the current library (slot context changes when cards or
 * chassis are added or removed) and stores lint_level. Statuses are not changed: this is not
 * a save. Returns how many levels changed.
 */
export function relintAll(sqlite: Database.Database): number {
  const ctx = slotContext(sqlite);
  const rows = sqlite
    .prepare("SELECT t.*, m.lint_level AS avail_level, m.catalog AS avail_catalog FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id")
    .all() as (TemplateRow & { avail_level: BlockLevel | null })[];
  const upsert = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at)
     VALUES (?, 'raw', ?, ?, 'lint', datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET lint_level = excluded.lint_level, linted_version = excluded.linted_version`,
  );
  let changed = 0;
  sqlite.transaction(() => {
    for (const row of rows) {
      const level = lintRow(row, ctx);
      if (level !== row.avail_level) {
        upsert.run(row.id, level, row.version);
        changed++;
      }
    }
  })();
  return changed;
}

/** Roll the library ETag (library_meta.version) so clients refetch GET /templates. */
export const BUMP_LIBRARY_VERSION = "UPDATE library_meta SET version = version + 1 WHERE id = 1";

/** status_reason of a verified template moved to draft because its level fell below A. */
export function demotionReason(level: BlockLevel, version: number): string {
  return `Standard level ${level} after save (version ${version}); verified needs level A`;
}

export interface SyncResult {
  /** Templates re-linted. */
  linted: number;
  /** Verified templates moved to draft because their level fell below A. */
  demoted: string[];
}

/**
 * Re-lints every template whose lint is missing or older than its current version, and
 * gives templates without a meta row one (status raw). Upstream bumps templates.version
 * on each save, so running this after every write request keeps lint_level current
 * whichever route saved the template.
 *
 * A verified template that is no longer at level A becomes draft, with the reason and
 * time recorded; the library ETag is rolled when that happens (the library is filtered
 * by status).
 */
export function syncLintLevels(sqlite: Database.Database): SyncResult {
  // "Not duplicates" decisions whose template changed its manufacturer or part number (or is gone).
  dropStaleNotDuplicates(sqlite);
  const stale = sqlite
    .prepare(
      `SELECT t.*, m.status AS avail_status, m.catalog AS avail_catalog FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
        WHERE m.template_id IS NULL OR m.lint_level IS NULL OR m.linted_version IS NULL OR m.linted_version <> t.version`,
    )
    .all() as (TemplateRow & { avail_status: TemplateStatus | null })[];
  if (stale.length === 0) return { linted: 0, demoted: [] };
  const ctx = slotContext(sqlite);
  const upsert = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at)
     VALUES (?, 'raw', ?, ?, 'lint', datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET lint_level = excluded.lint_level, linted_version = excluded.linted_version`,
  );
  const demote = sqlite.prepare(
    `UPDATE avail_template_meta SET status = 'draft', status_reason = ?, status_changed_at = datetime('now'),
       updated_by = 'lint', updated_at = datetime('now')
     WHERE template_id = ? AND status = 'verified'`,
  );
  const demoted: string[] = [];
  const audit: AuditEntry[] = [];
  sqlite.transaction(() => {
    for (const row of stale) {
      const level = lintRow(row, ctx);
      upsert.run(row.id, level, row.version);
      if (row.avail_status === "verified" && level !== "A") {
        const reason = demotionReason(level, row.version);
        demote.run(reason, row.id);
        demoted.push(row.id);
        audit.push({
          actor: SYSTEM_ACTOR, entity: "template", entityId: row.id, entityLabel: row.label, action: "status",
          before: { status: "verified" }, after: { status: "draft", reason },
        });
      }
    }
    writeAudit(sqlite, audit);
    if (demoted.length) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
  })();
  return { linted: stale.length, demoted };
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
 * Sets the status of an existing template and re-lints it. Keeps source/upstream_id;
 * clears status_reason (a person decided) and stamps status_changed_at when it changes.
 * verified is refused unless the template is at level A. Rolls the library ETag:
 * GET /templates is filtered by status.
 */
export async function setTemplateStatus(
  db: D1Database,
  templateId: string,
  status: TemplateStatus,
  updatedBy: string,
  via: ApprovalMethod = "review",
  actorId: string | null = null,
): Promise<SetStatusResult> {
  const row = await db.prepare("SELECT * FROM templates WHERE id = ?").bind(templateId).first<TemplateRow>();
  if (!row) return { ok: false, reason: "not_found" };
  const prev = await db.prepare("SELECT status, catalog FROM avail_template_meta WHERE template_id = ?").bind(templateId).first<{ status: TemplateStatus; catalog: string | null }>();
  const previous = prev?.status ?? "raw";
  const { results: slotRows } = await db.prepare(SLOT_ROWS).all<{ slot_family: string | null; slots: string | null }>();
  const lint = lintBlock(blockOfRow(row, prev?.catalog), slotContextOfRows(slotRows));
  if (status === "verified" && lint.level !== "A") return { ok: false, reason: "not_level_a", lint };
  await db.batch([
    db
      .prepare(
        `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at,
           status_reason, status_changed_at, approved_via, approved_at, approved_by)
         VALUES (?, ?, ?, ?, ?, datetime('now'), NULL, datetime('now'), ?, CASE WHEN ? = 'verified' THEN datetime('now') END,
           CASE WHEN ? = 'verified' THEN ? END)
         ON CONFLICT(template_id) DO UPDATE SET status = excluded.status, lint_level = excluded.lint_level,
           linted_version = excluded.linted_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at,
           status_reason = NULL,
           status_changed_at = CASE WHEN avail_template_meta.status = excluded.status
             THEN avail_template_meta.status_changed_at ELSE excluded.status_changed_at END,
           approved_via = CASE WHEN excluded.status = 'verified' THEN excluded.approved_via ELSE avail_template_meta.approved_via END,
           approved_at = CASE WHEN excluded.status = 'verified' THEN excluded.approved_at ELSE avail_template_meta.approved_at END,
           approved_by = CASE WHEN excluded.status = 'verified' THEN excluded.approved_by ELSE avail_template_meta.approved_by END`,
      )
      .bind(templateId, status, lint.level, row.version, updatedBy, status === "verified" ? via : null, status, status, updatedBy),
    db.prepare(BUMP_LIBRARY_VERSION),
  ]);
  if (previous !== status) {
    await writeAuditD1(db, [{
      actor: updatedBy, actorId, entity: "template", entityId: templateId, entityLabel: row.label, action: "status",
      before: { status: previous }, after: { status, ...(status === "verified" ? { approvedVia: via } : {}) },
    }]);
  }
  const meta = await getTemplateMeta(db, templateId);
  return { ok: true, meta: meta! };
}
