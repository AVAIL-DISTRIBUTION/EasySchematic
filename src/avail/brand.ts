/**
 * AVAIL build flag and branding.
 *
 * VITE_AVAIL=1 at build time turns on the AVAIL interface: sign-in gate instead of the
 * landing page, AVAIL Schematic branding, no upstream cloud features (Owned Gear,
 * community submissions, easyschematic.live links), AVAIL defaults for new schematics,
 * category-group header colors and a resizable library panel. Without the flag every
 * one of those places behaves exactly as upstream.
 */

type Env = Record<string, string | boolean | undefined>;

function viteEnv(): Env {
  return (import.meta.env ?? {}) as Env;
}

export function isAvailBuild(env: Env = viteEnv()): boolean {
  const v = env.VITE_AVAIL;
  return v === true || v === "1" || v === "true";
}

export const AVAIL_APP_NAME = "AVAIL Schematic";
export const AVAIL_COMPANY = "AVAIL DISTRIBUTION, FZCO";

/** Upstream project: credited in About, as AGPL-3.0 asks. */
export const UPSTREAM_NAME = "EasySchematic";
export const UPSTREAM_AUTHOR = "duremovich";
export const UPSTREAM_URL = "https://github.com/duremovich/EasySchematic";
export const LICENSE_NAME = "AGPL-3.0";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** Source of this fork (AGPL-3.0 §13: network users are offered the source). */
export const FORK_SOURCE_URL = "https://github.com/AVAIL-DISTRIBUTION/EasySchematic";

/** Logos copied from the AVAIL brand kit (public/avail/). */
export const AVAIL_LOGO = "/avail/avail-logo.png";
export const AVAIL_LOGO_WHITE = "/avail/avail-logo-white.png";
export const AVAIL_MARK = "/avail/avail-mark.png";

/**
 * Link to the exact source of the running build: the commit when the build knows it,
 * otherwise the repository.
 */
export function sourceUrlFor(buildHash: string | undefined): string {
  const hash = (buildHash ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(hash) ? `${FORK_SOURCE_URL}/tree/${hash}` : FORK_SOURCE_URL;
}

/** Our documentation site, if the build was given one (VITE_DOCS_URL); null hides the link. */
export function docsUrl(env: Env = viteEnv()): string | null {
  const v = env.VITE_DOCS_URL;
  return typeof v === "string" && /^https?:\/\//.test(v.trim()) ? v.trim() : null;
}

/** Browser tab title for the open schematic. */
export function appDocumentTitle(schematicName: string, avail: boolean = isAvailBuild()): string {
  if (avail) return schematicName ? `${schematicName} — ${AVAIL_APP_NAME}` : AVAIL_APP_NAME;
  return schematicName ? `${schematicName} — EasySchematic` : "EasySchematic — AV Signal Flow Diagram Tool";
}
