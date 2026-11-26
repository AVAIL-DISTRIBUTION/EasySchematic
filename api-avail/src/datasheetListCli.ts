/**
 * CLI: data sheets to download — catalog cards with community ports grouped by the document that
 * would cover them (src/avail/datasheetList.ts). Writes docs/avail/datasheets-to-download.md and
 * .xlsx next to it. Read-only for the catalog.
 *
 *   npm run report:datasheets [-- --dir <library/catalog>] [-- --out <file.md>]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DATASHEET_COLUMNS, datasheetGroups, datasheetRows, formatDatasheetList } from "../../src/avail/datasheetList";
import { catalogDir, readCatalog } from "./catalogFiles";
import { readXlsx } from "./xlsx";
import { writeXlsx } from "./xlsxWrite";

const here = path.dirname(fileURLToPath(import.meta.url));
let values: { dir?: string; out?: string };
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: "string", default: catalogDir() },
      out: { type: "string", default: path.join(here, "../../docs/avail/datasheets-to-download.md") },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\nusage: npm run report:datasheets [-- --dir <library/catalog>] [-- --out <file.md>]`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
try {
  const groups = datasheetGroups(readCatalog(path.resolve(cwd, values.dir!)));
  const md = path.resolve(cwd, values.out!);
  const xlsx = md.replace(/\.md$/, "") + ".xlsx";
  writeFileSync(md, formatDatasheetList(groups, new Date().toISOString().slice(0, 10)));
  const buf = writeXlsx("Data sheets", DATASHEET_COLUMNS, datasheetRows(groups), [10, 16, 60, 40, 45, 10]);
  writeFileSync(xlsx, buf);
  // Read it back: a broken file fails here, not in Excel.
  const rows = readXlsx(buf).values().next().value ?? [];
  if (rows.length !== groups.length + 1) throw new Error(`${xlsx}: read back ${rows.length} rows, expected ${groups.length + 1}`);
  const cards = groups.reduce((n, g) => n + g.cards, 0);
  process.stdout.write(`Data sheets to download: ${groups.length} documents for ${cards} cards\n  ${path.relative(cwd, md)}\n  ${path.relative(cwd, xlsx)}\n`);
} catch (err) {
  console.error(`report:datasheets failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
