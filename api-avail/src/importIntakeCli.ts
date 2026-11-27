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
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatIntakeReport, importIntake, mergeKits, type IntakeIndexEntry, type KitsFile } from "../../src/avail/intake";
import { catalogDir, readCatalog, writeCatalogFile } from "./catalogFiles";
import { readXlsx } from "./xlsx";

const here = path.dirname(fileURLToPath(import.meta.url));
/** docs/avail/kits.json: the kits of every intake form (src/avail/intake.ts kitsOfIntake). */
const kitsFile = process.env.AVAIL_KITS_FILE ?? path.join(here, "../../docs/avail/kits.json");
const KITS_ABOUT =
  "Kits: a part number sold as a set of blocks that each have their own catalog card (a matrix and its receivers, an extender's TX and RX). Written by import:intake from the Kits sheet and the TX/RX pair rule (src/avail/intake.ts). BoQ: the schematic blocks that make up a kit become one kit line; components beyond the kit are separate lines (.claude/skills/avail-documents).";

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
  const result = importIntake(products, catalog, indexDoc.templates, path.basename(input), sheets.get("Kits"));

  if (!dryRun && !result.fatal.length) {
    for (const f of result.write) {
      mkdirSync(path.dirname(path.join(dir, f.file)), { recursive: true });
      writeCatalogFile(dir, f, texts.get(f.file) ?? "");
    }
    for (const f of result.remove) rmSync(path.join(dir, f));
    if (result.kits.length) {
      const prev: KitsFile = existsSync(kitsFile) ? (JSON.parse(readFileSync(kitsFile, "utf8")) as KitsFile) : { about: KITS_ABOUT, kits: [] };
      writeFileSync(kitsFile, JSON.stringify(mergeKits({ about: prev.about ?? KITS_ABOUT, kits: prev.kits }, result.kits), null, 2) + "\n");
    }
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
