/**
 * AVAIL roles (step 2.1) over upstream's users.role. The database keeps upstream's values, so
 * every upstream permission check (requireModerator, authMiddleware…) works unchanged:
 *
 *   engineer  = contributor — default for a new user of our domain: schematics, the library
 *               (verified + draft), own templates, proposing a block edit (upstream submissions);
 *   librarian = moderator   — edit, approve, hide templates, bulk operations, the audit log;
 *   admin     = admin       — everything, plus users and roles.
 *
 * Pure, no Node or browser dependencies: the API (api-avail/src/users.ts) and the editor use it.
 */
export type AvailRole = "engineer" | "librarian" | "admin";
export const AVAIL_ROLES: readonly AvailRole[] = ["engineer", "librarian", "admin"];

/** Upstream users.role values. */
export type UpstreamRole = "contributor" | "moderator" | "admin";

const TO_UPSTREAM: Record<AvailRole, UpstreamRole> = { engineer: "contributor", librarian: "moderator", admin: "admin" };

/** Interface text, one whole string per role (ready for a translation table). */
export const ROLE_LABELS: Readonly<Record<AvailRole, string>> = { engineer: "Engineer", librarian: "Librarian", admin: "Admin" };

/** What each role may do, as the Users page shows it. */
export const ROLE_DESCRIPTIONS: Readonly<Record<AvailRole, string>> = {
  engineer: "Schematics, the library (verified and draft), own templates, proposing block edits",
  librarian: "Everything an engineer does, plus editing, approving and hiding templates, bulk operations and the audit log",
  admin: "Everything a librarian does, plus users and roles",
};

/** users.role → AVAIL role; anything unknown is an engineer (the least privileged). */
export function availRoleOf(upstream: unknown): AvailRole {
  if (upstream === "admin") return "admin";
  if (upstream === "moderator") return "librarian";
  return "engineer";
}

/** AVAIL role (or an upstream name, for upstream's own admin calls) → users.role; null when unknown. */
export function upstreamRoleOf(role: unknown): UpstreamRole | null {
  if (typeof role !== "string") return null;
  if ((AVAIL_ROLES as readonly string[]).includes(role)) return TO_UPSTREAM[role as AvailRole];
  if (role === "contributor" || role === "moderator" || role === "admin") return role;
  return null;
}

export function isLibrarianOrAdmin(upstream: unknown): boolean {
  return upstream === "moderator" || upstream === "admin";
}

/**
 * Service accounts (the authors of automatic notes and changes, e.g. vendor-responses@avail.invalid):
 * an email on the reserved .invalid domain nobody can sign in with. The Users page marks them
 * System; their role and access cannot be changed.
 */
export function isSystemAccount(email: unknown): boolean {
  return typeof email === "string" && /\.invalid$/i.test(email.trim());
}
