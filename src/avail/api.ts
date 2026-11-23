/**
 * AVAIL API calls from the editor: the signed-in user's role and template statuses.
 */
import { setRole, type TemplateStatus, type UserRole } from "./libraryMode";

export function apiUrl(): string {
  return import.meta.env?.VITE_TEMPLATE_API_URL ?? "https://api.easyschematic.live";
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
