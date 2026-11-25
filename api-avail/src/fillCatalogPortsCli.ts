/**
 * CLI: fill ports of the product catalog (library/catalog) from the curated library
 * (library/avail), a database snapshot and described variants; see src/avail/catalogPorts.ts.
 * Writes the catalog files only — never the database.
 *
 *   npm run fill:catalog-ports -- --dry-run
 *   npm run fill:catalog-ports [-- --db <snapshot.sqlite>] [-- --dir <library/catalog>]
 *
 * The snapshot is the server's SQLite from a backup (tools/avail/incoming/db/easyschematic.sqlite
 * by default, not in git); it is opened read-only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { fillCatalogPorts, formatFillReport, formatStencilReport, type PortDonor, type TemplateStatusName } from "../../src/avail/catalogPorts";
import type { StencilFile } from "../../src/avail/extronStencil";
import { catalogDir, readCatalog, writeCatalogFile } from "./catalogFiles";
import { libraryDir } from "./libraryDir";
import { deletedTemplateIds } from "./vendorResponses";

const USAGE =
  "usage: npm run fill:catalog-ports [-- --dry-run] [-- --db <snapshot.sqlite>] [-- --dir <library/catalog>] [-- --stencils <blocks.json>] [-- --stencil-report <report.md>]";
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.join(here, "../../tools/avail/incoming/db/easyschematic.sqlite");
const defaultStencils = path.join(here, "../../tools/avail/extron-visio/extron-visio-blocks.json");
const defaultStencilReport = path.join(here, "../../tools/avail/extron-visio/report.md");

let values: { db?: string; dir?: string; library?: string; stencils?: string; "stencil-report"?: string; "dry-run"?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      db: { type: "string", default: defaultDb },
      dir: { type: "string", default: catalogDir() },
      library: { type: "string", default: libraryDir() },
      stencils: { type: "string", default: defaultStencils },
      "stencil-report": { type: "string", default: defaultStencilReport },
      "dry-run": { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const dir = path.resolve(cwd, values.dir!);
const dbFile = path.resolve(cwd, values.db!);
const libDir = path.resolve(cwd, values.library!);
const stencilFile = path.resolve(cwd, values.stencils!);
const stencilReport = path.resolve(cwd, values["stencil-report"]!);

try {
  if (!existsSync(dbFile)) throw new Error(`${dbFile}: database snapshot not found (--db)`);
  const files = readCatalog(dir);

  const library: PortDonor[] = readdirSync(libDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const t = JSON.parse(readFileSync(path.join(libDir, file), "utf8")) as PortDonor & Record<string, unknown>;
      return { ...t, file, status: "verified" as const, level: lintBlock(t).level };
    });

  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  const deleted = deletedTemplateIds();
  const rows = sqlite
    .prepare("SELECT t.*, m.status AS avail_status FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id")
    .all() as (TemplateRow & { avail_status: TemplateStatusName | null })[];
  sqlite.close();
  const db: PortDonor[] = rows
    .filter((r) => !deleted.has(r.id))
    .map((r) => {
      const t = rowToTemplate(r);
      return {
        id: t.id,
        label: t.label,
        manufacturer: t.manufacturer,
        modelNumber: t.modelNumber,
        ports: t.ports,
        slots: t.slots,
        status: r.avail_status ?? "raw",
        level: lintBlock(t).level as BlockLevel,
      };
    });

  // Extron Visio stencils (npm run parse:extron-visio); without the file, no stencil step.
  const stencils = existsSync(stencilFile) ? (JSON.parse(readFileSync(stencilFile, "utf8")) as StencilFile).blocks : [];
  const report = fillCatalogPorts(files, { library, db, stencils });
  if (!values["dry-run"]) {
    const texts = new Map(files.map((f) => [f.file, f.text]));
    for (const f of report.changed) writeCatalogFile(dir, f, texts.get(f.file));
  }
  process.stdout.write(formatFillReport(report, files, !!values["dry-run"]));
  if (stencils.length) {
    writeFileSync(stencilReport, formatStencilReport(report, !!values["dry-run"]));
    const n = (a: string) => report.stencil.filter((x) => x.action === a).length;
    process.stdout.write(
      `\nExtron stencils: filled ${n("filled")}, replaced ${n("replaced")}, compared ${n("compared")}, kept ${n("kept")}, skipped ${n("skipped")}, ` +
        `not found ${report.stencilMissing.length}; report: ${path.relative(cwd, stencilReport)}\n`,
    );
  }
} catch (err) {
  console.error(`fill:catalog-ports failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
