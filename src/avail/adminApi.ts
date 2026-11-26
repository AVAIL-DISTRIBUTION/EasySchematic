/**
 * AVAIL users and audit log from the editor (api-avail/src/users.ts): GET /avail/users,
 * PUT /avail/users/:id/role and /active (admin), GET /avail/audit (librarian and admin).
 */
import { apiUrl } from "./api";
import type { AvailRole } from "./roles";
import type { AuditRecord } from "./auditText";

export { AUDIT_ACTION_LABELS, auditActor, auditChanges, type AuditRecord } from "./auditText";

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
  /** Access tokens that work now (AI Assistant users). */
  activeTokens?: number;
}

/** An AI Assistant's access token as the admin sees it (no value: shown once, when created). */
export interface AccessToken {
  id: string;
  userId: string;
  name: string;
  hint: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  state: "active" | "expired" | "revoked";
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

export const fetchTokens = (userId: string) => call<AccessToken[]>(`/avail/users/${encodeURIComponent(userId)}/tokens`);

export const createToken = (userId: string, name: string, expiresAt: string) =>
  call<{ token: AccessToken; value: string }>(`/avail/users/${encodeURIComponent(userId)}/tokens`, { method: "POST", body: JSON.stringify({ name, expiresAt }) });

export const revokeToken = (id: string) => call<AccessToken>(`/avail/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });

/** Expiry choices for a new token: days from today → the date (YYYY-MM-DD). */
export const TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export function expiryDate(days: number, today: Date = new Date()): string {
  return new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}


export function fetchAudit(q: { entity?: "user" | "template" | "run"; entityId?: string; before?: number; limit?: number } = {}): Promise<AuditRecord[]> {
  const p = new URLSearchParams();
  if (q.entity) p.set("entity", q.entity);
  if (q.entityId) p.set("entityId", q.entityId);
  if (q.before) p.set("before", String(q.before));
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return call<AuditRecord[]>(`/avail/audit${qs ? `?${qs}` : ""}`);
}
