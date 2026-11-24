/**
 * CLI: apply the engineers' worklist solutions (applyWorklist.ts), then the follow-ups of
 * tools/avail/incoming/worklist-followups.json (built into the bundle).
 *
 *   npm run apply:worklist -- --dry-run [--file <worklist.xlsx>]
 *   npm run apply:worklist [-- --file <worklist.xlsx>]
 *
 * On the server, after a backup (the image carries the workbook in /app/incoming):
 *   ./backup.sh
 *   docker compose exec api npm run apply:worklist -- --dry-run
 *   docker compose exec api npm run apply:worklist
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { applyWorklist, formatApplyWorklistReport } from "./applyWorklist";
import { applyAllMigrations, configFromEnv } from "./server";
import { syncLintLevels } from "./templateMeta";
import { WORKLIST_FOLLOWUPS } from "./worklistFollowups";
import { readWorklist, worklistPath } from "./worklistInput";

let values: { "dry-run"?: boolean; file?: string };
try {
  ({ values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, file: { type: "string" } } }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\nusage: npm run apply:worklist [-- --dry-run] [-- --file <worklist.xlsx>]`);
  process.exit(2);
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.error(m));
  const file = worklistPath(values.file);
  const report = applyWorklist(db.sqlite, readWorklist(file), { dryRun: values["dry-run"], followups: WORKLIST_FOLLOWUPS });
  if (!values["dry-run"]) syncLintLevels(db.sqlite);
  process.stdout.write(formatApplyWorklistReport(report, file));
} catch (err) {
  console.error(`apply:worklist failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
