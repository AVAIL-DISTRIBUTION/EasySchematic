/**
 * CLI: load the curated AVAIL library (library/avail/*.json + library/hidden.json) into
 * the database; see importAvail.ts for the rules.
 *
 *   npm run import:avail [-- --dry-run] [-- --dir <library/avail>]
 *
 * On the server (the image carries the library at /app/library):
 *   docker compose exec api npm run import:avail -- --dry-run
 *   docker compose exec api npm run import:avail
 *
 * Uses DATA_DIR / MIGRATIONS_DIR / AVAIL_MIGRATIONS_DIR like the server and applies
 * pending migrations first. AVAIL_LIBRARY_DIR overrides the default directory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseHiddenList } from "../../src/avail/libraryFiles";
import { D1DatabaseShim } from "./d1";
import { formatImportAvailReport, importAvailLibrary, type AvailLibraryFile } from "./importAvail";
import { applyAllMigrations, configFromEnv } from "./server";
import { parseSeedMode, seedLibrary } from "./seed";
import { relintAll, syncLintLevels } from "./templateMeta";

const USAGE = "usage: npm run import:avail [-- --dry-run] [-- --dir <library/avail>]";
const here = path.dirname(fileURLToPath(import.meta.url));
// Source (api-avail/src) and bundle (api-avail/dist) both sit two levels below the repo root.
const defaultDir = process.env.AVAIL_LIBRARY_DIR ?? path.join(here, "../../library/avail");

let values: { dir?: string; "dry-run"?: boolean };
try {
  ({ values } = parseArgs({
    options: { dir: { type: "string", default: defaultDir }, "dry-run": { type: "boolean", default: false } },
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
  if (!existsSync(dir)) throw new Error(`${dir}: no such directory`);
  const files: AvailLibraryFile[] = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      return { file, text, template: JSON.parse(text) as unknown };
    });
  const hiddenFile = path.join(dir, "../hidden.json");
  const hidden = existsSync(hiddenFile) ? parseHiddenList(JSON.parse(readFileSync(hiddenFile, "utf8"))) : [];

  applyAllMigrations(db.sqlite, config, (m) => console.log(m));
  // Same start-up as the server: on a fresh data directory the built-in library is seeded
  // first, otherwise SEED_LIBRARY=if-empty would skip it once our templates are in.
  const seeded = seedLibrary(db.sqlite, parseSeedMode(config.seedMode));
  if (seeded.seeded > 0) console.log(`library seeded: ${seeded.seeded} templates (mode ${seeded.mode})`);
  syncLintLevels(db.sqlite);
  const report = importAvailLibrary(db.sqlite, files, { dryRun: values["dry-run"], hidden });
  process.stdout.write(formatImportAvailReport(report, dir));
  if (!report.dryRun) {
    syncLintLevels(db.sqlite);
    relintAll(db.sqlite);
  }
  if (report.invalid > 0) process.exitCode = 1;
} catch (err) {
  console.error(`import:avail failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
