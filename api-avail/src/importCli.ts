/**
 * CLI: import raw templates from the public EasySchematic library (status raw).
 *
 *   npm run import:upstream [-- --dry-run] [-- --url <url>] [-- --file <templates.json>]
 *
 * On the server (inside the API container, same DATA_DIR as the running API):
 *   docker compose exec api npm run import:upstream
 *
 * Uses DATA_DIR / MIGRATIONS_DIR / AVAIL_MIGRATIONS_DIR like the server and applies
 * pending migrations first, so it also works on a fresh data directory.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { DEFAULT_UPSTREAM_URL, fetchUpstreamTemplates, formatImportReport, importTemplates } from "./importUpstream";
import { applyAllMigrations, configFromEnv } from "./server";

const USAGE = "usage: npm run import:upstream [-- --dry-run] [-- --url <url>] [-- --file <templates.json>]";

let values: { url?: string; file?: string; "dry-run"?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      url: { type: "string", default: DEFAULT_UPSTREAM_URL },
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  const origin = values.file ? path.resolve(values.file) : values.url!;
  const templates: unknown = values.file
    ? JSON.parse(readFileSync(origin, "utf8"))
    : await fetchUpstreamTemplates(values.url);
  if (!Array.isArray(templates)) throw new Error(`${origin}: expected a JSON array of templates`);
  const report = importTemplates(db.sqlite, templates, { dryRun: values["dry-run"] });
  process.stdout.write(formatImportReport(report, origin));
} catch (err) {
  console.error(`import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
