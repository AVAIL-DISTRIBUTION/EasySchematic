import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AVAIL_APP_NAME } from "./brand";
import { AvailLogo } from "./BrandUi";
import {
  REDIRECT_MARK_KEY,
  decideGate,
  fetchSession,
  googleSignInUrl,
  setSignedInUser,
  type GateDecision,
} from "./session";

/**
 * AVAIL build: the editor opens only for a signed-in user. A signed-out visitor goes
 * straight to Google sign-in (no landing page) and comes back to the page they asked
 * for. See session.ts for when the gate shows its own screen instead.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  // Read before AuthErrorNotice strips ?error= from the address bar.
  const [search] = useState(() => window.location.search);
  const [state, setState] = useState<GateDecision | "checking">("checking");

  const signIn = useCallback(() => {
    try {
      sessionStorage.setItem(REDIRECT_MARK_KEY, String(Date.now()));
    } catch {
      /* storage blocked: the loop guard is off, the redirect still works */
    }
    const back = new URL(window.location.href);
    back.searchParams.delete("error");
    window.location.assign(googleSignInUrl(back.toString()));
  }, []);

  const check = useCallback(async () => {
    setState("checking");
    const session = await fetchSession();
    let lastRedirectAt: number | null = null;
    try {
      const raw = sessionStorage.getItem(REDIRECT_MARK_KEY);
      lastRedirectAt = raw ? Number(raw) : null;
    } catch {
      /* ignore */
    }
    const decision = decideGate({ session, search, lastRedirectAt, now: Date.now() });
    if (session.kind === "signed-in") {
      setSignedInUser(session.user);
      try {
        sessionStorage.removeItem(REDIRECT_MARK_KEY);
      } catch {
        /* ignore */
      }
    }
    if (decision === "redirect") signIn();
    else setState(decision);
  }, [search, signIn]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one session check on mount
    void check();
  }, [check]);

  if (state === "app") return <>{children}</>;
  return <GateScreen state={state} onSignIn={signIn} onRetry={() => void check()} />;
}

function GateScreen({
  state,
  onSignIn,
  onRetry,
}: {
  state: GateDecision | "checking";
  onSignIn: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="avail-auth-gate"
      className="fixed inset-0 flex items-center justify-center"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <div
        className="w-[360px] max-w-[calc(100vw-32px)] rounded-lg shadow-lg px-6 py-8 flex flex-col items-center gap-5 text-center"
        style={{ backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <AvailLogo className="h-12 w-auto" />
        <div className="text-base font-semibold" style={{ color: "var(--color-text-heading)" }}>
          {AVAIL_APP_NAME}
        </div>
        {state === "checking" || state === "redirect" ? (
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            Checking your sign-in…
          </p>
        ) : state === "unreachable" ? (
          <>
            <p className="text-xs" style={{ color: "var(--color-text)" }}>
              Cannot reach the {AVAIL_APP_NAME} server. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <p className="text-xs" style={{ color: "var(--color-text)" }}>
              Sign in with your AVAIL Google Workspace account.
            </p>
            <button
              type="button"
              data-testid="avail-sign-in"
              onClick={onSignIn}
              className="px-4 py-2 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
            >
              Sign in with Google
            </button>
          </>
        )}
      </div>
    </div>
  );
}
