/**
 * AVAIL: sign-in settings for our deployment (Google Workspace only).
 *
 * VITE_AUTH_GOOGLE_ONLY=1 at build time hides email (magic-link) sign-in in the login
 * dialog; the API side is DISABLE_MAGIC_LINK=1. The API reports a refused Google
 * sign-in by redirecting back with ?error=<code>; readAuthError() turns that into a
 * message for AuthErrorNotice.
 */

type Env = Record<string, string | boolean | undefined>;

export function isGoogleOnly(env: Env = import.meta.env ?? {}): boolean {
  const v = env.VITE_AUTH_GOOGLE_ONLY;
  return v === true || v === "1" || v === "true";
}

/** Error codes api/src redirects with from /auth/google/callback. */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Sign-in is limited to AVAIL Google Workspace accounts. Please sign in with your work account.",
  email_not_verified: "The email address of this Google account is not verified.",
  account_conflict: "This email address is already linked to another Google account.",
  oauth_denied: "Google sign-in was cancelled.",
  oauth_failed: "Google did not confirm the sign-in. Please try again.",
  expired: "The sign-in took too long. Please try again.",
};

export interface AuthError {
  code: string;
  message: string;
}

/** The sign-in error carried in a query string, or null if there is none we know. */
export function readAuthError(search: string): AuthError | null {
  const code = new URLSearchParams(search).get("error");
  if (!code || !(code in AUTH_ERROR_MESSAGES)) return null;
  return { code, message: AUTH_ERROR_MESSAGES[code] };
}

/** The same URL without the ?error= parameter, for history.replaceState. */
export function withoutAuthError(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("error");
  return url.pathname + (url.search === "?" ? "" : url.search) + url.hash;
}
