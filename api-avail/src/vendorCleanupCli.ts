/**
 * CLI: clean the library by docs/avail/vendor-decisions.json (see vendorCleanup.ts).
 *
 *   npm run apply:vendor-decisions -- --dry-run    report only, nothing written
 *   npm run apply:vendor-decisions                 write (one transaction)
 *
 * On the server, after a backup:
 *   ./backup.sh
 *   docker compose exec api npm run apply:vendor-decisions -- --dry-run
 *   docker compose exec api npm run apply:vendor-decisions
 *
 * Templates of library/avail/ (AVAIL_LIBRARY_DIR, in the image /app/library/avail) are
 * never touched.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { applyAllMigrations, configFromEnv } from "./server";
import { syncLintLevels } from "./templateMeta";
import { applyVendorDecisions, formatVendorCleanupReport } from "./vendorCleanup";

const USAGE = "usage: npm run apply:vendor-decisions [-- --dry-run]";
const here = path.dirname(fileURLToPath(import.meta.url));
const libraryDir = process.env.AVAIL_LIBRARY_DIR ?? path.join(here, "../../library/avail");

let dryRun = false;
try {
  dryRun = !!parseArgs({ options: { "dry-run": { type: "boolean", default: false } } }).values["dry-run"];
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

/** Ids of the curated library: never touched, even before import:avail has run. */
function libraryIds(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`${dir}: curated library not found (set AVAIL_LIBRARY_DIR)`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  const ids = libraryIds(libraryDir);
  const report = applyVendorDecisions(db.sqlite, { dryRun, libraryIds: ids });
  if (!dryRun) syncLintLevels(db.sqlite);
  process.stdout.write(formatVendorCleanupReport(report));
} catch (err) {
  console.error(`apply:vendor-decisions failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
