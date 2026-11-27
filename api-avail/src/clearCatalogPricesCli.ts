/**
 * CLI: empty the prices (unitCost) of the catalog templates in the database; see
 * clearCatalogPrices.ts. One summary entry goes to the audit log (action run).
 *
 * On the server, after a backup:
 *   ./backup.sh
 *   docker compose exec api npm run clear:catalog-prices -- --dry-run
 *   docker compose exec api npm run clear:catalog-prices
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cliArgs, writeRunAudit } from "./audit";
import { clearCatalogPrices, clearPricesRunCounts, formatClearCatalogPricesReport } from "./clearCatalogPrices";
import { D1DatabaseShim } from "./d1";
import { applyAllMigrations, configFromEnv } from "./server";
import { syncLintLevels } from "./templateMeta";

const USAGE = "usage: npm run clear:catalog-prices [-- --dry-run] [-- --verbose]";

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
  const report = clearCatalogPrices(db.sqlite, { dryRun: values["dry-run"] });
  process.stdout.write(formatClearCatalogPricesReport(report, values.verbose));
  if (!report.dryRun) {
    writeRunAudit(db.sqlite, { command: "clear:catalog-prices", args: cliArgs(), counts: clearPricesRunCounts(report) });
    syncLintLevels(db.sqlite);
  }
} catch (err) {
  console.error(`clear:catalog-prices failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
