/**
 * CLI: the built AVAIL frontend (dist) has no links to upstream's public services, except the
 * upstream site on About (src/avail/distCheck.ts). Run after `vite build` with VITE_AVAIL=1;
 * Dockerfile.avail runs it, so an image with such a link does not build.
 *
 *   npm run avail:check-dist [-- <dist dir>]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { upstreamRefs, type UpstreamHit } from "./distCheck";

const dir = path.resolve(process.argv[2] ?? "dist");
const TEXT = /\.(js|mjs|css|html|json|webmanifest|txt|xml|svg|map)$|^_headers$|^_redirects$/;

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : TEXT.test(f) ? [p] : [];
  });
}

try {
  const files = walk(dir).filter((f) => !f.endsWith(".map"));
  const hits: UpstreamHit[] = files.flatMap((f) => upstreamRefs(path.relative(dir, f), readFileSync(f, "utf8")));
  if (hits.length) {
    console.error(`${dir}: ${hits.length} link(s) to upstream's services in the AVAIL build:`);
    for (const h of hits) console.error(`  ${h.file}: ${h.match}`);
    process.exitCode = 1;
  } else {
    console.log(`${dir}: ${files.length} files, no links to upstream's services (About's ${"upstream site"} only)`);
  }
} catch (err) {
  console.error(`avail:check-dist failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
