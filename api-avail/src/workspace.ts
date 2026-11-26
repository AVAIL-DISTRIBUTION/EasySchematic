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
 *
 * Status changes (approve, draft, hide, unhide) use POST /avail/templates/status/batch (routes.ts);
 * proposals use upstream's submissions (/submissions/pending, /:id/approve, /:id/reject).
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import type { BlockLevel } from "../../src/avail/blockLint";
import { findCategory } from "../../src/avail/library";
import { catalogIndex, parseCatalogMeta, portsOrigin, type PortsOrigin } from "../../src/avail/portsOrigin";
import { duplicateGroups, duplicateIndex } from "../../src/avail/duplicates";
import { ADMIN_TOKEN_ACTOR, writeAuditD1, type AuditEntry } from "./audit";
import { candidatesOf } from "./duplicates";
import { notDuplicatesById, pairSetOf, SELECT_PAIRS, type NotDuplicateOf, type NotDuplicateRow } from "./notDuplicates";
import { BUMP_LIBRARY_VERSION, type ApprovalMethod, type TemplateStatus } from "./templateMeta";

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
}

type Row = TemplateRow & {
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

export function registerWorkspaceRoutes(app: UpstreamApp): void {
  app.get("/avail/workspace/templates", async (c) => {
    if (!requireModeratorOrToken(c)) return c.json({ error: "Librarian or admin access required" }, 403);
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
                m.lint_level AS avail_level, m.status_reason, m.status_changed_at, m.approved_by, m.approved_via, m.approved_at
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
}
