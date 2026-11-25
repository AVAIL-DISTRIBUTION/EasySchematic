/**
 * AVAIL: the signed-in user, as the sign-in gate learned it (GET /auth/me), and the
 * decision the gate takes on page load. No React here (the gate is AuthGate.tsx).
 *
 * The AVAIL build has no landing page: a signed-out visitor is sent straight to Google
 * sign-in and comes back to the editor. The gate shows its own screen instead of
 * redirecting when that would loop or cannot work: the API refused the sign-in
 * (?error=…), the browser came back from Google still signed out (cookies blocked),
 * or the API is unreachable.
 */
import { apiUrl } from "./api";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

let current: SessionUser | null = null;

export function getSignedInUser(): SessionUser | null {
  return current;
}

export function setSignedInUser(user: SessionUser | null): void {
  current = user;
}

/** Name for the title block and other "who" fields: the Google name, else the email. */
export function displayNameOf(user: SessionUser | null): string {
  if (!user) return "";
  return user.name?.trim() || user.email;
}

export type SessionCheck =
  | { kind: "signed-in"; user: SessionUser }
  | { kind: "signed-out" }
  | { kind: "unreachable" };

/** GET /auth/me: 200 — signed in, 401/403 — signed out, anything else — unreachable. */
export async function fetchSession(fetchImpl: typeof fetch = fetch, base = apiUrl()): Promise<SessionCheck> {
  try {
    const res = await fetchImpl(`${base}/auth/me`, { credentials: "include" });
    if (res.ok) {
      const user = (await res.json()) as SessionUser;
      if (user && typeof user.id === "string") return { kind: "signed-in", user };
      return { kind: "unreachable" };
    }
    if (res.status === 401 || res.status === 403) return { kind: "signed-out" };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

/** sessionStorage key: when the gate last sent this tab to Google. */
export const REDIRECT_MARK_KEY = "avail.signin.redirectedAt";
/** Back from Google within this window and still signed out — do not redirect again. */
export const REDIRECT_LOOP_WINDOW_MS = 60_000;

export type GateDecision = "app" | "redirect" | "sign-in" | "unreachable";

export function decideGate(input: {
  session: SessionCheck;
  /** location.search — carries ?error=<code> when the API refused the sign-in. */
  search: string;
  /** Timestamp from REDIRECT_MARK_KEY, if any. */
  lastRedirectAt: number | null;
  now: number;
}): GateDecision {
  if (input.session.kind === "signed-in") return "app";
  if (input.session.kind === "unreachable") return "unreachable";
  if (new URLSearchParams(input.search).has("error")) return "sign-in";
  if (input.lastRedirectAt !== null && input.now - input.lastRedirectAt >= 0 && input.now - input.lastRedirectAt < REDIRECT_LOOP_WINDOW_MS) {
    return "sign-in";
  }
  return "redirect";
}

/** Where to send the browser to sign in; Google returns to `returnTo` (the current page). */
export function googleSignInUrl(returnTo: string, base = apiUrl()): string {
  return `${base}/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
}
