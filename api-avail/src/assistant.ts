/**
 * What the AI Assistant role does beyond a plain user (step 2.5; roles in src/avail/roles.ts):
 *
 *   POST /avail/templates/draft   AI Assistant, librarian, admin: a new template, status draft
 *                                 (meta source "ai-assistant"), checked like POST /templates
 *                                 (upstream validation; 409 on a duplicate, server.ts guard);
 *                                 → { template, status, level, errors, warnings }. Logged as created.
 *   POST /avail/lint              any signed-in user: { template } → the linter's result with the
 *                                 library's slot context and the template's lifecycle (its own
 *                                 `_avail` / `availLifecycle`, else the stored one by id); nothing is saved
 *   POST /avail/normalize         any signed-in user: { template } → { template, changes, before,
 *                                 after } — the normalizer and the linter before and after; nothing
 *                                 is saved
 *
 * Reading: the library (GET /templates…), the workspace data and the audit log (routes.ts,
 * workspace.ts, users.ts allow the role). Proposals are upstream's POST /submissions. Approving,
 * hiding, deleting, merging, roles and bulk actions stay librarian / admin only.
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireAdminOrToken, requireSession } from "../../api/src/auth";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { validateTemplate } from "../../api/src/validate";
import { lintBlock } from "../../src/avail/blockLint";
import { normalizeBlock } from "../../src/avail/normalize";
import { ACTIVE, carriedLifecycle, lifecycleOfColumns, withLifecycle } from "../../src/avail/lifecycle";
import { isAssistant, isLibrarianOrAdmin } from "../../src/avail/roles";
import { ADMIN_TOKEN_ACTOR, writeAuditD1 } from "./audit";
import { BUMP_LIBRARY_VERSION, slotContextOfRows, storedAvail } from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;
type Ctx = Parameters<typeof requireSession>[0];

export const DRAFT_SOURCE = "ai-assistant";

async function templateOf(c: Ctx): Promise<{ template: Record<string, unknown> } | { error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { error: "Invalid JSON" };
  }
  const t = (body as { template?: unknown } | null)?.template;
  return t && typeof t === "object" && !Array.isArray(t) ? { template: t as Record<string, unknown> } : { error: "Send { template: { … } }" };
}

async function slotContext(db: D1Database) {
  const { results } = await db.prepare("SELECT slot_family, slots FROM templates WHERE flagged_for_deletion = 0").all<{ slot_family: string | null; slots: string | null }>();
  return slotContextOfRows(results);
}

/**
 * A template as the linter sees it on save: with the stored template's catalog notes, description,
 * rackForm and lifecycle when it names one by id; what the template carries itself wins (`_avail`,
 * `availLifecycle` of get_template raw). So a preview of an upcoming product's estimates ("estimated
 * from …") does not lower its level.
 */
async function asSaved(db: D1Database, t: Record<string, unknown>): Promise<Record<string, unknown>> {
  const own = carriedLifecycle(t);
  const m =
    typeof t.id === "string" && t.id
      ? await db
          .prepare("SELECT catalog, lifecycle, available_from, eol_date FROM avail_template_meta WHERE template_id = ?")
          .bind(t.id)
          .first<{ catalog: string | null; lifecycle: string | null; available_from: string | null; eol_date: string | null }>()
      : null;
  const lc = own ?? (m ? lifecycleOfColumns(m) : ACTIVE);
  const { avail, rackForm } = storedAvail(m?.catalog, lc);
  const mine = t._avail && typeof t._avail === "object" ? (t._avail as Record<string, unknown>) : {};
  const out = withLifecycle({ ...t, ...(rackForm && t.rackForm === undefined ? { rackForm } : {}), _avail: { ...avail, ...mine } }, lc);
  if (!Object.keys(out._avail as object).length) delete (out as { _avail?: unknown })._avail;
  return out;
}

/** Signed in (session, AI Assistant token) or the admin token. */
const signedIn = (c: Ctx) => !!requireSession(c) || !!requireAdminOrToken(c);

export function registerAssistantRoutes(app: UpstreamApp): void {
  app.post("/avail/templates/draft", async (c) => {
    const user = requireSession(c);
    const token = !user && requireAdminOrToken(c) === "token";
    if (!token && !(user && (isAssistant(user.role) || isLibrarianOrAdmin(user.role)))) {
      return c.json({ error: "AI Assistant, librarian or admin access required" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const result = validateTemplate(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    const db = c.env.easyschematic_db;
    const id = crypto.randomUUID();
    const row = { ...templateToRow({ ...result.data, id }), version: 1, submitted_by: user?.id ?? null };
    const cols = Object.keys(row);
    const actor = user ? { actor: user.email, actorId: user.id } : { actor: ADMIN_TOKEN_ACTOR, actorId: null };
    await db.batch([
      db.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((k) => (row as Record<string, unknown>)[k])),
      db
        .prepare(
          `INSERT INTO avail_template_meta (template_id, status, source, status_reason, status_changed_at, updated_by, updated_at)
           VALUES (?, 'draft', ?, ?, datetime('now'), ?, datetime('now'))`,
        )
        .bind(id, DRAFT_SOURCE, `draft by ${actor.actor}`, actor.actor),
      db.prepare(BUMP_LIBRARY_VERSION),
    ]);
    const saved = await db.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<TemplateRow>();
    const template = rowToTemplate(saved!);
    await writeAuditD1(db, [{
      ...actor, entity: "template", entityId: id, entityLabel: template.label, action: "created",
      before: null, after: { status: "draft", source: DRAFT_SOURCE },
    }]);
    const lint = lintBlock(template, await slotContext(db));
    return c.json({ template, status: "draft", level: lint.level, errors: lint.errors, warnings: lint.warnings }, 201);
  });

  app.post("/avail/lint", async (c) => {
    if (!signedIn(c)) return c.json({ error: "Sign in first" }, 401);
    const t = await templateOf(c);
    if ("error" in t) return c.json({ error: t.error }, 400);
    return c.json(lintBlock(await asSaved(c.env.easyschematic_db, t.template), await slotContext(c.env.easyschematic_db)));
  });

  app.post("/avail/normalize", async (c) => {
    if (!signedIn(c)) return c.json({ error: "Sign in first" }, 401);
    const t = await templateOf(c);
    if ("error" in t) return c.json({ error: t.error }, 400);
    const ctx = await slotContext(c.env.easyschematic_db);
    const r = normalizeBlock(t.template);
    const db = c.env.easyschematic_db;
    return c.json({ template: r.template, changes: r.changes, before: lintBlock(await asSaved(db, t.template), ctx), after: lintBlock(await asSaved(db, r.template), ctx) });
  });
}
