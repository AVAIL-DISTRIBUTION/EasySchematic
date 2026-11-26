/**
 * AVAIL users and audit log from the editor (api-avail/src/users.ts): GET /avail/users,
 * PUT /avail/users/:id/role and /active (admin), GET /avail/audit (librarian and admin).
 */
import { apiUrl } from "./api";
import type { AvailRole } from "./roles";

export interface AvailUser {
  id: string;
  email: string;
  name: string | null;
  role: AvailRole;
  createdAt: string;
  lastLoginAt: string | null;
  active: boolean;
  /** Service account (email on .invalid): shown as System, role and access fixed. */
  system?: boolean;
}

export interface AuditRecord {
  id: number;
  at: string;
  actor: string;
  actorId: string | null;
  entity: "user" | "template" | "run";
  entityId: string;
  entityLabel: string | null;
  action: "role" | "access" | "created" | "updated" | "deleted" | "status" | "run" | "proposal";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    credentials: "include",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const fetchUsers = () => call<AvailUser[]>("/avail/users");

export const setUserRole = (id: string, role: AvailRole) =>
  call<AvailUser>(`/avail/users/${encodeURIComponent(id)}/role`, { method: "PUT", body: JSON.stringify({ role }) });

export const setUserActive = (id: string, active: boolean) =>
  call<AvailUser>(`/avail/users/${encodeURIComponent(id)}/active`, { method: "PUT", body: JSON.stringify({ active }) });

export function fetchAudit(q: { entity?: "user" | "template" | "run"; entityId?: string; before?: number; limit?: number } = {}): Promise<AuditRecord[]> {
  const p = new URLSearchParams();
  if (q.entity) p.set("entity", q.entity);
  if (q.entityId) p.set("entityId", q.entityId);
  if (q.before) p.set("before", String(q.before));
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return call<AuditRecord[]>(`/avail/audit${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------- display

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
  if (r.action === "created") return [];
  if (r.action === "deleted") return [];
  const before = r.before ?? {};
  const after = r.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((k) => `${k}: ${short(before[k])} → ${short(after[k])}`);
}
