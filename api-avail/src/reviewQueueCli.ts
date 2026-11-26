/**
 * CLI: the review queue — draft catalog templates approve:catalog leaves for an engineer, grouped
 * by reason and model family with a proposal each (src/avail/reviewQueue.ts). Writes
 * docs/avail/review-queue.md.
 *
 *   npm run report:review-queue                       # from library/catalog (what import:catalog
 *                                                     # loads, minus what approve:catalog approves)
 *   npm run report:review-queue -- --db <snapshot>    # from a database: draft rows of the catalog
 *   [-- --out <file.md>] [-- --dir <library/catalog>]
 *
 * Read-only. In files mode a catalog file counts as the database would hold it: level B or A
 * (import:catalog's minimum B), not curated (library/avail), not deleted for good.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import type { TemplateRow } from "../../api/src/db";
import { isRoomMounted, lintBlock, mountedByName, type BlockLevel } from "../../src/avail/blockLint";
import { catalogIndex, parseCatalogMeta, portsOrigin, type CatalogMeta } from "../../src/avail/portsOrigin";
import { formatReviewQueue, reviewQueue, type QueueItem } from "../../src/avail/reviewQueue";
import { catalogDir, readCatalog, type CatalogFileText } from "./catalogFiles";
import { AVAIL_CATALOG_SOURCE, partKey } from "./importCatalog";
import { libraryDir } from "./libraryDir";
import { blockOfRow, slotContext } from "./templateMeta";
import { DELETED_TEMPLATES } from "./vendorResponses";
import { proposedRules } from "./reviewRules";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: npm run report:review-queue [-- --db <snapshot.sqlite>] [-- --dir <library/catalog>] [-- --out <file.md>]";

let values: { db?: string; dir?: string; out?: string };
try {
  ({ values } = parseArgs({
    options: {
      db: { type: "string" },
      dir: { type: "string", default: catalogDir() },
      out: { type: "string", default: path.join(here, "../../docs/avail/review-queue.md") },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Catalog files as import:catalog would load them (level B and above, not curated, not deleted). */
function fromFiles(files: CatalogFileText[]): { items: QueueItem[]; source: string } {
  const libDir = libraryDir();
  const curated = readdirSync(libDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(libDir, f), "utf8")) as { id: string; manufacturer?: string; modelNumber?: string });
  const curatedKeys = new Set(curated.map((c) => partKey(c.manufacturer, c.modelNumber)).filter(Boolean));
  const curatedIds = new Set(curated.map((c) => c.id));
  const deletedIds = new Set(DELETED_TEMPLATES.templates.map((d) => d.id));
  const byFile = catalogIndex(files.map((f) => ({ file: f.file, ...(f.template._avail ?? {}) }) as CatalogMeta));
  const items: QueueItem[] = [];
  for (const { file, template: t } of files) {
    if (curatedIds.has(t.id) || deletedIds.has(t.id) || curatedKeys.has(partKey(t.manufacturer, t.modelNumber))) continue;
    const lint = lintBlock(t);
    if (lint.level === "FIX") continue; // stays in the catalog, not in the database
    const origin = portsOrigin({ source: AVAIL_CATALOG_SOURCE, catalog: { file, ...(t._avail ?? {}) } as CatalogMeta }, byFile);
    if (lint.level === "A" && origin.origin === "manufacturer") continue; // approve:catalog approves it
    items.push({
      id: t.id, label: t.label, manufacturer: t.manufacturer, deviceType: t.deviceType, category: str(t.category),
      level: lint.level, warnings: lint.warnings, origin, where: file,
    });
  }
  return { items, source: `library/catalog (${files.length} files)` };
}

