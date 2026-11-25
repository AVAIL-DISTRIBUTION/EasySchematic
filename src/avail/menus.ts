/**
 * AVAIL build: menu entries that replace upstream's (the menu bar takes them as-is).
 * Help keeps our documentation (when the build has VITE_DOCS_URL) and About; upstream's
 * docs.easyschematic.live, device database and landing page links are gone.
 */
import { AVAIL_APP_NAME, docsUrl, isAvailBuild } from "./brand";

export type AvailMenuEntry =
  | { type: "item"; label: string; onClick: () => void }
  | { type: "separator" };

export function availHelpMenu(openAbout: () => void, docs: string | null = docsUrl()): AvailMenuEntry[] {
  const entries: AvailMenuEntry[] = [];
  if (docs) {
    entries.push(
      { type: "item", label: "Documentation ↗", onClick: () => window.open(docs, "_blank", "noopener,noreferrer") },
      { type: "separator" },
    );
  }
  entries.push({ type: "item", label: `About ${AVAIL_APP_NAME}`, onClick: openAbout });
  return entries;
}

/** View menu labels the AVAIL build leaves out (upstream cloud features). */
export const AVAIL_HIDDEN_VIEW_ITEMS: ReadonlySet<string> = new Set(["Show Owned Gear"]);

/** Device Editor save actions the AVAIL build leaves out: no community submissions. */
export function availSaveActions<T extends string>(actions: T[], avail: boolean = isAvailBuild()): T[] {
  return avail ? actions.filter((a) => a !== "submit-community") : actions;
}
