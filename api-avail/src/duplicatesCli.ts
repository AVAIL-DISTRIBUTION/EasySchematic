/**
 * CLI: possible duplicates in the library (src/avail/duplicates.ts) → docs/avail/duplicates.md and
 * duplicates.xlsx next to it. Read-only.
 *
 *   npm run report:duplicates [-- --db <sqlite>] [-- --out <file.md>]
 *
 * Without --db it reads the server's database (DATA_DIR). On the server:
 *   docker compose exec api npm run report:duplicates -- --out /data/duplicates.md
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { duplicateGroups } from "../../src/avail/duplicates";
import { DUPLICATE_COLUMNS, duplicateRows, formatDuplicates } from "../../src/avail/duplicatesReport";
import { loadCandidates } from "./duplicates";
import { loadNotDuplicates } from "./notDuplicates";
import { configFromEnv } from "./server";
import { writeXlsx } from "./xlsxWrite";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, "../../docs/avail");
const USAGE = "usage: npm run report:duplicates [-- --db <sqlite>] [-- --out <file.md>]";

let values: { db?: string; out?: string };
try {
  ({ values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" } } }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const dbFile = values.db ? path.resolve(cwd, values.db) : path.join(configFromEnv().dataDir, "easyschematic.sqlite");
// In the repository the report goes to docs/avail; in the image (no docs) next to the database.
const out = values.out ? path.resolve(cwd, values.out) : existsSync(docs) ? path.join(docs, "duplicates.md") : path.join(path.dirname(dbFile), "duplicates.md");

try {
  if (!existsSync(dbFile)) throw new Error(`${dbFile}: database not found (--db)`);
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  const candidates = loadCandidates(sqlite);
  const notDuplicates = loadNotDuplicates(sqlite);
  sqlite.close();
  const groups = duplicateGroups(candidates, notDuplicates);
  const total = candidates.filter((c) => c.status !== "hidden").length;
  writeFileSync(out, formatDuplicates(groups, { source: path.basename(dbFile), date: new Date().toISOString().slice(0, 10), total, notDuplicates: notDuplicates.size }));
  const xlsx = out.replace(/\.md$/, "") + ".xlsx";
  writeFileSync(xlsx, writeXlsx("Duplicates", [...DUPLICATE_COLUMNS], duplicateRows(groups), [6, 10, 38, 44, 16, 22, 11, 16, 10, 6, 6, 26]));
  const dups = groups.reduce((n, g) => n + g.members.length - 1, 0);
  process.stdout.write(`Possible duplicates: ${groups.length} groups, ${dups} templates to merge (of ${total})\n  ${path.relative(cwd, out)}\n  ${path.relative(cwd, xlsx)}\n`);
} catch (err) {
  console.error(`report:duplicates failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
