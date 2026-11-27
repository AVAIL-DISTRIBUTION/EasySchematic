/**
 * Empties the prices (templates.unit_cost) of the templates the product catalog loaded
 * (avail_template_meta.source = avail-catalog). The repository is public and keeps no prices,
 * import:catalog no longer writes them (src/importCatalog.ts); this removes the ones an earlier
 * import left in the database. Status, level and everything else stay; version goes up so the
 * library ETag and the linter see the change. Other templates are only counted.
 */
import type Database from "better-sqlite3";
import { AVAIL_CATALOG_SOURCE } from "./importCatalog";

export interface ClearCatalogPricesReport {
  dryRun: boolean;
  /** Catalog templates whose price is (or would be) emptied, by manufacturer. */
  cleared: { id: string; label: string; manufacturer: string }[];
  byManufacturer: Record<string, number>;
  /** Templates outside the catalog that still have a price (not touched). */
  otherWithPrice: number;
}

export function clearCatalogPrices(sqlite: Database.Database, options: { dryRun?: boolean } = {}): ClearCatalogPricesReport {
  const dryRun = !!options.dryRun;
  const rows = sqlite
    .prepare(
      `SELECT t.id, t.label, COALESCE(t.manufacturer, '') AS manufacturer FROM templates t
         JOIN avail_template_meta m ON m.template_id = t.id
        WHERE m.source = ? AND t.unit_cost IS NOT NULL
        ORDER BY t.manufacturer, t.label`,
    )
    .all(AVAIL_CATALOG_SOURCE) as { id: string; label: string; manufacturer: string }[];
  const otherWithPrice = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
          WHERE t.unit_cost IS NOT NULL AND COALESCE(m.source, '') <> ?`,
      )
      .get(AVAIL_CATALOG_SOURCE) as { n: number }
  ).n;
  const byManufacturer: Record<string, number> = {};
  for (const r of rows) byManufacturer[r.manufacturer || "?"] = (byManufacturer[r.manufacturer || "?"] ?? 0) + 1;
  if (!dryRun && rows.length) {
    const clear = sqlite.prepare(`UPDATE templates SET unit_cost = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ?`);
    sqlite.transaction(() => {
      for (const r of rows) clear.run(r.id);
    })();
  }
  return { dryRun, cleared: rows, byManufacturer, otherWithPrice };
}

export function formatClearCatalogPricesReport(r: ClearCatalogPricesReport, verbose = false): string {
  const lines = [`Catalog prices${r.dryRun ? " (dry run, nothing written)" : ""}`];
  lines.push(`${r.dryRun ? "Would clear" : "Cleared"} unitCost on ${r.cleared.length} catalog templates`);
  for (const [m, n] of Object.entries(r.byManufacturer)) lines.push(`  ${m.padEnd(12)} ${n}`);
  if (verbose) for (const t of r.cleared) lines.push(`    ${t.id} ${t.label}`);
  lines.push(`Templates outside the catalog with a price (not touched): ${r.otherWithPrice}`);
  return lines.join("\n") + "\n";
}

/** Numbers for the run's audit entry (one entry per run). */
export function clearPricesRunCounts(r: ClearCatalogPricesReport): Record<string, number> {
  return { cleared: r.cleared.length, otherWithPrice: r.otherWithPrice };
}
