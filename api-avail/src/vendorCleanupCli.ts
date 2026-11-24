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
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { libraryIds } from "./libraryDir";
import { applyAllMigrations, configFromEnv } from "./server";
import { syncLintLevels } from "./templateMeta";
import { applyVendorDecisions, formatVendorCleanupReport } from "./vendorCleanup";

const USAGE = "usage: npm run apply:vendor-decisions [-- --dry-run]";

let dryRun = false;
try {
  dryRun = !!parseArgs({ options: { "dry-run": { type: "boolean", default: false } } }).values["dry-run"];
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  const ids = libraryIds();
  const report = applyVendorDecisions(db.sqlite, { dryRun, libraryIds: ids });
  if (!dryRun) syncLintLevels(db.sqlite);
  process.stdout.write(formatVendorCleanupReport(report));
} catch (err) {
  console.error(`apply:vendor-decisions failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
