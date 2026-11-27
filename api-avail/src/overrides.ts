/**
 * Overrides in the database (step 2.7; table avail_overrides, migration 9011; the logic is
 * src/avail/overrides.ts).
 *
 *   An accepted proposal (POST /submissions/:id/approve of an update, from the library workspace or
 *   the API) records every field and port it changed: server.ts reads the template before upstream
 *   saves it (beginProposalOverrides) and records the difference after (endProposalOverrides). The
 *   comment is the proposal's (where the data comes from), the reviewer's note is added to it.
 *
 *   GET  /avail/templates/:id/overrides          librarian, admin, AI Assistant: the overrides in force
 *                                                for the template (database and docs/avail/overrides.json)
 *   POST /avail/templates/:id/overrides/remove   librarian or admin: { key } ("db:<id>" or "file:<n>") —
 *                                                the override no longer applies; the template keeps its
 *                                                current value, the next import may replace it
 *
 * Both are logged (action override). import:catalog and normalize:library read overridesInForce.
 */
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { FILE_OVERRIDES } from "../../src/avail/catalogRules";
import {
  combineOverrides,
  describeOverride,
  mergeOverrides,
  overrideMatches,
  overrideTarget,
  overridesFromChange,
  sameOverride,
  type Override,
  type OverridesFile,
} from "../../src/avail/overrides";
import { canReadAudit } from "../../src/avail/roles";
import { patchScope, type TemplatePatch } from "../../src/avail/templatePatch";
import { ADMIN_TOKEN_ACTOR, writeAudit } from "./audit";
import type { D1DatabaseShim } from "./d1";
import type { RequestActor } from "./requestAudit";
import { BUMP_LIBRARY_VERSION } from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;

export interface OverrideRow {
  id: number;
  template_id: string | null;
  manufacturer: string | null;
  model_number: string | null;
  label: string | null;
  kind: "field" | "port";
  field: string | null;
  port: string | null;
  port_id: string | null;
  op: "set" | "add" | "remove" | null;
  value: string | null;
  base: string | null;
  source: string;
  submission_id: string | null;
  comment: string;
  accepted_by: string;
  created_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
}

export type StoredOverride = Override & { removed?: boolean };

function hasTable(sqlite: Database.Database): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'avail_overrides'").get();
}

export function overrideOfRow(r: OverrideRow): StoredOverride {
  return {
    id: r.id,
    templateId: r.template_id,
    manufacturer: r.manufacturer,
    modelNumber: r.model_number,
    label: r.label,
    kind: r.kind,
    ...(r.field ? { field: r.field } : {}),
    ...(r.port !== null ? { port: r.port } : {}),
    ...(r.port_id ? { portId: r.port_id } : {}),
    ...(r.op ? { op: r.op } : {}),
    value: r.value === null ? null : JSON.parse(r.value),
    ...(r.base !== null ? { base: JSON.parse(r.base) } : {}),
    source: r.source,
    comment: r.comment,
    acceptedBy: r.accepted_by,
    acceptedAt: r.created_at,
    ...(r.removed_at ? { removed: true } : {}),
  };
}

/** Every row (active and removed), oldest first; empty before migration 9011. */
export function loadOverrideRows(sqlite: Database.Database): OverrideRow[] {
  if (!hasTable(sqlite)) return [];
  return sqlite.prepare("SELECT * FROM avail_overrides ORDER BY id").all() as OverrideRow[];
}

/** What imports apply: the database's active overrides and the file's entries it does not know. */
export function overridesInForce(sqlite: Database.Database, file: readonly Override[] = FILE_OVERRIDES): Override[] {
  return mergeOverrides(loadOverrideRows(sqlite).map(overrideOfRow), file);
}

/**
 * docs/avail/overrides.json from the database and the current file: the overrides in force, without
 * row ids, sorted by template and target (a stable diff in the repository).
 */
export function exportOverrides(sqlite: Database.Database, current: OverridesFile): OverridesFile {
  const list = overridesInForce(sqlite, current.overrides).map(({ id: _id, ...o }) => {
    const { removed: _r, ...rest } = o as StoredOverride;
    return rest;
  });
  const key = (o: Override) => [o.manufacturer ?? "", o.label ?? "", o.templateId ?? "", overrideTarget(o), o.acceptedAt ?? ""].join("\u0000").toLowerCase();
  list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { ...(current.about ? { about: current.about } : {}), overrides: list };
}

const INSERT = `INSERT INTO avail_overrides (template_id, manufacturer, model_number, label, kind, field, port, port_id, op, value, base,
    source, submission_id, comment, accepted_by, removed_at, removed_by, removed_reason)
  VALUES (@template_id, @manufacturer, @model_number, @label, @kind, @field, @port, @port_id, @op, @value, @base,
    @source, @submission_id, @comment, @accepted_by, @removed_at, @removed_by, @removed_reason)`;

