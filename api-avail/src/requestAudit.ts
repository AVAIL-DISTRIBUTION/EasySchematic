/**
 * What server.ts does around each request for the audit log and user access (step 2.1):
 *
 *   - a disabled user (users.banned) is signed out: their sessions are deleted and the request
 *     runs without the cookie; a Google sign-in of a disabled user ends on ?error=account_disabled;
 *   - upstream's PUT /users/:id/role and /users/:id/ban are served by our routes (users.ts), which
 *     keep the last admin and write the log;
 *   - a write request to upstream's routes is bracketed by template snapshots, and the templates it
 *     created, changed or deleted go to the audit log with the actor.
 */
import type Database from "better-sqlite3";
import { ADMIN_TOKEN_ACTOR, snapshotTemplates, templateChanges, writeAudit, type AuditEntry, type TemplateSnapshot } from "./audit";

export interface RequestActor {
  actor: string;
  actorId: string | null;
}

const SESSION_RE = /(?:^|;\s*)session=([^\s;]+)/;

function sessionId(request: Request): string | null {
  return SESSION_RE.exec(request.headers.get("Cookie") ?? "")?.[1] ?? null;
}

/** The request without a cookie (the session of a disabled user). */
function withoutCookie(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  return new Request(request, { headers });
}

/**
 * A request from a disabled user runs signed out, and their sessions are deleted. Returns the
 * request to run and who sent it (email and id, the admin token, or anonymous).
 */
export function resolveActor(sqlite: Database.Database, request: Request, adminToken: string): { request: Request; actor: RequestActor } {
  const auth = request.headers.get("Authorization");
  const tokenActor = auth?.startsWith("Bearer ") && auth.slice(7) === adminToken ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : null;
  const sid = sessionId(request);
  if (sid) {
    const user = sqlite
      .prepare("SELECT u.id, u.email, u.banned FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now')")
      .get(sid) as { id: string; email: string; banned: number } | undefined;
    if (user?.banned) {
      sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      return { request: withoutCookie(request), actor: tokenActor ?? { actor: "anonymous", actorId: null } };
    }
    if (user) return { request, actor: tokenActor ?? { actor: user.email, actorId: user.id } };
  }
  return { request, actor: tokenActor ?? { actor: "anonymous", actorId: null } };
}

/** Upstream's user admin calls → ours (users.ts). */
export function userRouteRewrite(request: Request): Request {
  if (request.method !== "PUT") return request;
  const url = new URL(request.url);
  const m = /^\/users\/([^/]+)\/(role|ban)\/?$/.exec(url.pathname);
  if (!m) return request;
  url.pathname = `/avail/upstream/users/${m[1]}/${m[2]}`;
  return new Request(url, request);
}

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

/** Write requests whose template changes are logged here (ours under /avail log their own). */
export function auditsTemplates(request: Request): boolean {
  if (READ.has(request.method)) return false;
  const p = new URL(request.url).pathname;
  return !p.startsWith("/avail/") && !p.startsWith("/auth/");
}

/** Templates a request names: /templates/:id…, the template of /submissions/:id/…. */
export function namedTemplates(sqlite: Database.Database, request: Request): string[] {
  const p = new URL(request.url).pathname;
  const t = /^\/templates\/([^/]+)/.exec(p);
  if (t) return [decodeURIComponent(t[1])];
  const s = /^\/submissions\/([^/]+)/.exec(p);
  if (s) {
    const row = sqlite.prepare("SELECT template_id FROM submissions WHERE id = ?").get(decodeURIComponent(s[1])) as { template_id: string | null } | undefined;
    if (row?.template_id) return [row.template_id];
  }
  return [];
}

export interface TemplateAuditScope {
  snapshot: TemplateSnapshot;
  named: Set<string>;
}

export function beginTemplateAudit(sqlite: Database.Database, request: Request): TemplateAuditScope {
  const named = namedTemplates(sqlite, request);
  return { snapshot: snapshotTemplates(sqlite, named), named: new Set(named) };
}

export function endTemplateAudit(sqlite: Database.Database, scope: TemplateAuditScope, actor: RequestActor): AuditEntry[] {
  const entries = templateChanges(sqlite, scope.snapshot, scope.named, actor);
  writeAudit(sqlite, entries);
  return entries;
}

/**
 * Google sign-in of a disabled user: upstream created a session and answers with a redirect
 * page. The session is deleted and the page sends the browser to ?error=account_disabled.
 */
export async function refuseDisabledSignIn(sqlite: Database.Database, response: Response): Promise<Response> {
  const cookie = response.headers.get("Set-Cookie") ?? "";
  const sid = /(?:^|,\s*)session=([^;,\s]+)/.exec(cookie)?.[1];
  if (!sid) return response;
  const user = sqlite.prepare("SELECT u.id, u.banned FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?").get(sid) as
    | { id: string; banned: number }
    | undefined;
  if (!user?.banned) return response;
  sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  const html = await response.text();
  const dest = /url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  let target = "/?error=account_disabled";
  try {
    if (dest) target = `${new URL(dest).origin}/?error=account_disabled`;
  } catch {
    /* relative or broken destination: stay on this origin */
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0" },
  });
}

/** A proposal decision: approve or reject of an upstream submission (library workspace, step 2.2). */
export interface ProposalDecision {
  submissionId: string;
  decision: "accepted" | "rejected";
  note: string | null;
  templateId: string | null;
  label: string | null;
  submitter: string | null;
}

const PROPOSAL_RE = /^\/submissions\/([^/]+)\/(approve|reject)\/?$/;

/**
 * Reads what a POST /submissions/:id/approve|reject is about to decide (before upstream runs it:
 * the submission is still pending), with the reviewer's note from the body. Null for other requests.
 */
export async function readProposalDecision(sqlite: Database.Database, request: Request): Promise<ProposalDecision | null> {
  if (request.method !== "POST") return null;
  const m = PROPOSAL_RE.exec(new URL(request.url).pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const row = sqlite
    .prepare(
      `SELECT s.template_id, json_extract(s.data, '$.label') AS label, u.email FROM submissions s
         LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as { template_id: string | null; label: string | null; email: string | null } | undefined;
  if (!row) return null;
  let note: string | null = null;
  try {
    const body = (await request.clone().json()) as { note?: unknown };
    if (typeof body?.note === "string" && body.note.trim()) note = body.note.trim();
  } catch {
    /* no body */
  }
  return { submissionId: id, decision: m[2] === "approve" ? "accepted" : "rejected", note, templateId: row.template_id, label: row.label, submitter: row.email };
}

/** The audit entry of a decided proposal ("proposal" action of the template). */
export function proposalAuditEntry(d: ProposalDecision, actor: RequestActor): AuditEntry {
  return {
    ...actor,
    entity: "template",
    entityId: d.templateId ?? `submission:${d.submissionId}`,
    entityLabel: d.label,
    action: "proposal",
    after: { submissionId: d.submissionId, decision: d.decision, ...(d.note ? { note: d.note } : {}), ...(d.submitter ? { submitter: d.submitter } : {}) },
  };
}
