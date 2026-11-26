/**
 * AVAIL API calls from the editor: the signed-in user's role, template statuses, and
 * loading/saving a library template for the Edit flow.
 */
import type { DeviceTemplate } from "../types";
import { setRole, type TemplateStatus, type UserRole } from "./libraryMode";
import { DEFAULT_API_URL } from "./upstream";
import { apiError } from "./apiError";

export function apiUrl(): string {
  return import.meta.env?.VITE_TEMPLATE_API_URL ?? DEFAULT_API_URL;
}

let rolePromise: Promise<UserRole | null> | null = null;

/** Role of the signed-in user (GET /auth/me), once per page load; null when signed out. */
export function loadRole(force = false): Promise<UserRole | null> {
  if (!rolePromise || force) {
    rolePromise = fetch(`${apiUrl()}/auth/me`, { credentials: "include" })
      .then(async (res) => (res.ok ? (((await res.json()) as { role?: UserRole }).role ?? null) : null))
      .catch(() => null)
      .then((role) => {
        setRole(role);
        return role;
      });
  }
  return rolePromise;
}

export interface StatusChangeError {
  message: string;
  level?: string;
  errors?: string[];
  warnings?: string[];
}

/** PUT /avail/templates/:id/status; throws StatusChangeError (with lint lists on a refused verify). */
export async function changeTemplateStatus(templateId: string, status: TemplateStatus): Promise<void> {
  const res = await fetch(`${apiUrl()}/avail/templates/${encodeURIComponent(templateId)}/status`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; level?: string; errors?: string[]; warnings?: string[] };
  const err: StatusChangeError = {
    message: body.error ?? `HTTP ${res.status}`,
    level: body.level,
    errors: body.errors,
    warnings: body.warnings,
  };
  throw err;
}

export interface TemplateStatusInfo {
  templateId: string;
  status: TemplateStatus;
  lintLevel: string | null;
  statusReason: string | null;
  statusChangedAt: string | null;
  approvedVia?: "review" | "bulk" | "bulk-source" | null;
  approvedAt?: string | null;
  updatedBy?: string | null;
}

/** GET /avail/templates/:id/status; null when unknown or unreachable. */
export async function fetchTemplateStatus(templateId: string): Promise<TemplateStatusInfo | null> {
  try {
    const res = await fetch(`${apiUrl()}/avail/templates/${encodeURIComponent(templateId)}/status`, { credentials: "include" });
    return res.ok ? ((await res.json()) as TemplateStatusInfo) : null;
  } catch {
    return null;
  }
}

export interface TemplateNote {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

/** GET /templates/:id/notes (upstream moderator notes; vendor answers land here); [] when not allowed or unreachable. */
export async function fetchTemplateNotes(templateId: string): Promise<TemplateNote[]> {
  try {
    const res = await fetch(`${apiUrl()}/templates/${encodeURIComponent(templateId)}/notes`, { credentials: "include" });
    return res.ok ? ((await res.json()) as TemplateNote[]) : [];
  } catch {
    return [];
  }
}

/** The stored template, fresh from the database (GET /templates/:id, not the cached library). */
export async function fetchLibraryTemplate(templateId: string): Promise<DeviceTemplate> {
  const res = await fetch(`${apiUrl()}/templates/${encodeURIComponent(templateId)}`, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load the template (HTTP ${res.status})`);
  return (await res.json()) as DeviceTemplate;
}

/** PUT /templates/:id (moderator/admin session); throws ApiError (409 duplicate: with the existing template). */
export async function saveLibraryTemplate(templateId: string, template: Omit<DeviceTemplate, "id" | "version">): Promise<void> {
  const res = await fetch(`${apiUrl()}/templates/${encodeURIComponent(templateId)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  if (res.ok) return;
  throw apiError(res.status, await res.json().catch(() => ({})));
}

export interface BatchStatusFailure {
  id: string;
  label: string | null;
  reason: "not_found" | "not_level_a";
  level?: string;
  errors?: string[];
  warnings?: string[];
}

export interface BatchStatusResult {
  status: TemplateStatus;
  updated: string[];
  failed: BatchStatusFailure[];
}

/** POST /avail/templates/status/batch: the server checks every template (verified only at level A). */
export async function changeTemplatesStatus(ids: string[], status: TemplateStatus): Promise<BatchStatusResult> {
  const res = await fetch(`${apiUrl()}/avail/templates/status/batch`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, status }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<BatchStatusResult> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { status, updated: body.updated ?? [], failed: body.failed ?? [] };
}
