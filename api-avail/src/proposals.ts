/**
 * Proposals as edits, not snapshots (step 2.9; table avail_proposals, migration 9014; the logic is
 * src/avail/templatePatch.ts).
 *
 * A proposal stores what it changes (patch: top-level fields, ports by id) and the template it was
 * built on (version, stored form). Upstream's submissions.data still holds a whole template (its routes
 * need one), but Accept no longer writes that snapshot: server.ts applies the patch to the template as
 * it is now and hands upstream the result (approve's `data`). A field or port the patch changes that
 * has changed since is a conflict: Accept answers 409 with "at creation / now / proposed" until the
 * librarian chooses (`resolutions: { <key>: "current" | "proposed" }`).
 *
 *   POST /avail/proposals                 any signed-in user: { templateId, patch | data, comment }
 *                                         → { id, status, changes }; limits per hour and pending:
 *                                         librarian / admin through Claude (a token) 200, else 30 (as
 *                                         upstream's POST /submissions, which keeps working and gets
 *                                         its patch recorded too)
 *   GET  /avail/proposals/pending         librarian, admin, AI Assistant: per pending update proposal
 *                                         its base, patch, changes and conflicts with the template now
 *   POST /avail/proposals/:id/withdraw    the author: a pending proposal is withdrawn
 *
 * On Accept, overrides are recorded only for what the patch changes (overrides.ts), and a comment
 * with a link to a document (a PDF, a data sheet) makes it the template's ports source (datasheet)
 * when the patch changes ports.
 */
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken, requireSession } from "../../api/src/auth";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { validateTemplate } from "../../api/src/validate";
import { canReadAudit, isLibrarianOrAdmin } from "../../src/avail/roles";
import {
  applyPatchResolved,
  applyTemplatePatch,
  describeEditChanges,
  editChanges,
  NO_CHANGE_ERROR,
  patchConflicts,
  patchFromEdit,
  patchIsEmpty,
  patchScope,
  storedForm,
  type PatchConflict,
  type Resolution,
  type TemplatePatch,
} from "../../src/avail/templatePatch";
import { requestContext, writeAudit } from "./audit";
import type { D1DatabaseShim } from "./d1";
import type { RequestActor } from "./requestAudit";

type UpstreamApp = typeof UpstreamAppValue;
type Obj = Record<string, unknown>;

/** Proposals an hour and pending at once: upstream's limit, and librarians / admins through Claude. */
export const PROPOSAL_LIMIT = 30;
export const CONNECTOR_PROPOSAL_LIMIT = 200;

export interface ProposalRow {
  submission_id: string;
  template_id: string;
  base_version: number;
  base: string;
  patch: string;
  created_at: string;
}

const sqliteOf = (c: { env: { easyschematic_db: D1Database } }) => (c.env.easyschematic_db as unknown as D1DatabaseShim).sqlite;

function hasTable(sqlite: Database.Database): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'avail_proposals'").get();
}

const templateNow = (sqlite: Database.Database, id: string) => sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;

/** The template as the library stores it (what a patch is built on and applied to). */
const storedOf = (row: TemplateRow) => storedForm(rowToTemplate(row));

/** As approval would store it: the row round trip, so the patch holds only real changes. */
function asStored(data: Obj, row: TemplateRow): Obj {
  return storedForm(rowToTemplate({ ...templateToRow({ ...(data as object), id: row.id } as never), version: row.version } as TemplateRow));
}

export function recordProposal(sqlite: Database.Database, submissionId: string, row: TemplateRow, patch: TemplatePatch): void {
  sqlite
    .prepare("INSERT OR REPLACE INTO avail_proposals (submission_id, template_id, base_version, base, patch) VALUES (?, ?, ?, ?, ?)")
    .run(submissionId, row.id, row.version, JSON.stringify(storedOf(row)), JSON.stringify(patch));
}

// ---------------------------------------------------------------------------- upstream POST /submissions

