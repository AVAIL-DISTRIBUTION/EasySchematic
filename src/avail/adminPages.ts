/** Which AVAIL admin page (Users, Audit log) is open; the account menu opens, the page closes. */
import { useSyncExternalStore } from "react";

export type AdminPage = "users" | "audit" | null;
let page: AdminPage = null;
const listeners = new Set<() => void>();

export function openAdminPage(p: AdminPage): void {
  page = p;
  for (const l of listeners) l();
}

export function getAdminPage(): AdminPage {
  return page;
}

export function useAdminPage(): AdminPage {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => page,
    () => page,
  );
}
