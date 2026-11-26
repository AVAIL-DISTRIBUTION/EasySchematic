/**
 * Library workspace routes (step 2.2), for the /library page of the editor. Librarian and admin
 * (moderator / admin session) or the ADMIN_TOKEN bearer.
 *
 *   GET  /avail/workspace/templates          every template (all statuses, flagged ones left out)
 *                                            with its workspace data: status, level, status reason,
 *                                            updated, approved (by, how, when), ports origin and
 *                                            source, data sheet link, who edited it (audit log)
 *                                            and its possible duplicate group (step 2.4), with
 *                                            the "not duplicates" decisions it is part of
 *   POST /avail/templates/category/batch     { ids, category } → { category, updated, unchanged, failed }
 *                                            leaf category of the taxonomy; each change goes to the
 *                                            audit log; levels are re-linted after the request
 *   POST /avail/templates/lifecycle/batch    { ids, lifecycle, availableFrom?, eolDate? } →
 *                                            { lifecycle, updated, unchanged, failed } (librarian,
 *                                            admin): upcoming / active / eol (src/avail/lifecycle.ts);
 *                                            each change goes to the audit log (action lifecycle); the
 *                                            level is re-linted at once (estimates, standard v0.12) and
 *                                            a verified template that falls below A becomes draft
 *
 * Status changes (approve, draft, hide, unhide) use POST /avail/templates/status/batch (routes.ts);
 * proposals use upstream's submissions (/submissions/pending, /:id/approve, /:id/reject).
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import type { BlockLevel } from "../../src/avail/blockLint";
import { findCategory } from "../../src/avail/library";
import { lintBlock } from "../../src/avail/blockLint";
import { lifecycleColumns, lifecycleOfColumns, parseLifecycleInput, sameLifecycle, type Lifecycle } from "../../src/avail/lifecycle";
import { canReadAudit } from "../../src/avail/roles";
import { catalogIndex, parseCatalogMeta, portsOrigin, type PortsOrigin } from "../../src/avail/portsOrigin";
import { duplicateGroups, duplicateIndex } from "../../src/avail/duplicates";
import { ADMIN_TOKEN_ACTOR, writeAuditD1, type AuditEntry } from "./audit";
import { candidatesOf } from "./duplicates";
import { notDuplicatesById, pairSetOf, SELECT_PAIRS, type NotDuplicateOf, type NotDuplicateRow } from "./notDuplicates";
import {
  blockOfRow,
  BUMP_LIBRARY_VERSION,
  demotionReason,
  LIFECYCLE_SELECT,
  SLOT_ROWS,
  slotContextOfRows,
  type ApprovalMethod,
  type LifecycleCols,
  type TemplateStatus,
} from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;

/** Most templates one bulk category request may change (as for status, routes.ts MAX_BATCH). */
export const MAX_CATEGORY_BATCH = 500;

/** Workspace data of one template, next to the template itself (`avail` field of the response). */
export interface WorkspaceInfo {
  status: TemplateStatus;
  level: BlockLevel | null;
  statusReason: string | null;
  statusChangedAt: string | null;
  updatedAt: string | null;
  approvedBy: string | null;
  approvedVia: ApprovalMethod | null;
  approvedAt: string | null;
  portsOrigin: PortsOrigin;
  /** portsSource kind ("stencil", "datasheet", "library", "db", "variant", "upstream"), or null. */
  portsSource: string | null;
  /** The document the ports were read from (data sheet URL, stencil file, template id). */
  portsFrom: string | null;
  /** Data sheet link: the catalog card's datasheetUrl, else a data-sheet portsSource. */
  datasheetUrl: string | null;
  /** Meta source: avail-library, avail-catalog, easyschematic.live… */
  source: string | null;
  /** People who changed the template (audit log, newest first), and the last change. */
  editors: string[];
  lastActor: string | null;
  lastAt: string | null;
  /** Possible duplicate (step 2.4): the group's proposed primary and size; null when none. */
  duplicate: { primary: string; size: number } | null;
  /** "Not duplicates" decisions this template is part of (step 2.4). */
  notDuplicates: NotDuplicateOf[];
  /** Product lifecycle (migration 9012): upcoming (availableFrom), active, eol (eolDate). */
  lifecycle: Lifecycle;
  availableFrom: string | null;
  eolDate: string | null;
}

type Row = TemplateRow & LifecycleCols & {
  updated_at: string | null;
  avail_status: TemplateStatus;
  avail_source: string | null;
  avail_catalog: string | null;
  avail_level: BlockLevel | null;
  status_reason: string | null;
  status_changed_at: string | null;
  approved_by: string | null;
  approved_via: ApprovalMethod | null;
  approved_at: string | null;
};

/** People, not automation: system, CLI runs, lint. */
const isPerson = (actor: string) => actor !== "system" && actor !== "lint" && !actor.startsWith("cli:") && actor !== "anonymous";

