/**
 * AVAIL build (VITE_AVAIL=1): index.html and the PWA manifest carry AVAIL Schematic
 * branding instead of upstream's. Without the flag both stay exactly as upstream.
 *
 * index.html is upstream's file; rather than editing it, the AVAIL build rewrites it on
 * the way out: title, favicon, theme color, and the public-site SEO tags (Open Graph,
 * canonical easyschematic.live, search-console verification, structured data) that do
 * not belong on an internal tool.
 */
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

export function availBrandingPlugin(enabled: boolean): Plugin {
  return {
    name: "avail-branding",
    transformIndexHtml: enabled ? (html) => brandIndexHtml(html) : undefined,
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
