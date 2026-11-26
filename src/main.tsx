import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "./index.css";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { initServiceWorkerUpdates } from "./sw-register";
import AuthErrorNotice from "./avail/AuthErrorNotice.tsx";
import AuthGate from "./avail/AuthGate.tsx";
import { isAvailBuild } from "./avail/brand";
import { AVAIL_BUILD } from "./avail/upstream";

initServiceWorkerUpdates();

const App = lazy(() => import("./App.tsx"));
// AVAIL: the library workspace page (/library, librarians and admins).
const LibraryWorkspace = lazy(() => import("./avail/LibraryWorkspace.tsx"));
// Not in the AVAIL build at all (it links to upstream's sites).
const LandingPage = AVAIL_BUILD ? null : lazy(() => import("./components/LandingPage.tsx"));

/** Show landing page at "/" for first-time visitors (no skip pref and no special path). */
function shouldShowLanding(): boolean {
  const path = window.location.pathname;
  // Shared schematic links, or any non-root path — go straight to editor
  if (path !== "/") return false;
  // Seeding a fixture (#307 test scene, or the generated stress scene) means
  // going straight to the editor, or the landing page would swallow the request
  // for a first-time visitor. Literals rather than load.ts constants: importing
  // load.ts here would pull the store into the entry chunk.
  const fixture = new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "test" || fixture === "stress") return false;
  // Returning user who opted to skip the landing page
  if (localStorage.getItem("easyschematic-skip-landing")) return false;
  return true;
}

function Root() {
  // AVAIL build: no landing page — sign in with Google, then straight to the editor.
  if (AVAIL_BUILD || isAvailBuild()) {
    if (/^\/library\/?$/.test(window.location.pathname)) {
      return (
        <AuthGate>
          <Suspense fallback={null}>
            <LibraryWorkspace />
          </Suspense>
        </AuthGate>
      );
    }
    return (
      <AuthGate>
        <ReactFlowProvider>
          <Suspense fallback={null}>
            <App />
          </Suspense>
        </ReactFlowProvider>
      </AuthGate>
    );
  }
  if (LandingPage && shouldShowLanding()) {
    return (
      <Suspense fallback={null}>
        <LandingPage />
      </Suspense>
    );
  }
  return (
    <ReactFlowProvider>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
      <AuthErrorNotice />
    </ErrorBoundary>
  </StrictMode>,
);
