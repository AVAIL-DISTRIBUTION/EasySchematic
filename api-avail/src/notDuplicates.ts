/**
 * "Not duplicates" decisions (step 2.4; table avail_not_duplicates, migration 9009): a librarian
 * marks templates of a possible duplicate group as different products, with a comment. Stored per
 * pair; such a pair no longer counts as a duplicate in the workspace filter, report:duplicates and
 * the 409 guard on save (src/avail/duplicates.ts, `notDuplicates`).
 *
 *   POST /avail/templates/not-duplicates        { ids: [2..50], comment } — librarian or admin: every
 *                                               pair of the ids is marked; → { pairs, unchanged }
 *   POST /avail/templates/not-duplicates/undo   { a, b } — the decision on that pair is removed
 *
 * Each decision and undo goes to the audit log, one entry per template of the pair (action
 * not-duplicate). When a template of a pair changes its manufacturer or modelNumber, or is deleted,
 * the decision is dropped automatically (dropStaleNotDuplicates, run by syncLintLevels after every
 * write, also at API start and after CLIs), logged by "system".
 */
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { allPairs, manufacturerKey, pairKey, partKey } from "../../src/avail/duplicates";
import { ADMIN_TOKEN_ACTOR, SYSTEM_ACTOR, writeAudit, writeAuditD1, type AuditEntry } from "./audit";
import { BUMP_LIBRARY_VERSION } from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;

/** Most templates one "Not duplicates" decision may cover (a duplicate group is small). */
export const MAX_NOT_DUPLICATE_IDS = 50;

export interface NotDuplicateRow {
  id_a: string;
  id_b: string;
  a_manufacturer: string | null;
  a_model_number: string | null;
  b_manufacturer: string | null;
  b_model_number: string | null;
  comment: string;
  created_by: string;
  created_at: string;
}

/** A decision as one template sees it (workspace details panel). */
export interface NotDuplicateOf {
  id: string;
  label: string;
  comment: string;
  by: string;
  at: string;
}

export const SELECT_PAIRS = "SELECT * FROM avail_not_duplicates";

function hasTable(sqlite: Database.Database): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'avail_not_duplicates'").get();
}

export function pairSetOf(rows: readonly Pick<NotDuplicateRow, "id_a" | "id_b">[]): Set<string> {
  return new Set(rows.map((r) => pairKey(r.id_a, r.id_b)));
}

/** The decided pairs as a set of pairKey (empty on a database from before migration 9009). */
export function loadNotDuplicates(sqlite: Database.Database): Set<string> {
  if (!hasTable(sqlite)) return new Set();
  return pairSetOf(sqlite.prepare(SELECT_PAIRS).all() as NotDuplicateRow[]);
}

/** template id → the decisions it is part of, with the other template's label. */
export function notDuplicatesById(rows: readonly NotDuplicateRow[], labels: ReadonlyMap<string, string>): Map<string, NotDuplicateOf[]> {
  const m = new Map<string, NotDuplicateOf[]>();
  const add = (id: string, other: string, r: NotDuplicateRow) =>
    m.set(id, [...(m.get(id) ?? []), { id: other, label: labels.get(other) ?? other, comment: r.comment, by: r.created_by, at: r.created_at }]);
  for (const r of rows) {
    add(r.id_a, r.id_b, r);
    add(r.id_b, r.id_a, r);
  }
  return m;
}

const sameIdentity = (m1: string | null, p1: string | null, m2: string | null, p2: string | null) =>
  manufacturerKey(m1 ?? "") === manufacturerKey(m2 ?? "") && partKey(p1 ?? "") === partKey(p2 ?? "");

/**
 * Drops decisions whose template changed its manufacturer or modelNumber since, or is gone, with
 * an audit entry for each template of the pair (actor system). Returns the dropped pairs.
 */
export function dropStaleNotDuplicates(sqlite: Database.Database): [string, string][] {
  if (!hasTable(sqlite)) return [];
  const rows = sqlite
    .prepare(
      `SELECT n.*, ta.label AS a_label, ta.manufacturer AS a_man_now, ta.model_number AS a_pn_now,
              tb.label AS b_label, tb.manufacturer AS b_man_now, tb.model_number AS b_pn_now,
              ta.id IS NOT NULL AS a_exists, tb.id IS NOT NULL AS b_exists
         FROM avail_not_duplicates n
         LEFT JOIN templates ta ON ta.id = n.id_a
         LEFT JOIN templates tb ON tb.id = n.id_b`,
    )
    .all() as (NotDuplicateRow & {
    a_label: string | null; a_man_now: string | null; a_pn_now: string | null; a_exists: number;
    b_label: string | null; b_man_now: string | null; b_pn_now: string | null; b_exists: number;
  })[];
  const dropped: [string, string][] = [];
  const audit: AuditEntry[] = [];
  const del = sqlite.prepare("DELETE FROM avail_not_duplicates WHERE id_a = ? AND id_b = ?");
  for (const r of rows) {
    const changes: Record<string, unknown> = {};
    const side = (key: "a" | "b") => {
      const id = key === "a" ? r.id_a : r.id_b;
      if (!(key === "a" ? r.a_exists : r.b_exists)) return `${id} deleted`;
      const [m0, p0, m1, p1] = key === "a" ? [r.a_manufacturer, r.a_model_number, r.a_man_now, r.a_pn_now] : [r.b_manufacturer, r.b_model_number, r.b_man_now, r.b_pn_now];
      if (sameIdentity(m0, p0, m1, p1)) return null;
      changes[id] = { manufacturer: [m0, m1], modelNumber: [p0, p1] };
      return `${id} changed its manufacturer or model number`;
    };
    const why = [side("a"), side("b")].filter((x): x is string => !!x);
    if (!why.length) continue;
    dropped.push([r.id_a, r.id_b]);
    const reason = why.join("; ");
    for (const [id, other, label, otherLabel, exists] of [
      [r.id_a, r.id_b, r.a_label, r.b_label, r.a_exists],
      [r.id_b, r.id_a, r.b_label, r.a_label, r.b_exists],
    ] as const) {
      if (!exists) continue;
      audit.push({
        actor: SYSTEM_ACTOR, entity: "template", entityId: id, entityLabel: label, action: "not-duplicate",
        before: { notDuplicateOf: other, notDuplicateOfLabel: otherLabel ?? other, comment: r.comment },
        after: { removed: reason, ...(Object.keys(changes).length ? { changes } : {}) },
      });
    }
  }
  if (!dropped.length) return [];
  sqlite.transaction(() => {
    for (const [a, b] of dropped) del.run(a, b);
    writeAudit(sqlite, audit);
    sqlite.prepare(BUMP_LIBRARY_VERSION).run();
  })();
  return dropped;
}

