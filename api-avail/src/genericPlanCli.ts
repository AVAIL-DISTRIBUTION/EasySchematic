/**
 * CLI: bring the Generic vendor to the reviewed set of docs/avail/generic-plan.json
 * (see genericPlan.ts).
 *
 *   npm run apply:generic-plan -- --dry-run    report only, nothing written
 *   npm run apply:generic-plan                 write (one transaction)
 *
 * On the server, after a backup and import:avail (the rebuilt Generic templates live in
 * library/avail):
 *   ./backup.sh
 *   docker compose exec api npm run apply:generic-plan -- --dry-run
 *   docker compose exec api npm run apply:generic-plan
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { applyGenericPlan, formatGenericPlanReport } from "./genericPlan";
import { libraryIds } from "./libraryDir";
import { applyAllMigrations, configFromEnv } from "./server";
import { relintAll, syncLintLevels } from "./templateMeta";

const USAGE = "usage: npm run apply:generic-plan [-- --dry-run]";

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
  const report = applyGenericPlan(db.sqlite, { dryRun, libraryIds: libraryIds() });
  if (!dryRun) {
    syncLintLevels(db.sqlite);
    relintAll(db.sqlite);
  }
  process.stdout.write(formatGenericPlanReport(report));
} catch (err) {
  console.error(`apply:generic-plan failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
