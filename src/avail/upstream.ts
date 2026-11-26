/**
 * Upstream's public addresses (easyschematic.live) and the build-time AVAIL flag.
 *
 * AVAIL_BUILD reads import.meta.env.VITE_AVAIL directly: Vite inlines it at build time, so in the
 * AVAIL build (VITE_AVAIL=1) every `AVAIL_BUILD ? … : <upstream>` branch folds away and the
 * upstream addresses are not in the bundle at all (checked by `npm run avail:check-dist`).
 * isAvailBuild() (brand.ts) stays the runtime check used where tests switch the flag.
 *
 * The only upstream address the AVAIL build keeps is the project site on the About page.
 */
export const AVAIL_BUILD: boolean = import.meta.env.VITE_AVAIL === "1" || import.meta.env.VITE_AVAIL === "true";

/** Template API when VITE_TEMPLATE_API_URL is not set: ours lives under /api on the same host. */
export const DEFAULT_API_URL: string = AVAIL_BUILD ? "/api" : "https://api.easyschematic.live";

/** Community device database site (submissions, browsing): none in the AVAIL build. */
export const DEFAULT_DEVICES_URL: string = AVAIL_BUILD ? "" : "https://devices.easyschematic.live";

/** Upstream documentation: none in the AVAIL build (our docs: VITE_DOCS_URL, Help menu). */
export const UPSTREAM_DOCS_URL: string = AVAIL_BUILD ? "" : "https://docs.easyschematic.live";

/** The upstream project's site, linked from About in both builds. */
export const UPSTREAM_SITE_URL = "https://easyschematic.live";
