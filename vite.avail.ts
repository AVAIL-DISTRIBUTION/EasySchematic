/**
 * AVAIL build (VITE_AVAIL=1): index.html and the PWA manifest carry AVAIL Schematic
 * branding instead of upstream's. Without the flag both stay exactly as upstream.
 *
 * index.html is upstream's file; rather than editing it, the AVAIL build rewrites it on
 * the way out: title, favicon, theme color, and the public-site SEO tags (Open Graph,
 * canonical easyschematic.live, search-console verification, structured data) that do
 * not belong on an internal tool.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export const AVAIL_TITLE = "AVAIL Schematic";
const AVAIL_DESCRIPTION = "AV signal flow schematics for AVAIL DISTRIBUTION engineers.";
const AVAIL_THEME = "#0f172a";

export function isAvailEnv(env: Record<string, string | undefined>): boolean {
  const v = env.VITE_AVAIL;
  return v === "1" || v === "true";
}

/** The AVAIL version of index.html. Pure, for tests. */
export function brandIndexHtml(html: string): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${AVAIL_TITLE}</title>`)
    .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/png" href="/avail/favicon-64.png" />')
    .replace(/<link rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" href="/avail/apple-touch-icon-180x180.png">')
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${AVAIL_DESCRIPTION}">`)
    .replace(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="${AVAIL_THEME}">`)
    .replace(/\s*<!-- Open Graph[\s\S]*?<meta property="og:site_name"[^>]*>/, "")
    .replace(/\s*<!-- Twitter Card[\s\S]*?<meta name="twitter:image"[^>]*>/, "")
    .replace(/\s*<link rel="canonical"[^>]*>/, "")
    .replace(/\s*<meta name="google-site-verification"[^>]*>/, "")
    .replace(/\s*<!-- Structured Data -->\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")
    .replace(/<noscript>[\s\S]*?<\/noscript>/, `<noscript><p>${AVAIL_TITLE} needs JavaScript.</p></noscript>`)
    .replace("</head>", '  <meta name="robots" content="noindex, nofollow">\n  </head>');
}

/** The welcome note of the default schematic points at upstream's docs: not in the AVAIL build. */
const WELCOME_DOCS_RE = /<div><br><\/div><div>Full docs at <b>docs\.easyschematic\.live<\/b><\/div>/g;

/** defaultSchematic.json without upstream's docs line. Pure, for tests. */
export function stripUpstreamDocs(json: string): string {
  return json.replace(WELCOME_DOCS_RE, "");
}

const EMPTY_LANDING = "\0avail-empty-landing";

/** robots.txt of an internal tool: nothing to index (upstream's points at its public sitemap). */
export const AVAIL_ROBOTS = "User-agent: *\nDisallow: /\n";
/** Files of upstream's public site that the AVAIL build leaves out (Cloudflare headers, sitemap). */
export const AVAIL_DROPPED_PUBLIC = ["_headers", "sitemap.xml"];

export function availBrandingPlugin(enabled: boolean): Plugin {
  let outDir = "dist";
  return {
    name: "avail-branding",
    // Before Vite's own resolver, so the LandingPage stub wins.
    enforce: "pre",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: enabled ? (html) => brandIndexHtml(html) : undefined,
    // Upstream's landing page (links to its public sites) is never shown in the AVAIL build, but a
    // lazy import still emits its chunk: resolve it to an empty component instead.
    resolveId: enabled ? (source) => (/(^|\/)LandingPage(\.tsx)?$/.test(source) ? EMPTY_LANDING : null) : undefined,
    load: enabled ? (id) => (id === EMPTY_LANDING ? "export default function LandingPage() { return null; }" : null) : undefined,
    transform: enabled
      ? (code, id) => (/defaultSchematic\.json$/.test(id.split("?")[0]) ? { code: stripUpstreamDocs(code), map: null } : null)
      : undefined,
    // public/ is copied as is: drop or replace what belongs to upstream's public site.
    closeBundle: enabled
      ? () => {
          for (const f of AVAIL_DROPPED_PUBLIC) rmSync(path.join(outDir, f), { force: true });
          if (existsSync(outDir)) writeFileSync(path.join(outDir, "robots.txt"), AVAIL_ROBOTS);
        }
      : undefined,
  };
}

/** PWA manifest fields for the AVAIL build (merged over upstream's). */
export const AVAIL_MANIFEST = {
  name: AVAIL_TITLE,
  short_name: AVAIL_TITLE,
  description: AVAIL_DESCRIPTION,
  theme_color: AVAIL_THEME,
  background_color: AVAIL_THEME,
  icons: [
    { src: "avail/pwa-192x192.png", sizes: "192x192", type: "image/png" },
    { src: "avail/pwa-512x512.png", sizes: "512x512", type: "image/png" },
    { src: "avail/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