function rowParams(o: Override, extra: { submissionId?: string | null; removedAt?: string | null; removedBy?: string | null; removedReason?: string | null } = {}) {
  return {
    template_id: o.templateId ?? null,
    manufacturer: o.manufacturer ?? null,
    model_number: o.modelNumber ?? null,
    label: o.label ?? null,
    kind: o.kind,
    field: o.field ?? null,
    port: o.kind === "port" ? (o.port ?? "") : null,
    port_id: o.portId ?? null,
    op: o.kind === "port" ? (o.op ?? "set") : null,
    value: JSON.stringify(o.value ?? null),
    base: o.base === undefined ? null : JSON.stringify(o.base),
    source: o.source,
    submission_id: extra.submissionId ?? null,
    comment: o.comment,
    accepted_by: o.acceptedBy,
    removed_at: extra.removedAt ?? null,
    removed_by: extra.removedBy ?? null,
    removed_reason: extra.removedReason ?? null,
  };
}

/**
 * Stores new overrides of one template. An active override on the same thing (field, or port by
 * its label) is replaced: removed with the reason, its port fields merged into the new one.
 */
export function storeOverrides(sqlite: Database.Database, list: readonly Override[], submissionId: string | null = null): number {
  if (!list.length || !hasTable(sqlite)) return 0;
  const active = loadOverrideRows(sqlite).filter((r) => !r.removed_at);
  const insert = sqlite.prepare(INSERT);
  const retire = sqlite.prepare("UPDATE avail_overrides SET removed_at = datetime('now'), removed_by = ?, removed_reason = ? WHERE id = ?");
  for (const o of list) {
    let next = o;
    for (const r of active) {
      const old = overrideOfRow(r);
      if (old.kind !== o.kind || overrideTarget(old) !== overrideTarget(o)) continue;
      if (!(old.templateId && old.templateId === o.templateId) && !overrideMatches(old, { id: o.templateId, manufacturer: o.manufacturer, modelNumber: o.modelNumber, label: o.label })) continue;
      next = combineOverrides(old, next);
      retire.run(o.acceptedBy, `replaced by ${o.source}`, r.id);
    }
    insert.run(rowParams(next, { submissionId }));
  }
  return list.length;
}

// ------------------------------------------------------------------ accepted proposals

/** What an approve of an update proposal is about to change: read before upstream runs it. */
export interface ProposalOverrideScope {
  submissionId: string;
  templateId: string;
  before: Record<string, unknown>;
  comment: string;
  submitter: string | null;
}

const APPROVE_RE = /^\/submissions\/([^/]+)\/approve\/?$/;