/** Draft catalog rows of a database. */
function fromDb(file: string): { items: QueueItem[]; source: string } {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const cols = (sqlite.prepare("PRAGMA table_info(avail_template_meta)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("catalog")) throw new Error(`${file}: no catalog in this database yet (run import:catalog, or use the catalog files)`);
    const ctx = slotContext(sqlite);
    const metas = sqlite.prepare("SELECT catalog FROM avail_template_meta WHERE catalog IS NOT NULL").all() as { catalog: string }[];
    const byFile = catalogIndex(metas.map((m) => parseCatalogMeta(m.catalog)));
    const rows = sqlite
      .prepare(
        `SELECT t.*, m.catalog AS avail_catalog FROM templates t JOIN avail_template_meta m ON m.template_id = t.id
          WHERE m.status = 'draft' AND m.source = ? AND t.flagged_for_deletion = 0`,
      )
      .all(AVAIL_CATALOG_SOURCE) as (TemplateRow & { avail_catalog: string | null })[];
    if (!rows.length) throw new Error(`${file}: no draft catalog templates (run import:catalog, or use the catalog files)`);
    const items: QueueItem[] = [];
    for (const r of rows) {
      const lint = lintBlock(blockOfRow(r, r.avail_catalog), ctx);
      const catalog = parseCatalogMeta(r.avail_catalog);
      const origin = portsOrigin({ source: AVAIL_CATALOG_SOURCE, catalog }, byFile);
      if (lint.level === "A" && origin.origin === "manufacturer") continue;
      items.push({
        id: r.id, label: r.label, manufacturer: str(r.manufacturer), deviceType: r.device_type, category: str(r.category),
        level: lint.level as BlockLevel, warnings: lint.warnings, origin, where: r.id,
      });
    }
    return { items, source: `database ${path.basename(file)} (${rows.length} draft catalog templates)` };
  } finally {
    sqlite.close();
  }
}

/** Effect of the v0.9 rule (room-mounted by name / description) on the whole catalog. */
function roomRuleEffect(files: CatalogFileText[]): string[] {
  const moves = new Map<string, string[]>();
  for (const { template: t } of files) {
    if (!mountedByName(t as never) || typeof t.rackForm === "string") continue;
    const byCategory = isRoomMounted({ category: t.category, deviceType: t.deviceType });
    if (byCategory) continue;
    // Before: the same card as a rack device (rackForm is read only by the room-mounted rule).
    const before = lintBlock({ ...t, rackForm: "full" }).level;
    const key = `${before}→${lintBlock(t).level}`;
    moves.set(key, [...(moves.get(key) ?? []), t.label]);
  }
  const lines = ["## Rule v0.9: room-mounted by name and description", ""];
  const total = [...moves.values()].reduce((n, l) => n + l.length, 0);
  lines.push(
    `Catalog cards that only the new rule makes room-mounted (category and device type do not): **${total}**. ` +
      "Dimensions and weight are no longer required for them. Level before → after:",
    "",
  );
  for (const [k, list] of [...moves.entries()].sort()) {
    lines.push(`- ${k}: ${list.length}${k.startsWith("B→A") ? ` — ${list.slice(0, 15).join("; ")}${list.length > 15 ? "; …" : ""}` : ""}`);
  }
  return lines;
}

try {
  const dir = path.resolve(cwd, values.dir!);
  const files = readCatalog(dir);
  const { items, source } = values.db ? fromDb(path.resolve(cwd, values.db)) : fromFiles(files);
  const report = reviewQueue(items);
  // Templates by "where" (catalog file, or id in database mode) for the rule simulations.
  const templates = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    templates.set(f.file, f.template as unknown as Record<string, unknown>);
    templates.set(f.template.id, f.template as unknown as Record<string, unknown>);
  }
  const extra = [...roomRuleEffect(files), "", ...proposedRules(items, templates)];
  const md = formatReviewQueue(report, { source, date: new Date().toISOString().slice(0, 10) }, extra);
  const out = path.resolve(cwd, values.out!);
  writeFileSync(out, md);
  const lines = [`Review queue: ${report.total} (level B ${report.byLevel.B}, level A not from the manufacturer ${report.byLevel.A}); ${source}`];
  for (const g of report.groups.slice(0, 15)) lines.push(`  ${String(g.count).padStart(4)}  ${g.kind === "lint" ? "B" : "src"}  ${g.reason}  (only ${g.only}) → ${g.proposal.kind}`);
  lines.push(`Report: ${path.relative(cwd, out)}`);
  if (!existsSync(out)) throw new Error(`${out}: not written`);
  process.stdout.write(lines.join("\n") + "\n");
} catch (err) {
  console.error(`report:review-queue failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
