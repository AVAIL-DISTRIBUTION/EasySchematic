/**
 * CLI: load the level A files of the product catalog (library/catalog) into the database;
 * see importCatalog.ts for the rules.
 *
 *   npm run import:catalog -- --dry-run [--verbose] [--dir <library/catalog>]
 *   npm run import:catalog
 *
 * On the server, after a backup (the image carries the catalog at /app/library/catalog):
 *   ./backup.sh
 *   docker compose exec api npm run import:catalog -- --dry-run
 *   docker compose exec api npm run import:catalog
 *
 * Uses DATA_DIR / MIGRATIONS_DIR / AVAIL_MIGRATIONS_DIR like the server and applies pending
 * migrations first (9005 adds avail_template_meta.catalog). AVAIL_CATALOG_DIR overrides the
 * default directory.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { catalogDir, readCatalog } from "./catalogFiles";
import { D1DatabaseShim } from "./d1";
import { formatImportCatalogReport, importCatalog } from "./importCatalog";
import { libraryDir } from "./libraryDir";
import { applyAllMigrations, configFromEnv } from "./server";
import { relintAll, syncLintLevels } from "./templateMeta";

const USAGE = "usage: npm run import:catalog [-- --dry-run] [-- --verbose] [-- --dir <library/catalog>]";

let values: { dir?: string; "dry-run"?: boolean; verbose?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: "string", default: catalogDir() },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.dir!);
const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  const files = readCatalog(dir);
  const libDir = libraryDir();
  const curated = readdirSync(libDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(libDir, f), "utf8")) as { id: string; manufacturer?: string; modelNumber?: string });

  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  syncLintLevels(db.sqlite);
  const report = importCatalog(db.sqlite, files, { dryRun: values["dry-run"], curated });
  process.stdout.write(formatImportCatalogReport(report, dir, values.verbose));
  if (!report.dryRun) {
    syncLintLevels(db.sqlite);
    relintAll(db.sqlite);
  }
  if (report.counts.invalid > 0) process.exitCode = 1;
} catch (err) {
  console.error(`import:catalog failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
