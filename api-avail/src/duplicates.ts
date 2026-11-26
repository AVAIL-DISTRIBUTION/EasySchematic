/**
 * Duplicate control on the API side (step 2.4): the library's templates as duplicate candidates
 * (src/avail/duplicates.ts), for report:duplicates, the workspace filter, Merge into… and the
 * 409 guard on save (server.ts).
 */
import type Database from "better-sqlite3";
import type { BlockLevel } from "../../src/avail/blockLint";
import type { DupCandidate, DupStatus } from "../../src/avail/duplicates";
import { catalogIndex, parseCatalogMeta, portsOrigin } from "../../src/avail/portsOrigin";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { ADMIN_TOKEN_ACTOR, writeAuditD1, type AuditEntry } from "./audit";
import { BUMP_LIBRARY_VERSION } from "./templateMeta";
import type { DuplicateConflict } from "./duplicateGuard";

export interface CandidateRow {
  id: string;
  label: string;
  manufacturer: string | null;
  model_number: string | null;
  ports: string | null;
  avail_status: DupStatus | null;
  avail_source: string | null;
  avail_catalog: string | null;
  avail_level: BlockLevel | null;
}

export const CANDIDATE_SQL = `SELECT t.id, t.label, t.manufacturer, t.model_number, t.ports,
       COALESCE(m.status, 'raw') AS avail_status, m.source AS avail_source, m.catalog AS avail_catalog, m.lint_level AS avail_level
  FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
 WHERE t.flagged_for_deletion = 0`;

function portCount(json: string | null): number {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

export function candidatesOf(rows: readonly CandidateRow[]): DupCandidate[] {
  const byFile = catalogIndex(rows.map((r) => parseCatalogMeta(r.avail_catalog)));
  return rows.map((r) => {
    const catalog = parseCatalogMeta(r.avail_catalog);
    return {
      id: r.id,
      label: r.label,
      manufacturer: r.manufacturer ?? "",
      modelNumber: r.model_number ?? "",
      status: r.avail_status ?? "raw",
      source: r.avail_source,
      portsOrigin: portsOrigin({ source: r.avail_source, catalog }, byFile).origin,
      level: r.avail_level,
      ports: portCount(r.ports),
      variant: typeof catalog?.variant === "string" ? catalog.variant : null,
    };
  });
}

export function loadCandidates(sqlite: Database.Database): DupCandidate[] {
  // A snapshot from before migration 9005 has no catalog column: read it as no catalog.
  const cols = (sqlite.prepare("PRAGMA table_info(avail_template_meta)").all() as { name: string }[]).map((c) => c.name);
  const sql = cols.includes("catalog") ? CANDIDATE_SQL : CANDIDATE_SQL.replace("m.catalog AS avail_catalog", "NULL AS avail_catalog");
  return candidatesOf(sqlite.prepare(sql).all() as CandidateRow[]);
}

export const duplicateReason = (primary: string) => `duplicate of ${primary}`;

// ---------------------------------------------------------------------------- routes


type UpstreamApp = typeof UpstreamAppValue;

/** Most templates one merge request may hide (as for the other bulk routes). */
export const MAX_MERGE_BATCH = 500;

/**
 * 409 answers of the duplicate guard (server.ts): the wrapper hands the request here, keyed by
 * the Request object, so the answer goes out through the app's CORS and security middleware.
 */
export const pendingConflicts = new WeakMap<Request, DuplicateConflict>();
export const CONFLICT_PATH = "/avail/internal/duplicate-conflict";

/**
 *   POST /avail/templates/merge   { primary, ids } — librarian or admin: every id (not the primary)
 *                                 becomes hidden with status_reason "duplicate of <primary>"; each
 *                                 change goes to the audit log with the primary; → { primary,
 *                                 updated, unchanged, failed }
 */
export function registerDuplicateRoutes(app: UpstreamApp): void {
  app.all(CONFLICT_PATH, (c) => {
    const conflict = pendingConflicts.get(c.req.raw);
    return conflict ? c.json(conflict, 409, { "Cache-Control": "no-store" }) : c.json({ error: "Not found" }, 404);
  });

  app.post("/avail/templates/merge", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { primary, ids } = (body ?? {}) as { primary?: unknown; ids?: unknown };
    if (typeof primary !== "string" || !primary) return c.json({ error: "primary must be a template id" }, 400);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MERGE_BATCH || !ids.every((id) => typeof id === "string" && id !== "")) {
      return c.json({ error: `ids must be 1 to ${MAX_MERGE_BATCH} template ids` }, 400);
    }
    const db = c.env.easyschematic_db;
    const main = await db.prepare("SELECT id, label FROM templates WHERE id = ?").bind(primary).first<{ id: string; label: string }>();
    if (!main) return c.json({ error: "Primary template not found" }, 404);
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const reason = duplicateReason(primary);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: { id: string; reason: "not_found" | "primary" }[] = [];
    const entries: AuditEntry[] = [];
    const statements: D1PreparedStatement[] = [];
    for (const id of [...new Set(ids as string[])]) {
      if (id === primary) {
        failed.push({ id, reason: "primary" });
        continue;
      }
      const row = await db
        .prepare("SELECT t.id, t.label, COALESCE(m.status, 'raw') AS status, m.status_reason FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id WHERE t.id = ?")
        .bind(id)
        .first<{ id: string; label: string; status: string; status_reason: string | null }>();
      if (!row) {
        failed.push({ id, reason: "not_found" });
        continue;
      }
      if (row.status === "hidden" && row.status_reason === reason) {
        unchanged.push(id);
        continue;
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO avail_template_meta (template_id, status, status_reason, status_changed_at, updated_by, updated_at)
             VALUES (?, 'hidden', ?, datetime('now'), ?, datetime('now'))
             ON CONFLICT(template_id) DO UPDATE SET status = 'hidden', status_reason = excluded.status_reason,
               status_changed_at = datetime('now'), updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          )
          .bind(id, reason, actor.actor),
      );
      entries.push({
        ...actor,
        entity: "template",
        entityId: id,
        entityLabel: row.label,
        action: "status",
        before: { status: row.status },
        after: { status: "hidden", reason, duplicateOf: primary, duplicateOfLabel: main.label },
      });
      updated.push(id);
    }
    if (statements.length) {
      await db.batch([...statements, db.prepare(BUMP_LIBRARY_VERSION)]);
      await writeAuditD1(db, entries);
    }
    return c.json({ primary, updated, unchanged, failed });
  });
}