export async function beginProposalOverrides(sqlite: Database.Database, request: Request): Promise<ProposalOverrideScope | null> {
  if (request.method !== "POST" || !hasTable(sqlite)) return null;
  const m = APPROVE_RE.exec(new URL(request.url).pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const s = sqlite
    .prepare(
      `SELECT s.action, s.template_id, s.submitter_note, u.email FROM submissions s
         LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.status IN ('pending', 'deferred')`,
    )
    .get(id) as { action: string; template_id: string | null; submitter_note: string | null; email: string | null } | undefined;
  if (!s || s.action !== "update" || !s.template_id) return null;
  const row = sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(s.template_id) as TemplateRow | undefined;
  if (!row) return null;
  let note = "";
  try {
    const body = (await request.clone().json()) as { note?: unknown };
    if (typeof body?.note === "string") note = body.note.trim();
  } catch {
    /* no body */
  }
  const proposal = (s.submitter_note ?? "").trim();
  const comment = [proposal, note && note !== proposal ? `Review note: ${note}` : ""].filter(Boolean).join(" — ");
  return { submissionId: id, templateId: s.template_id, before: rowToTemplate(row) as unknown as Record<string, unknown>, comment, submitter: s.email };
}

/**
 * After the approve succeeded: the overrides of what changed, stored and logged. With the proposal's
 * patch (proposals.ts), only the fields and ports the patch changes — not what else differs.
 */
export function endProposalOverrides(sqlite: Database.Database, scope: ProposalOverrideScope, actor: RequestActor, patch: TemplatePatch | null = null): Override[] {
  const row = sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(scope.templateId) as TemplateRow | undefined;
  if (!row) return [];
  const after = rowToTemplate(row) as unknown as Record<string, unknown>;
  const source = `proposal ${scope.submissionId}${scope.submitter ? ` by ${scope.submitter}` : ""}`;
  const all = overridesFromChange(scope.before, after, { source, comment: scope.comment, acceptedBy: actor.actor });
  const only = patch ? patchScope(patch) : null;
  const list = only
    ? all.filter((o) => (o.kind === "field" ? only.fields.has(o.field ?? "") : only.ports.has(o.portId ?? "") || only.ports.has(`label:${o.port ?? ""}`)))
    : all;
  if (!list.length) return [];
  sqlite.transaction(() => {
    storeOverrides(sqlite, list, scope.submissionId);
    writeAudit(sqlite, [{
      ...actor, entity: "template", entityId: scope.templateId, entityLabel: row.label, action: "override",
      before: null, after: { added: list.map(describeOverride), source, ...(scope.comment ? { comment: scope.comment } : {}) },
    }]);
  })();
  return list;
}

// ------------------------------------------------------------------ routes

/** An override as the details panel lists it. */
export interface OverrideView {
  /** "db:<id>" or "file:<index in docs/avail/overrides.json>". */
  key: string;
  kind: Override["kind"];
  text: string;
  source: string;
  comment: string;
  acceptedBy: string;
  acceptedAt: string | null;
  /** Only in docs/avail/overrides.json (not accepted on this server). */
  fromFile: boolean;
}

function viewsFor(sqlite: Database.Database, template: Record<string, unknown>, file: readonly Override[]): OverrideView[] {
  const rows = loadOverrideRows(sqlite).map(overrideOfRow);
  const out: OverrideView[] = [];
  for (const o of rows) {
    if (o.removed || !overrideMatches(o, template)) continue;
    out.push({ key: `db:${o.id}`, kind: o.kind, text: describeOverride(o), source: o.source, comment: o.comment, acceptedBy: o.acceptedBy, acceptedAt: o.acceptedAt ?? null, fromFile: false });
  }
  file.forEach((o, i) => {
    if (!overrideMatches(o, template) || rows.some((d) => sameOverride(d, o))) return;
    out.push({ key: `file:${i}`, kind: o.kind, text: describeOverride(o), source: o.source, comment: o.comment, acceptedBy: o.acceptedBy, acceptedAt: o.acceptedAt ?? null, fromFile: true });
  });
  return out;
}

/** The SQLite behind the D1 binding (d1.ts): our routes read and write it directly. */
const sqliteOf = (c: { env: { easyschematic_db: D1Database } }) => (c.env.easyschematic_db as unknown as D1DatabaseShim).sqlite;

export function registerOverrideRoutes(app: UpstreamApp, file: readonly Override[] = FILE_OVERRIDES): void {
  app.get("/avail/templates/:id/overrides", async (c) => {
    if (!requireModeratorOrToken(c) && !canReadAudit(c.get("user")?.role)) return c.json({ error: "Librarian, admin or AI Assistant access required" }, 403);
    const sqlite = sqliteOf(c);
    const row = sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(c.req.param("id")) as TemplateRow | undefined;
    if (!row) return c.json({ error: "Template not found" }, 404);
    return c.json({ overrides: viewsFor(sqlite, rowToTemplate(row) as unknown as Record<string, unknown>, file) });
  });

  app.post("/avail/templates/:id/overrides/remove", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const key = (body as { key?: unknown } | null)?.key;
    const m = typeof key === "string" ? /^(db|file):(\d+)$/.exec(key) : null;
    if (!m) return c.json({ error: 'key must be "db:<id>" or "file:<n>"' }, 400);
    const sqlite = sqliteOf(c);
    const row = sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(c.req.param("id")) as TemplateRow | undefined;
    if (!row) return c.json({ error: "Template not found" }, 404);
    const view = viewsFor(sqlite, rowToTemplate(row) as unknown as Record<string, unknown>, file).find((v) => v.key === key);
    if (!view) return c.json({ error: "No such override on this template" }, 404);
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const reason = "removed in the library workspace";
    sqlite.transaction(() => {
      if (m[1] === "db") {
        sqlite.prepare("UPDATE avail_overrides SET removed_at = datetime('now'), removed_by = ?, removed_reason = ? WHERE id = ?").run(actor.actor, reason, Number(m[2]));
      } else {
        // A file entry: a removed row, so it stays out until export:overrides drops it from the file.
        const now = (sqlite.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
        sqlite.prepare(INSERT).run(rowParams(file[Number(m[2])], { removedAt: now, removedBy: actor.actor, removedReason: reason }));
      }
      sqlite.prepare(BUMP_LIBRARY_VERSION).run();
      writeAudit(sqlite, [{
        ...actor, entity: "template", entityId: row.id, entityLabel: row.label, action: "override",
        before: { override: view.text, source: view.source, comment: view.comment }, after: { removed: true },
      }]);
    })();
    return c.json({ removed: view.key });
  });
}
