/**
 * CLI: approve draft catalog templates at level A whose ports come from the manufacturer's
 * documents (stencil, data sheet, curated library); see approveCatalog.ts.
 *
 *   npm run approve:catalog -- --dry-run [--verbose]
 *   npm run approve:catalog
 *
 * On the server, after a backup:
 *   ./backup.sh
 *   docker compose exec api npm run approve:catalog -- --dry-run
 *   docker compose exec api npm run approve:catalog
 *
 * Uses DATA_DIR / MIGRATIONS_DIR / AVAIL_MIGRATIONS_DIR like the server and applies pending
 * migrations first (9006 allows approved_via "bulk-source").
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { approveCatalog, formatApproveCatalogReport } from "./approveCatalog";
import { D1DatabaseShim } from "./d1";
import { applyAllMigrations, configFromEnv } from "./server";
import { syncLintLevels } from "./templateMeta";
import { cliArgs, writeRunAudit } from "./audit";
import { approveRunCounts } from "./runCounts";

const USAGE = "usage: npm run approve:catalog [-- --dry-run] [-- --verbose]";

let values: { "dry-run"?: boolean; verbose?: boolean };
try {
  ({ values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, verbose: { type: "boolean", default: false } } }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  syncLintLevels(db.sqlite);
  const report = approveCatalog(db.sqlite, { dryRun: values["dry-run"] });
  process.stdout.write(formatApproveCatalogReport(report, values.verbose));
  if (!report.dryRun) writeRunAudit(db.sqlite, { command: "approve:catalog", args: cliArgs(), counts: approveRunCounts(report) });
} catch (err) {
  console.error(`approve:catalog failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
