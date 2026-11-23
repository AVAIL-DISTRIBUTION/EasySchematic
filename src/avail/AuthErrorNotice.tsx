import { useEffect, useState } from "react";
import { readAuthError, withoutAuthError, type AuthError } from "./auth";

/**
 * AVAIL: shows why a Google sign-in was refused (e.g. an account outside our
 * Workspace domain). The API redirects back to the app with ?error=<code>; this reads
 * it once, strips it from the address bar and shows a dismissible banner.
 */
export default function AuthErrorNotice() {
  const [error, setError] = useState<AuthError | null>(() => readAuthError(window.location.search));

  useEffect(() => {
    if (error) window.history.replaceState(window.history.state, "", withoutAuthError(window.location.href));
  }, [error]);

  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="auth-error-notice"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[10000] max-w-[90vw] w-[480px] rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-3"
      style={{ backgroundColor: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}
    >
      <span className="flex-1">{error.message}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        className="text-xs underline cursor-pointer shrink-0"
        aria-label="Закрыть"
      >
        Закрыть
      </button>
    </div>
  );
}
