/**
 * Audit log entries as text (pure: the editor, the library workspace and the API's MCP server use
 * it). The API client is adminApi.ts.
 */

export interface AuditRecord {
  id: number;
  at: string;
  actor: string;
  actorId: string | null;
  entity: "user" | "template" | "run";
  entityId: string;
  entityLabel: string | null;
  action: "role" | "access" | "created" | "updated" | "deleted" | "status" | "run" | "proposal" | "not-duplicate" | "token" | "request" | "proposed" | "override";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The access token the change was made with (its name). */
  token?: string | null;
}

/** Who did it: the actor, and the token when it was done with one. */
export function auditActor(r: AuditRecord): string {
  return r.token ? `${r.actor} (token “${r.token}”)` : r.actor;
}

/** Action of an audit entry, one whole string each (ready for a translation table). */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditRecord["action"], string>> = {
  role: "Role changed",
  access: "Access changed",
  created: "Template created",
  updated: "Template edited",
  deleted: "Template deleted",
  status: "Status changed",
  run: "Command run",
  proposal: "Proposal decided",
  "not-duplicate": "Not a duplicate",
  token: "Access token",
  request: "API request",
  proposed: "Change proposed",
  override: "Override",
};

function short(v: unknown, max = 60): string {
  if (v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * "field: before → after" lines of an entry. A created template lists nothing (the whole
 * template is new), a deleted one says so; ports and other long values are shortened.
 */
export function auditChanges(r: AuditRecord): string[] {
  if (r.action === "run") {
    const a = r.after ?? {};
    const counts = (a.counts ?? {}) as Record<string, number>;
    const totals = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
    return [...(totals ? [totals] : []), `commit ${String(a.commit ?? "unknown").slice(0, 12)}`];
  }
  if (r.action === "proposal") {
    const a = r.after ?? {};
    const who = typeof a.submitter === "string" ? ` (proposed by ${a.submitter})` : "";
    const note = typeof a.note === "string" ? `: ${a.note}` : "";
    return [`${a.decision === "accepted" ? "Accepted" : "Rejected"}${who}${note}`];
  }
  if (r.action === "not-duplicate") {
    const b = r.before ?? {};
    const a = r.after ?? {};
    if (typeof a.notDuplicateOf === "string") return [`Marked as not a duplicate of ${String(a.notDuplicateOfLabel ?? a.notDuplicateOf)}: ${String(a.comment ?? "")}`];
    const of = String(b.notDuplicateOfLabel ?? b.notDuplicateOf ?? "?");
    return [a.removed === "undone" ? `Undone: not a duplicate of ${of}` : `Decision on ${of} removed: ${String(a.removed ?? "")}`];
  }
  if (r.action === "token") {
    const a = r.after ?? {};
    if (typeof a.created === "string") return [`Created “${a.created}”, expires ${String(a.expiresAt ?? "").slice(0, 10)}`];
    return [`Revoked “${String(a.revoked ?? "")}”: ${String(a.reason ?? "")}`];
  }
  if (r.action === "request") {
    const a = r.after ?? {};
    return [`${String(a.method ?? "")} ${String(a.path ?? "")} → ${String(a.status ?? "")}`];
  }
  if (r.action === "proposed") {
    const a = r.after ?? {};
    const changes = Array.isArray(a.changes) ? a.changes.map((x) => `  ${String(x)}`) : [];
    return [`Proposal ${String(a.proposal ?? "")}: ${String(a.comment ?? "")}`, ...changes];
  }
  if (r.action === "override") {
    const a = r.after ?? {};
    const b = r.before ?? {};
    if (Array.isArray(a.added)) return [`Overrides from ${String(a.source ?? "")}:`, ...a.added.map((x) => `  ${String(x)}`)];
    return [`Override removed (${String(b.source ?? "")}): ${String(b.override ?? "")}`];
  }
  if (r.action === "created") return [];
  if (r.action === "deleted") return [];
  const before = r.before ?? {};
  const after = r.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((k) => `${k}: ${short(before[k])} → ${short(after[k])}`);
}
