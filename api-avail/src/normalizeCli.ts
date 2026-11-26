/**
 * CLI: normalize the library templates of our vendors (raw/draft) towards the standard.
 *
 *   npm run normalize:library [-- --dry-run]
 *
 * On the server: docker compose exec api npm run normalize:library -- --dry-run
 * Writes only templates whose level goes up; statuses are not changed.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { formatNormalizeReport, normalizeLibrary } from "./normalizeLibrary";
import { applyAllMigrations, configFromEnv } from "./server";
import { relintAll, syncLintLevels } from "./templateMeta";
import { cliArgs, writeRunAudit } from "./audit";
import { normalizeRunCounts } from "./runCounts";

let dryRun = false;
try {
  dryRun = !!parseArgs({ options: { "dry-run": { type: "boolean", default: false } } }).values["dry-run"];
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\nusage: npm run normalize:library [-- --dry-run]`);
  process.exit(2);
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  syncLintLevels(db.sqlite);
  const report = normalizeLibrary(db.sqlite, { dryRun });
  process.stdout.write(formatNormalizeReport(report));
  if (!dryRun) {
    writeRunAudit(db.sqlite, { command: "normalize:library", args: cliArgs(), counts: normalizeRunCounts(report) });
    relintAll(db.sqlite);
  }
} catch (err) {
  console.error(`normalize failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