/** An update proposal through upstream's route (the editor, the API): its patch, recorded after upstream accepts it. */
export async function beginSubmissionPatch(sqlite: Database.Database, request: Request): Promise<{ row: TemplateRow; patch: TemplatePatch } | null> {
  if (request.method !== "POST" || new URL(request.url).pathname.replace(/\/$/, "") !== "/submissions" || !hasTable(sqlite)) return null;
  let body: { action?: unknown; templateId?: unknown; data?: unknown };
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (body?.action !== "update" || typeof body.templateId !== "string") return null;
  const row = templateNow(sqlite, body.templateId);
  const v = validateTemplate(body.data);
  if (!row || !v.ok) return null;
  return { row, patch: patchFromEdit(storedOf(row), asStored(v.data as unknown as Obj, row)) };
}

export async function endSubmissionPatch(sqlite: Database.Database, scope: { row: TemplateRow; patch: TemplatePatch }, response: Response): Promise<void> {
  if (response.status >= 300) return;
  const b = (await response.clone().json().catch(() => null)) as { id?: unknown } | null;
  if (typeof b?.id === "string") recordProposal(sqlite, b.id, scope.row, scope.patch);
}

// ---------------------------------------------------------------------------- Accept

export interface ApprovePlan {
  submissionId: string;
  templateId: string;
  patch: TemplatePatch;
  /** The approve request with `data` = the patch applied to the template now. */
  request: Request;
}

export interface ApproveRefusal {
  status: 409;
  body: { error: string; conflicts: PatchConflict[] };
}

/**
 * POST /submissions/:id/approve of a proposal with a patch: the request upstream should run (data =
 * the patch over the template now, conflicts resolved) or the 409 refusal listing the conflicts.
 * Null for anything else (and when the librarian sends their own `data`: that wins, as upstream's).
 */
export async function prepareApprove(sqlite: Database.Database, request: Request): Promise<ApprovePlan | ApproveRefusal | null> {
  if (request.method !== "POST" || !hasTable(sqlite)) return null;
  const m = /^\/submissions\/([^/]+)\/approve\/?$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const p = sqlite
    .prepare("SELECT p.* FROM avail_proposals p JOIN submissions s ON s.id = p.submission_id WHERE p.submission_id = ? AND s.status IN ('pending', 'deferred')")
    .get(id) as ProposalRow | undefined;
  if (!p) return null;
  let body: Obj = {};
  try {
    body = ((await request.clone().json()) as Obj) ?? {};
  } catch {
    /* no body */
  }
  if (body.data && typeof body.data === "object") return null;
  const row = templateNow(sqlite, p.template_id);
  if (!row) return null; // upstream answers
  const base = JSON.parse(p.base) as Obj;
  const patch = JSON.parse(p.patch) as TemplatePatch;
  const resolutions = (body.resolutions && typeof body.resolutions === "object" ? body.resolutions : {}) as Record<string, Resolution>;
  const conflicts = patchConflicts(base, storedOf(row), patch);
  const open = conflicts.filter((c) => resolutions[c.key] !== "current" && resolutions[c.key] !== "proposed");
  if (open.length) {
    return {
      status: 409,
      body: {
        error: `The template changed since this proposal was made: ${open.map((c) => c.label).join("; ")}. Choose for each: keep the current value or take the proposed one.`,
        conflicts: open,
      },
    };
  }
  const data = applyPatchResolved(storedOf(row), base, patch, resolutions);
  const { resolutions: _r, ...rest } = body;
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return {
    submissionId: id,
    templateId: row.id,
    patch,
    request: new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...rest, data }) }),
  };
}

