/**
 * AVAIL audit log (table avail_audit_log, migration 9007; step 2.1): who changed what and when.
 *
 * Written by
 *   - users.ts — role and access changes (PUT /avail/users/:id/role, /active);
 *   - routes.ts / templateMeta.ts — template status changes (manual, bulk, automatic demotion);
 *   - server.ts — every template write through upstream's routes (PUT/POST/DELETE /templates…,
 *     approved submissions, flag-delete): the rows before and after the request are compared,
 *     only the changed fields are stored;
 *   - CLIs that change statuses (approve:catalog).
 * Read by GET /avail/audit (librarian and admin).
 */
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";

export type AuditEntity = "user" | "template" | "run";
export type AuditAction = "role" | "access" | "created" | "updated" | "deleted" | "status" | "run";

export interface AuditEntry {
  actor: string;
  actorId?: string | null;
  entity: AuditEntity;
  entityId: string;
  entityLabel?: string | null;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
}

export interface AuditRecord extends Omit<AuditEntry, "before" | "after"> {
  id: number;
  at: string;
  before: unknown;
  after: unknown;
}

/** Actor of automatic changes (lint sync, startup). */
export const SYSTEM_ACTOR = "system";
export const ADMIN_TOKEN_ACTOR = "admin-token";

const INSERT = `INSERT INTO avail_audit_log (actor, actor_id, entity, entity_id, entity_label, action, before, after)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function params(e: AuditEntry): unknown[] {
  return [e.actor, e.actorId ?? null, e.entity, e.entityId, e.entityLabel ?? null, e.action, json(e.before), json(e.after)];
}

/** Writes entries with better-sqlite3 (server wrapper, CLIs); no-op for an empty list. */
export function writeAudit(sqlite: Database.Database, entries: readonly AuditEntry[]): void {
  if (!entries.length) return;
  const stmt = sqlite.prepare(INSERT);
  sqlite.transaction(() => {
    for (const e of entries) stmt.run(...params(e));
  })();
}

/** The same through the D1 binding (Hono routes). */
export async function writeAuditD1(db: D1Database, entries: readonly AuditEntry[]): Promise<void> {
  if (!entries.length) return;
  await db.batch(entries.map((e) => db.prepare(INSERT).bind(...params(e))));
}

// ---------------------------------------------------------------------------- CLI runs

/** Commit of the running code: AVAIL_COMMIT (the image's build arg), else git, else "unknown". */
export function runningCommit(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AVAIL_COMMIT && env.AVAIL_COMMIT !== "unknown") return env.AVAIL_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Totals of a run; the usual ones first, anything else a command reports after them. */
export interface RunCounts {
  created?: number;
  updated?: number;
  hidden?: number;
  approved?: number;
  deleted?: number;
  [k: string]: number | undefined;
}

/**
 * One summary entry per CLI run that wrote the database (decision 2026-11-26: not one per
 * template; --dry-run writes nothing): the command with its arguments, the commit, the totals.
 */
export function writeRunAudit(
  sqlite: Database.Database,
  run: { command: string; args?: readonly string[]; counts: RunCounts },
  commit: string = runningCommit(),
): void {
  const args = [...(run.args ?? [])];
  const counts = Object.fromEntries(Object.entries(run.counts).filter(([, v]) => typeof v === "number"));
  writeAudit(sqlite, [{
    actor: SYSTEM_ACTOR,
    entity: "run",
    entityId: run.command,
    entityLabel: [`npm run ${run.command}`, ...args].join(" "),
    action: "run",
    after: { command: run.command, args, commit, counts },
  }]);
}

/** CLI arguments as typed (without node and the script). */
export const cliArgs = (): string[] => process.argv.slice(2);

// ---------------------------------------------------------------------------- template diff

type Obj = Record<string, unknown>;

/** A stored template as the audit sees it: the template fields plus the deletion flag. */
export function auditView(row: TemplateRow & { flagged_for_deletion?: number | null }): Obj {
  const { version: _v, ...t } = rowToTemplate(row) as unknown as Obj;
  return { ...t, ...(row.flagged_for_deletion ? { flaggedForDeletion: true } : {}) };
}

/** Only the fields that differ: { before: {f: old}, after: {f: new} }; null when nothing did. */
export function diffFields(before: Obj, after: Obj): { before: Obj; after: Obj } | null {
  const b: Obj = {};
  const a: Obj = {};
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (k in before) b[k] = before[k];
    if (k in after) a[k] = after[k];
  }
  return Object.keys(b).length || Object.keys(a).length ? { before: b, after: a } : null;
}

export interface TemplateSnapshot {
  /** id → version + deletion flag, for every template. */
  versions: Map<string, string>;
  /** Full rows of the templates the request names (before it runs). */
  rows: Map<string, Obj>;
}

const VERSION_SQL = "SELECT id, version, flagged_for_deletion FROM templates";

export function snapshotTemplates(sqlite: Database.Database, ids: readonly string[]): TemplateSnapshot {
  const versions = new Map<string, string>();
  for (const r of sqlite.prepare(VERSION_SQL).all() as { id: string; version: number; flagged_for_deletion: number | null }[]) {
    versions.set(r.id, `${r.version}|${r.flagged_for_deletion ?? 0}`);
  }
  const rows = new Map<string, Obj>();
  const one = sqlite.prepare("SELECT * FROM templates WHERE id = ?");
  for (const id of ids) {
    const row = one.get(id) as (TemplateRow & { flagged_for_deletion?: number }) | undefined;
    if (row) rows.set(id, auditView(row));
  }
  return { versions, rows };
}

/**
 * Audit entries for what a request changed. `scope` keeps the attribution honest when requests
 * interleave: only the templates the request names, plus templates that did not exist before
 * (a POST creates them), are attributed to it.
 */
export function templateChanges(
  sqlite: Database.Database,
  before: TemplateSnapshot,
  scope: ReadonlySet<string>,
  actor: { actor: string; actorId?: string | null },
): AuditEntry[] {
  const after = snapshotTemplates(sqlite, []).versions;
  const out: AuditEntry[] = [];
  const one = sqlite.prepare("SELECT * FROM templates WHERE id = ?");
  const ids = new Set([...before.versions.keys(), ...after.keys()]);
  for (const id of ids) {
    const was = before.versions.get(id);
    const now = after.get(id);
    if (was === now) continue;
    const isNew = was === undefined;
    if (!isNew && !scope.has(id)) continue;
    if (now === undefined) {
      const old = before.rows.get(id);
      out.push({ ...actor, entity: "template", entityId: id, entityLabel: (old?.label as string) ?? null, action: "deleted", before: old ?? null });
      continue;
    }
    const row = one.get(id) as TemplateRow & { flagged_for_deletion?: number };
    const cur = auditView(row);
    if (isNew) {
      out.push({ ...actor, entity: "template", entityId: id, entityLabel: row.label, action: "created", after: cur });
      continue;
    }
    const old = before.rows.get(id);
    const d = old ? diffFields(old, cur) : { before: null as unknown as Obj, after: cur };
    if (!d) continue;
    out.push({ ...actor, entity: "template", entityId: id, entityLabel: row.label, action: "updated", before: d.before, after: d.after });
  }
  return out;
}

// ---------------------------------------------------------------------------- reading

export interface AuditQuery {
  entity?: AuditEntity;
  entityId?: string;
  actor?: string;
  /** Entries with id below this (paging, newest first). */
  before?: number;
  limit?: number;
}

export const AUDIT_PAGE = 100;
export const AUDIT_MAX_PAGE = 500;

export async function listAudit(db: D1Database, q: AuditQuery): Promise<AuditRecord[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.entity) {
    where.push("entity = ?");
    args.push(q.entity);
  }
  if (q.entityId) {
    where.push("entity_id = ?");
    args.push(q.entityId);
  }
  if (q.actor) {
    where.push("actor = ?");
    args.push(q.actor);
  }
  if (q.before) {
    where.push("id < ?");
    args.push(q.before);
  }
  const limit = Math.min(Math.max(1, q.limit ?? AUDIT_PAGE), AUDIT_MAX_PAGE);
  const sql = `SELECT * FROM avail_audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
  const { results } = await db.prepare(sql).bind(...args).all<{
    id: number; at: string; actor: string; actor_id: string | null; entity: AuditEntity; entity_id: string;
    entity_label: string | null; action: AuditAction; before: string | null; after: string | null;
  }>();
  const parse = (s: string | null) => (s ? (JSON.parse(s) as unknown) : null);
  return results.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    actorId: r.actor_id,
    entity: r.entity,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    action: r.action,
    before: parse(r.before),
    after: parse(r.after),
  }));
}
