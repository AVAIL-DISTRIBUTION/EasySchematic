/**
 * The AVAIL build must not lead to upstream's public services (step 2.5): no
 * devices.easyschematic.live, api.easyschematic.live, docs, support mail… in the built dist.
 * The one address allowed is the upstream project site on the About page.
 *
 * Pure: the CLI (distCheckCli.ts, `npm run avail:check-dist`) reads the files; tests feed text.
 */
/** Same as UPSTREAM_SITE_URL in upstream.ts (a test pins them equal); not imported: the CLI runs in Node, without import.meta.env. */
const UPSTREAM_SITE_URL = "https://easyschematic.live";

/** An address of easyschematic.live with whatever precedes and follows it in a URL or mail address. */
const UPSTREAM_RE = /[A-Za-z0-9._%+:/@-]*easyschematic\.live[A-Za-z0-9/#?=&._%~-]*/g;

/** Allowed in the AVAIL build: the upstream project site, linked from About (with or without a trailing slash). */
export const ALLOWED_UPSTREAM: readonly string[] = [UPSTREAM_SITE_URL, `${UPSTREAM_SITE_URL}/`];

export interface UpstreamHit {
  file: string;
  match: string;
}

/** Upstream addresses in a file's text that are not allowed. */
export function upstreamRefs(file: string, text: string): UpstreamHit[] {
  const out: UpstreamHit[] = [];
  for (const m of text.matchAll(UPSTREAM_RE)) {
    if (!ALLOWED_UPSTREAM.includes(m[0])) out.push({ file, match: m[0] });
  }
  return out;
}
