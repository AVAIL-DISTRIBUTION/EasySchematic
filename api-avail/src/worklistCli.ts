/**
 * CLI: the engineers' worklist (worklist.ts) as CSV on stdout.
 *
 *   npm run -s export:worklist > worklist.csv
 *
 * On the server:
 *   docker compose exec -T api npm run -s export:worklist > worklist.csv
 *
 * Migration messages go to stderr, so stdout is only the CSV.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { D1DatabaseShim } from "./d1";
import { applyAllMigrations, configFromEnv } from "./server";
import { buildWorklist, worklistCsv } from "./worklist";

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.error(m));
  const rows = buildWorklist(db.sqlite);
  process.stdout.write(worklistCsv(rows));
  console.error(`worklist: ${rows.length} templates (B and FIX of our vendors)`);
} catch (err) {
  console.error(`export:worklist failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