interface TemplateIdentity {
  id: string;
  label: string;
  manufacturer: string | null;
  model_number: string | null;
}

export function registerNotDuplicateRoutes(app: UpstreamApp): void {
  app.post("/avail/templates/not-duplicates", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { ids, comment } = (body ?? {}) as { ids?: unknown; comment?: unknown };
    if (typeof comment !== "string" || !comment.trim()) return c.json({ error: "A comment is required: why these templates are different products" }, 400);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) return c.json({ error: "ids must be template ids" }, 400);
    const unique = [...new Set(ids as string[])];
    if (unique.length < 2 || unique.length > MAX_NOT_DUPLICATE_IDS) return c.json({ error: `ids must be 2 to ${MAX_NOT_DUPLICATE_IDS} different template ids` }, 400);

    const db = c.env.easyschematic_db;
    const found = new Map<string, TemplateIdentity>();
    for (const id of unique) {
      const t = await db.prepare("SELECT id, label, manufacturer, model_number FROM templates WHERE id = ?").bind(id).first<TemplateIdentity>();
      if (!t) return c.json({ error: `Template not found: ${id}` }, 404);
      found.set(id, t);
    }
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    const text = comment.trim();
    const pairs: [string, string][] = [];
    const unchanged: [string, string][] = [];
    const statements: D1PreparedStatement[] = [];
    const entries: AuditEntry[] = [];
    for (const [a, b] of allPairs(unique)) {
      const exists = await db.prepare("SELECT 1 AS x FROM avail_not_duplicates WHERE id_a = ? AND id_b = ?").bind(a, b).first();
      if (exists) {
        unchanged.push([a, b]);
        continue;
      }
      const ta = found.get(a)!;
      const tb = found.get(b)!;
      statements.push(
        db
          .prepare(
            `INSERT INTO avail_not_duplicates (id_a, id_b, a_manufacturer, a_model_number, b_manufacturer, b_model_number, comment, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(a, b, ta.manufacturer, ta.model_number, tb.manufacturer, tb.model_number, text, actor.actor),
      );
      for (const [t, o] of [[ta, tb], [tb, ta]] as const) {
        entries.push({
          ...actor, entity: "template", entityId: t.id, entityLabel: t.label, action: "not-duplicate",
          before: null, after: { notDuplicateOf: o.id, notDuplicateOfLabel: o.label, comment: text },
        });
      }
      pairs.push([a, b]);
    }
    if (statements.length) {
      await db.batch([...statements, db.prepare(BUMP_LIBRARY_VERSION)]);
      await writeAuditD1(db, entries);
    }
    return c.json({ pairs, unchanged });
  });

  app.post("/avail/templates/not-duplicates/undo", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Librarian or admin access required" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { a, b } = (body ?? {}) as { a?: unknown; b?: unknown };
    if (typeof a !== "string" || typeof b !== "string" || !a || !b || a === b) return c.json({ error: "a and b must be two template ids" }, 400);
    const [x, y] = a < b ? [a, b] : [b, a];
    const db = c.env.easyschematic_db;
    const row = await db.prepare("SELECT * FROM avail_not_duplicates WHERE id_a = ? AND id_b = ?").bind(x, y).first<NotDuplicateRow>();
    if (!row) return c.json({ error: "No such decision" }, 404);
    const label = async (id: string) => (await db.prepare("SELECT label FROM templates WHERE id = ?").bind(id).first<{ label: string }>())?.label ?? id;
    const [lx, ly] = [await label(x), await label(y)];
    const actor = auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
    await db.batch([db.prepare("DELETE FROM avail_not_duplicates WHERE id_a = ? AND id_b = ?").bind(x, y), db.prepare(BUMP_LIBRARY_VERSION)]);
    await writeAuditD1(
      db,
      ([[x, lx, y, ly], [y, ly, x, lx]] as const).map(([id, l, o, ol]) => ({
        ...actor, entity: "template" as const, entityId: id, entityLabel: l, action: "not-duplicate" as const,
        before: { notDuplicateOf: o, notDuplicateOfLabel: ol, comment: row.comment, by: row.created_by, at: row.created_at },
        after: { removed: "undone" },
      })),
    );
    return c.json({ removed: [x, y] });
  });
}
