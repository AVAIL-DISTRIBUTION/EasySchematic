/**
 * AVAIL roles (step 2.1) over upstream's users.role. The database keeps upstream's values, so
 * every upstream permission check (requireModerator, authMiddleware…) works unchanged:
 *
 *   engineer  = contributor — default for a new user of our domain: schematics, the library
 *               (verified + draft), own templates, proposing a block edit (upstream submissions);
 *   assistant = assistant   — AI Assistant (step 2.5), signs in with an access token
 *               (api-avail/src/accessTokens.ts): reads the library, the audit log and the projects
 *               it has access to, creates draft templates and proposals, runs the linter and the
 *               normalizer without saving. Not a moderator, so upstream's checks refuse it the rest
 *               (approve, hide, delete, merge, roles, bulk actions);
 *   librarian = moderator   — edit, approve, hide templates, bulk operations, the audit log;
 *   admin     = admin       — everything, plus users and roles.
 *
 * Pure, no Node or browser dependencies: the API (api-avail/src/users.ts) and the editor use it.
 */
export type AvailRole = "engineer" | "assistant" | "librarian" | "admin";
/** From the least to the most privileged. */
export const AVAIL_ROLES: readonly AvailRole[] = ["engineer", "assistant", "librarian", "admin"];

/** users.role values: upstream's three and ours, "assistant" (upstream treats it as a plain user). */
export type UpstreamRole = "contributor" | "assistant" | "moderator" | "admin";

const TO_UPSTREAM: Record<AvailRole, UpstreamRole> = { engineer: "contributor", assistant: "assistant", librarian: "moderator", admin: "admin" };

/** Interface text, one whole string per role (ready for a translation table). */
export const ROLE_LABELS: Readonly<Record<AvailRole, string>> = { engineer: "Engineer", assistant: "AI Assistant", librarian: "Librarian", admin: "Admin" };

/** What each role may do, as the Users page shows it. */
export const ROLE_DESCRIPTIONS: Readonly<Record<AvailRole, string>> = {
  engineer: "Schematics, the library (verified and draft), own templates, proposing block edits",
  assistant:
    "Signs in with an access token. Reads the library, the audit log and the projects it has access to; creates draft templates and proposals; runs the linter and the normalizer without saving",
  librarian: "Everything an engineer does, plus editing, approving and hiding templates, bulk operations and the audit log",
  admin: "Everything a librarian does, plus users and roles",
};

/** users.role → AVAIL role; anything unknown is an engineer (the least privileged). */
export function availRoleOf(upstream: unknown): AvailRole {
  if (upstream === "admin") return "admin";
  if (upstream === "moderator") return "librarian";
  if (upstream === "assistant") return "assistant";
  return "engineer";
}

/** AVAIL role (or an upstream name, for upstream's own admin calls) → users.role; null when unknown. */
export function upstreamRoleOf(role: unknown): UpstreamRole | null {
  if (typeof role !== "string") return null;
  if ((AVAIL_ROLES as readonly string[]).includes(role)) return TO_UPSTREAM[role as AvailRole];
  if (role === "contributor" || role === "assistant" || role === "moderator" || role === "admin") return role;
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

export function isAssistant(upstream: unknown): boolean {
  return upstream === "assistant";
}

/** Reads the audit log and the workspace data: librarian, admin, AI Assistant. */
export function canReadAudit(upstream: unknown): boolean {
  return isLibrarianOrAdmin(upstream) || isAssistant(upstream);
}

/** The AI Assistant service account (migration 9010): System in Users, but it gets access tokens. */
export const AI_ASSISTANT_EMAIL = "claude@avail.invalid";
