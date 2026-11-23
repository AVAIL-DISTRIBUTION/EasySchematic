// Bundles api-avail + the upstream app (api/src) + the bundled device library into
// single ESM files (server and import CLI). Only better-sqlite3 stays external: it ships a native addon.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["better-sqlite3"],
  // CJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

// The API server, and the raw-template import CLI (npm run import:upstream in the image).
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/server.mjs" });
await build({ ...common, entryPoints: ["src/importCli.ts"], outfile: "dist/import-upstream.mjs" });