/** lifecycle / availableFrom / eolDate of the workspace info from the stored columns. */
function lifecycleInfo(row: LifecycleCols): Pick<WorkspaceInfo, "lifecycle" | "availableFrom" | "eolDate"> {
  const lc = lifecycleOfColumns({ lifecycle: row.avail_lifecycle, available_from: row.avail_available_from, eol_date: row.avail_eol_date });
  return { lifecycle: lc.lifecycle, availableFrom: lc.availableFrom ?? null, eolDate: lc.eolDate ?? null };
}

export function registerWorkspaceRoutes(app: UpstreamApp): void {
  app.get("/avail/workspace/templates", async (c) => {
    // Read-only data: librarians, admins and the AI Assistant.
    if (!requireModeratorOrToken(c) && !canReadAudit(c.get("user")?.role)) return c.json({ error: "Librarian, admin or AI Assistant access required" }, 403);
    const db = c.env.easyschematic_db;
    const lib = await db.prepare("SELECT version FROM library_meta WHERE id = 1").first<{ version: number }>();
    const last = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM avail_audit_log").first<{ id: number }>();
    const etag = `"avail-ws-${lib?.version ?? 0}-${last?.id ?? 0}"`;
    const headers = { "Cache-Control": "no-cache", ETag: etag, Vary: "Cookie, Authorization", "Access-Control-Expose-Headers": "ETag" };
    const inm = c.req.header("If-None-Match");
    if (inm && inm.split(",").some((t) => t.trim() === etag)) return c.body(null, 304, headers);

    const { results } = await db
      .prepare(
        `SELECT t.*, COALESCE(m.status, 'raw') AS avail_status, m.source AS avail_source, m.catalog AS avail_catalog,
                m.lint_level AS avail_level, m.status_reason, m.status_changed_at, m.approved_by, m.approved_via, m.approved_at,
                ${LIFECYCLE_SELECT}
           FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
          WHERE t.flagged_for_deletion = 0
          ORDER BY t.manufacturer, t.label`,
      )
      .all<Row>();
    const { results: audit } = await db
      .prepare(
        `SELECT entity_id, actor, MAX(at) AS at, MAX(id) AS id FROM avail_audit_log
          WHERE entity = 'template' AND action <> 'not-duplicate' GROUP BY entity_id, actor ORDER BY id DESC`,
      )
      .all<{ entity_id: string; actor: string; at: string; id: number }>();
    const editors = new Map<string, { actor: string; at: string }[]>();
    for (const a of audit) {
      const list = editors.get(a.entity_id) ?? [];
      list.push({ actor: a.actor, at: a.at });
      editors.set(a.entity_id, list);
    }
    const byFile = catalogIndex(results.map((r) => parseCatalogMeta(r.avail_catalog)));
    const { results: pairs } = await db.prepare(SELECT_PAIRS).all<NotDuplicateRow>();
    const dupes = duplicateIndex(duplicateGroups(candidatesOf(results), pairSetOf(pairs)));
    const apart = notDuplicatesById(pairs, new Map(results.map((r) => [r.id, r.label])));

    const templates = results.map((row) => {
      const catalog = parseCatalogMeta(row.avail_catalog);
      const origin = portsOrigin({ source: row.avail_source, catalog }, byFile);
      const kind = origin.kind ?? null;
      const from = origin.from ?? null;
      const datasheet = typeof catalog?.datasheetUrl === "string" ? catalog.datasheetUrl : kind === "datasheet" || origin.via?.kind === "datasheet" ? from : null;
      const edits = editors.get(row.id) ?? [];
      const info: WorkspaceInfo = {
        status: row.avail_status,
        level: row.avail_level,
        statusReason: row.status_reason,
        statusChangedAt: row.status_changed_at,
        updatedAt: row.updated_at,
        approvedBy: row.approved_by,
        approvedVia: row.approved_via,
        approvedAt: row.approved_at,
        portsOrigin: origin.origin,
        portsSource: kind,
        portsFrom: from,
        datasheetUrl: datasheet,
        source: row.avail_source,
        editors: edits.map((e) => e.actor).filter(isPerson),
        lastActor: edits[0]?.actor ?? null,
        lastAt: edits[0]?.at ?? null,
        duplicate: dupes.get(row.id) ?? null,
        notDuplicates: apart.get(row.id) ?? [],
        ...lifecycleInfo(row),
      };
      return { ...rowToTemplate(row), avail: info };
    });
    return c.json({ libraryVersion: lib?.version ?? 0, templates }, 200, headers);
  });

  app.post("/avail/templates/category/batch", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { ids, category } = (body ?? {}) as { ids?: unknown; category?: unknown };
    const cat = typeof category === "string" ? findCategory(category) : undefined;
    if (!cat || !cat.leaf) return c.json({ error: "category must be a leaf category of avail-taxonomy.json" }, 400);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CATEGORY_BATCH || !ids.every((id) => typeof id === "string" && id !== "")) {
      return c.json({ error: `ids must be 1 to ${MAX_CATEGORY_BATCH} template ids` }, 400);
    }
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const db = c.env.easyschematic_db;
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: { id: string; reason: "not_found" }[] = [];
    const entries: AuditEntry[] = [];
    const statements: D1PreparedStatement[] = [];
    for (const id of [...new Set(ids as string[])]) {
      const row = await db.prepare("SELECT id, label, category FROM templates WHERE id = ?").bind(id).first<{ id: string; label: string; category: string | null }>();
      if (!row) {
        failed.push({ id, reason: "not_found" });
        continue;
      }
      if (row.category === cat.path) {
        unchanged.push(id);
        continue;
      }
      statements.push(
        db
          .prepare("UPDATE templates SET category = ?, version = version + 1, updated_at = datetime('now'), last_edited_by = ? WHERE id = ?")
          .bind(cat.path, actor.actorId, id),
      );
      entries.push({
        ...actor,
        entity: "template",
        entityId: id,
        entityLabel: row.label,
        action: "updated",
        before: { category: row.category },
        after: { category: cat.path },
      });
      updated.push(id);
    }
    if (statements.length) {
      await db.batch([...statements, db.prepare(BUMP_LIBRARY_VERSION)]);
      await writeAuditD1(db, entries);
    }
    return c.json({ category: cat.path, updated, unchanged, failed });
  });

  app.post("/avail/templates/lifecycle/batch", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { ids, ...rest } = (body ?? {}) as { ids?: unknown };
    const parsed = parseLifecycleInput(rest);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CATEGORY_BATCH || !ids.every((id) => typeof id === "string" && id !== "")) {
      return c.json({ error: `ids must be 1 to ${MAX_CATEGORY_BATCH} template ids` }, 400);
    }
    const value = parsed.value;
    const cols = lifecycleColumns(value);
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const db = c.env.easyschematic_db;
    const { results: slotRows } = await db.prepare(SLOT_ROWS).all<{ slot_family: string | null; slots: string | null }>();
    const ctx = slotContextOfRows(slotRows);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: { id: string; reason: "not_found" }[] = [];
    /** Verified templates that fell below level A with the new lifecycle (estimates of an upcoming product). */
    const demoted: string[] = [];
    const entries: AuditEntry[] = [];
    const statements: D1PreparedStatement[] = [];
    for (const id of [...new Set(ids as string[])]) {
      const row = await db
        .prepare(`SELECT t.*, COALESCE(m.status, 'raw') AS avail_status, m.catalog AS avail_catalog, ${LIFECYCLE_SELECT}
                    FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id WHERE t.id = ?`)
        .bind(id)
        .first<Row>();
      if (!row) {
        failed.push({ id, reason: "not_found" });
        continue;
      }
      const before = lifecycleOfColumns({ lifecycle: row.avail_lifecycle, available_from: row.avail_available_from, eol_date: row.avail_eol_date });
      if (sameLifecycle(before, value)) {
        unchanged.push(id);
        continue;
      }
      // The level with the new lifecycle: estimates count against a product that ships (v0.12).
      const level = lintBlock(blockOfRow({ ...row, avail_lifecycle: cols.lifecycle, avail_available_from: cols.available_from, avail_eol_date: cols.eol_date }, row.avail_catalog), ctx).level;
      const demote = row.avail_status === "verified" && level !== "A";
      const reason = demote ? demotionReason(level, row.version) : null;
      statements.push(
        db
          .prepare(
            `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at, lifecycle, available_from, eol_date)
             VALUES (?, 'raw', ?, ?, ?, datetime('now'), ?, ?, ?)
             ON CONFLICT(template_id) DO UPDATE SET lint_level = excluded.lint_level, linted_version = excluded.linted_version,
               updated_by = excluded.updated_by, updated_at = excluded.updated_at, lifecycle = excluded.lifecycle,
               available_from = excluded.available_from, eol_date = excluded.eol_date,
               status = CASE WHEN ? = 1 THEN 'draft' ELSE avail_template_meta.status END,
               status_reason = CASE WHEN ? = 1 THEN ? ELSE avail_template_meta.status_reason END,
               status_changed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE avail_template_meta.status_changed_at END`,
          )
          .bind(id, level, row.version, actor.actor, cols.lifecycle, cols.available_from, cols.eol_date, demote ? 1 : 0, demote ? 1 : 0, reason, demote ? 1 : 0),
      );
      const show = (v: typeof before) => ({ lifecycle: v.lifecycle, ...(v.availableFrom ? { availableFrom: v.availableFrom } : {}), ...(v.eolDate ? { eolDate: v.eolDate } : {}) });
      entries.push({ ...actor, entity: "template", entityId: id, entityLabel: row.label, action: "lifecycle", before: show(before), after: show(value) });
      if (demote) {
        demoted.push(id);
        entries.push({ ...actor, entity: "template", entityId: id, entityLabel: row.label, action: "status", before: { status: "verified" }, after: { status: "draft", reason } });
      }
      updated.push(id);
    }
    if (statements.length) {
      await db.batch([...statements, db.prepare(BUMP_LIBRARY_VERSION)]);
      await writeAuditD1(db, entries);
    }
    return c.json({ lifecycle: value, updated, unchanged, failed, demoted });
  });
}