/** A link to a manufacturer document in a proposal's comment: a PDF, or a data sheet / spec page. */
export function documentLink(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const urls = comment.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const clean = urls.map((u) => u.replace(/[.,;:]+$/, ""));
  return clean.find((u) => /\.pdf(?:[?#]|$)/i.test(u)) ?? clean.find((u) => /data-?sheet|spec/i.test(u)) ?? null;
}

/**
 * After Accept: a comment linking a document makes it the ports source (datasheet) when the patch
 * changed ports, and the template's data sheet link when it has none. Logged.
 */
export function applyProposalSource(sqlite: Database.Database, plan: ApprovePlan, actor: RequestActor): void {
  const s = sqlite.prepare("SELECT submitter_note FROM submissions WHERE id = ?").get(plan.submissionId) as { submitter_note: string | null } | undefined;
  const url = documentLink(s?.submitter_note);
  if (!url) return;
  const meta = sqlite.prepare("SELECT catalog FROM avail_template_meta WHERE template_id = ?").get(plan.templateId) as { catalog: string | null } | undefined;
  let catalog: Obj = {};
  try {
    catalog = meta?.catalog ? (JSON.parse(meta.catalog) as Obj) : {};
  } catch {
    catalog = {};
  }
  const before = { portsSource: catalog.portsSource ?? null, datasheetUrl: catalog.datasheetUrl ?? null };
  const portsChanged = patchScope(plan.patch).ports.size > 0;
  const next: Obj = { ...catalog };
  if (portsChanged) next.portsSource = { kind: "datasheet", from: url, note: `proposal ${plan.submissionId}` };
  if (!next.datasheetUrl) next.datasheetUrl = url;
  const after = { portsSource: next.portsSource ?? null, datasheetUrl: next.datasheetUrl ?? null };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const label = (sqlite.prepare("SELECT label FROM templates WHERE id = ?").get(plan.templateId) as { label: string } | undefined)?.label ?? null;
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO avail_template_meta (template_id, status, catalog, updated_by, updated_at) VALUES (?, 'raw', ?, ?, datetime('now'))
         ON CONFLICT(template_id) DO UPDATE SET catalog = excluded.catalog, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(plan.templateId, JSON.stringify(next), actor.actor);
    writeAudit(sqlite, [{ ...actor, entity: "template", entityId: plan.templateId, entityLabel: label, action: "updated", before, after }]);
  })();
}

// ---------------------------------------------------------------------------- routes

const NO_STORE = { "Cache-Control": "no-store" };

/** Refusals of prepareApprove, answered by an internal route (CORS applies), keyed by the request. */
export const PROPOSAL_REFUSAL_PATH = "/avail/internal/proposal-conflict";
export const pendingProposalRefusals = new WeakMap<Request, ApproveRefusal>();

export function registerProposalRoutes(app: UpstreamApp): void {
  app.all(PROPOSAL_REFUSAL_PATH, (c) => {
    const r = pendingProposalRefusals.get(c.req.raw);
    return r ? c.json(r.body, r.status, NO_STORE) : c.json({ error: "Not found" }, 404);
  });

  app.post("/avail/proposals", async (c) => {
    const user = requireSession(c);
    if (!user) return c.json({ error: "Sign in first" }, 401);
    let body: { templateId?: unknown; patch?: unknown; data?: unknown; comment?: unknown };
    try {
      body = ((await c.req.json()) ?? {}) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 1000) : "";
    if (!comment) return c.json({ error: "A comment is required: what is wrong and where the right value comes from" }, 400);
    if (typeof body.templateId !== "string") return c.json({ error: "templateId is required" }, 400);
    if ((body.patch === undefined) === (body.data === undefined)) return c.json({ error: "Send either patch or data" }, 400);
    const sqlite = sqliteOf(c);
    const row = templateNow(sqlite, body.templateId);
    if (!row) return c.json({ error: `Template not found: ${body.templateId}` }, 404);

    // Limits: as upstream's POST /submissions, higher for librarians and admins through Claude.
    const viaClaude = !!requestContext.getStore()?.token;
    const limit = viaClaude && isLibrarianOrAdmin(user.role) ? CONNECTOR_PROPOSAL_LIMIT : PROPOSAL_LIMIT;
    const counts = sqlite
      .prepare(
        `SELECT SUM(created_at > datetime('now', '-1 hour')) AS hour, SUM(status = 'pending') AS pending FROM submissions WHERE user_id = ?`,
      )
      .get(user.id) as { hour: number | null; pending: number | null };
    if ((counts.hour ?? 0) >= limit) return c.json({ error: `Proposal limit: at most ${limit} an hour for you. Try again later.` }, 429);
    if ((counts.pending ?? 0) >= limit) return c.json({ error: `You have ${limit} or more proposals waiting for review. Wait until librarians decide some.` }, 429);

    const current = storedOf(row);
    let proposed: Obj;
    if (body.patch !== undefined) {
      const r = applyTemplatePatch(current, body.patch as Obj);
      if ("error" in r) return c.json({ error: r.error }, 400);
      proposed = r.template;
    } else proposed = storedForm(body.data as Obj);
    const v = validateTemplate(proposed);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const data = asStored(v.data as unknown as Obj, row);
    const patch = patchFromEdit(current, data);
    if (patchIsEmpty(patch)) return c.json({ error: NO_CHANGE_ERROR }, 400);
    const id = crypto.randomUUID();
    sqlite.transaction(() => {
      sqlite
        .prepare("INSERT INTO submissions (id, user_id, action, template_id, data, submitter_note, source) VALUES (?, ?, 'update', ?, ?, ?, 'manual')")
        .run(id, user.id, row.id, JSON.stringify(data), comment);
      recordProposal(sqlite, id, row, patch);
    })();
    return c.json({ id, status: "pending", changes: describeEditChanges(editChanges(current, data)) }, 201, NO_STORE);
  });

  app.get("/avail/proposals/pending", (c) => {
    if (!requireModeratorOrToken(c) && !canReadAudit(c.get("user")?.role)) return c.json({ error: "Librarian, admin or AI Assistant access required" }, 403);
    const sqlite = sqliteOf(c);
    const subs = sqlite
      .prepare("SELECT s.id, s.template_id FROM submissions s WHERE s.action = 'update' AND s.status IN ('pending', 'deferred') ORDER BY s.created_at")
      .all() as { id: string; template_id: string | null }[];
    const out = subs.map((s) => {
      const p = sqlite.prepare("SELECT * FROM avail_proposals WHERE submission_id = ?").get(s.id) as ProposalRow | undefined;
      const row = s.template_id ? templateNow(sqlite, s.template_id) : undefined;
      if (!p || !row) return { id: s.id, templateId: s.template_id, legacy: true };
      const base = JSON.parse(p.base) as Obj;
      const patch = JSON.parse(p.patch) as TemplatePatch;
      const now = storedOf(row);
      return {
        id: s.id,
        templateId: row.id,
        legacy: false,
        baseVersion: p.base_version,
        currentVersion: row.version,
        base,
        patch,
        changes: describeEditChanges(editChanges(base, applyPatchResolved(base, base, patch))),
        conflicts: patchConflicts(base, now, patch),
      };
    });
    return c.json(out, 200, NO_STORE);
  });

  app.post("/avail/proposals/:id/withdraw", (c) => {
    const user = requireSession(c);
    if (!user) return c.json({ error: "Sign in first" }, 401);
    const sqlite = sqliteOf(c);
    const s = sqlite
      .prepare("SELECT s.id, s.user_id, s.status, s.template_id, json_extract(s.data, '$.label') AS label FROM submissions s WHERE s.id = ?")
      .get(c.req.param("id")) as { id: string; user_id: string; status: string; template_id: string | null; label: string | null } | undefined;
    if (!s) return c.json({ error: "Proposal not found" }, 404);
    if (s.user_id !== user.id) return c.json({ error: "Only the author can withdraw a proposal" }, 403);
    if (s.status !== "pending" && s.status !== "deferred") return c.json({ error: `The proposal is already ${s.status}` }, 409);
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE submissions SET status = 'withdrawn', reviewed_at = datetime('now'), claimed_by = NULL, claimed_at = NULL WHERE id = ?").run(s.id);
      writeAudit(sqlite, [{
        actor: user.email, actorId: user.id, entity: "template", entityId: s.template_id ?? `submission:${s.id}`, entityLabel: s.label, action: "proposal",
        after: { submissionId: s.id, decision: "withdrawn" },
      }]);
    })();
    return c.json({ id: s.id, status: "withdrawn" });
  });
}
