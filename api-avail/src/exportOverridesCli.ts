/**
 * CLI: the overrides in force (accepted proposals in the database, port decisions and other entries
 * of docs/avail/overrides.json the database does not know; overrides.ts) → docs/avail/overrides.json,
 * for the repository: fill:catalog-ports and the editor's normalizer read that file. An override
 * removed in the library workspace leaves the file. Read-only on the database.
 *
 *   npm run export:overrides [-- --db <sqlite>] [-- --out <file.json>]
 *
 * Without --db it reads the server's database (DATA_DIR). On the server:
 *   docker compose exec api npm run export:overrides -- --out /data/overrides.json
 * then copy the file to docs/avail/overrides.json in a PR.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import overridesJson from "../../docs/avail/overrides.json";
import type { OverridesFile } from "../../src/avail/overrides";
import { exportOverrides } from "./overrides";
import { configFromEnv } from "./server";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, "../../docs/avail");
const USAGE = "usage: npm run export:overrides [-- --db <sqlite>] [-- --out <file.json>]";

let values: { db?: string; out?: string };
try {
  ({ values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" } } }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const dbFile = values.db ? path.resolve(cwd, values.db) : path.join(configFromEnv().dataDir, "easyschematic.sqlite");
// In the repository the file goes to docs/avail; in the image (no docs) next to the database.
const out = values.out ? path.resolve(cwd, values.out) : existsSync(docs) ? path.join(docs, "overrides.json") : path.join(path.dirname(dbFile), "overrides.json");

try {
  if (!existsSync(dbFile)) throw new Error(`${dbFile}: database not found (--db)`);
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  const file = exportOverrides(sqlite, overridesJson as unknown as OverridesFile);
  sqlite.close();
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  const proposals = file.overrides.filter((o) => o.source.startsWith("proposal ")).length;
  process.stdout.write(`Overrides: ${file.overrides.length} (${proposals} from accepted proposals)\n  ${path.relative(cwd, out)}\n`);
} catch (err) {
  console.error(`export:overrides failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
