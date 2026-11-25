/**
 * approve:catalog — bulk approval by the source of the ports (step 1.11).
 *
 * Candidates: templates in status draft loaded from library/catalog (meta source
 * "avail-catalog"). One is approved (verified, approved_via "bulk-source") when
 *   - it is at level A by the current linter (with the library's slot context), and
 *   - its ports come from the manufacturer's documents (src/avail/portsOrigin.ts): an Extron
 *     stencil, a data sheet or the curated library — directly or as a variant of such a card.
 * Ports from the community database (db), or a variant of such a card, and cards with no
 * recorded source stay draft for an engineer's review. status_reason records the source and
 * the document ("ports from stencil (…vssx)"). verified, hidden, raw and the curated library
 * (library/avail, meta source "avail-library") are never touched.
 *
 * One transaction; a second run finds nothing to approve.
 */
import type Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { catalogIndex, describeOrigin, parseCatalogMeta, portsOrigin, type PortsOriginInfo } from "../../src/avail/portsOrigin";
import { AVAIL_CATALOG_SOURCE } from "./importCatalog";
import { BUMP_LIBRARY_VERSION, slotContext } from "./templateMeta";

export const APPROVE_CATALOG_USER = "approve-catalog";

/** Why a draft catalog template is left for review. */
export type LeftReason = "source db" | "variant of db" | "no source" | "level B" | "level FIX";

export interface ApproveCatalogRow {
  id: string;
  label: string;
  vendor: string;
  level: BlockLevel;
  origin: PortsOriginInfo;
  /** approved, or why not. */
  result: "approved" | LeftReason;
  reason?: string;
}

export interface ApproveCatalogReport {
  dryRun: boolean;
  rows: ApproveCatalogRow[];
}

/** Source of a row for the report: the kind, or "<kind> via variant". */
export function sourceKey(o: PortsOriginInfo): string {
  if (o.via) return `${o.via.kind ?? "none"} (variant)`;
  return o.kind ?? "none";
}

function leftReason(o: PortsOriginInfo, level: BlockLevel): LeftReason | null {
  if (o.origin === "community") return o.via ? "variant of db" : "source db";
  if (o.origin === "none") return "no source";
  if (level !== "A") return level === "B" ? "level B" : "level FIX";
  return null;
}

export function approveCatalog(sqlite: Database.Database, options: { dryRun?: boolean } = {}): ApproveCatalogReport {
  const ctx = slotContext(sqlite);
  const metas = sqlite
    .prepare("SELECT catalog FROM avail_template_meta WHERE catalog IS NOT NULL")
    .all() as { catalog: string }[];
  const byFile = catalogIndex(metas.map((m) => parseCatalogMeta(m.catalog)));
  const drafts = sqlite
    .prepare(
      `SELECT t.*, m.source AS avail_source, m.catalog AS avail_catalog
         FROM templates t JOIN avail_template_meta m ON m.template_id = t.id
        WHERE m.status = 'draft' AND m.source = ? AND t.flagged_for_deletion = 0
        ORDER BY t.manufacturer, t.label`,
    )
    .all(AVAIL_CATALOG_SOURCE) as (TemplateRow & { avail_source: string; avail_catalog: string | null })[];

  const rows: ApproveCatalogRow[] = drafts.map((r) => {
    const level = lintBlock(rowToTemplate(r), ctx).level;
    const origin = portsOrigin({ source: r.avail_source, catalog: parseCatalogMeta(r.avail_catalog) }, byFile);
    const left = leftReason(origin, level);
    return {
      id: r.id,
      label: r.label,
      vendor: r.manufacturer ?? "",
      level,
      origin,
      result: left ?? "approved",
      ...(left ? {} : { reason: `approved by source: ports from ${describeOrigin(origin)}` }),
    };
  });

  const approve = rows.filter((r) => r.result === "approved");
  if (!options.dryRun && approve.length) {
    const versions = new Map(drafts.map((d) => [d.id, d.version]));
    const update = sqlite.prepare(
      `UPDATE avail_template_meta
          SET status = 'verified', approved_via = 'bulk-source', approved_at = datetime('now'),
              status_reason = ?, status_changed_at = datetime('now'),
              lint_level = 'A', linted_version = ?, updated_by = ?, updated_at = datetime('now')
        WHERE template_id = ? AND status = 'draft'`,
    );
    sqlite.transaction(() => {
      for (const r of approve) update.run(r.reason, versions.get(r.id) ?? null, APPROVE_CATALOG_USER, r.id);
      sqlite.prepare(BUMP_LIBRARY_VERSION).run();
    })();
  }
  return { dryRun: !!options.dryRun, rows };
}

export function formatApproveCatalogReport(r: ApproveCatalogReport, verbose = false): string {
  const approved = r.rows.filter((x) => x.result === "approved");
  const left = r.rows.filter((x) => x.result !== "approved");
  const lines = [
    `approve:catalog: ${r.rows.length} draft catalog templates${r.dryRun ? " (dry run, nothing written)" : ""}; ` +
      `${r.dryRun ? "would approve" : "approved"} ${approved.length}, left for review ${left.length}`,
    "",
  ];
  const vendors = [...new Set(r.rows.map((x) => x.vendor))].sort();
  const sources = [...new Set(approved.map((x) => sourceKey(x.origin)))].sort();
  if (approved.length) {
    lines.push(`${r.dryRun ? "Would approve" : "Approved"} by vendor and source:`);
    lines.push(`  ${"vendor".padEnd(10)} ${sources.map((s) => s.padStart(20)).join(" ")} ${"total".padStart(7)}`);
    for (const v of vendors) {
      const vs = approved.filter((x) => x.vendor === v);
      if (!vs.length) continue;
      lines.push(`  ${v.padEnd(10)} ${sources.map((s) => String(vs.filter((x) => sourceKey(x.origin) === s).length).padStart(20)).join(" ")} ${String(vs.length).padStart(7)}`);
    }
    lines.push("");
  }
  const reasons: string[] = ["source db", "variant of db", "no source", "level B", "level FIX"];
  lines.push("Left for review (draft):");
  for (const reason of reasons) {
    const rs = left.filter((x) => x.result === reason);
    if (!rs.length) continue;
    const per = vendors.map((v) => `${v} ${rs.filter((x) => x.vendor === v).length}`).filter((s) => !s.endsWith(" 0")).join(", ");
    lines.push(`  ${reason.padEnd(14)} ${String(rs.length).padStart(5)}  (${per})`);
  }
  if (!left.length) lines.push("  none");
  if (verbose) {
    lines.push("", "Templates:");
    for (const x of r.rows) lines.push(`  ${x.result.padEnd(14)} ${x.level.padEnd(3)} ${x.label} — ${describeOrigin(x.origin)}`);
  }
  return lines.join("\n") + "\n";
}
