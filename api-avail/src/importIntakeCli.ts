/**
 * CLI: import a filled product intake form (tools/avail/intake/avail-intake-template.xlsx, rules in
 * docs/avail/intake.md) into the catalog files library/catalog/<vendor>/*.json and index.json;
 * see src/avail/intake.ts. Writes repository files only — never the database.
 *
 *   npm run import:intake -- <avail-intake-<vendor>-<yyyymmdd>.xlsx> --dry-run
 *   npm run import:intake -- <file.xlsx> [--dir <library/catalog>]
 *
 * Valid rows are written even when other rows have errors; the exit code is 1 when any row has
 * errors (or the sheet cannot be read), so the report is not missed. Then the usual path:
 * ports from the Datasheet URL, `npm run fill:catalog-ports`, `npm run avail:check-library`,
 * `import:catalog` on the server.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatIntakeReport, importIntake, type IntakeIndexEntry } from "../../src/avail/intake";
import { catalogDir, readCatalog, writeCatalogFile } from "./catalogFiles";
import { readXlsx } from "./xlsx";

const USAGE = "usage: npm run import:intake -- <file.xlsx> [--dry-run] [--dir <library/catalog>]";

let values: { dir?: string; "dry-run"?: boolean };
let positionals: string[];
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: { dir: { type: "string", default: catalogDir() }, "dry-run": { type: "boolean", default: false } },
  }));
  if (positionals.length !== 1) throw new Error("one intake file expected");
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const dir = path.resolve(cwd, values.dir!);
const input = path.resolve(cwd, positionals[0]);
const dryRun = !!values["dry-run"];

try {
  if (!existsSync(input)) throw new Error(`${input}: no such file`);
  const sheets = readXlsx(readFileSync(input));
  const products = sheets.get("Products");
  if (!products) throw new Error(`no "Products" sheet (use the template avail-intake-template.xlsx); sheets: ${[...sheets.keys()].join(", ")}`);

  const indexFile = path.join(dir, "index.json");
  const indexDoc = JSON.parse(readFileSync(indexFile, "utf8")) as { version: number; count: number; templates: IntakeIndexEntry[] };
  const catalog = readCatalog(dir);
  const texts = new Map(catalog.map((f) => [f.file, f.text]));
  const result = importIntake(products, catalog, indexDoc.templates, path.basename(input));

  if (!dryRun && !result.fatal.length) {
    for (const f of result.write) {
      mkdirSync(path.dirname(path.join(dir, f.file)), { recursive: true });
      writeCatalogFile(dir, f, texts.get(f.file) ?? "");
    }
    for (const f of result.remove) rmSync(path.join(dir, f));
    if (result.write.length || result.remove.length) {
      const doc = { ...indexDoc, count: result.index.length, templates: result.index };
      const old = readFileSync(indexFile, "utf8");
      // index.json keeps its 1-space indentation and trailing newline.
      writeFileSync(indexFile, JSON.stringify(doc, null, 1) + (old.endsWith("\n") ? "\n" : ""));
    }
  }
  process.stdout.write(formatIntakeReport(result, path.basename(input), dryRun));
  if (result.fatal.length || result.rows.some((r) => !r.example && r.errors.length)) process.exitCode = 1;
} catch (err) {
  console.error(`import:intake failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
