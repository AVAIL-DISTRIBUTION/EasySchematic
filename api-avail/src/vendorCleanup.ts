/**
 * apply:vendor-decisions — cleans the library by docs/avail/vendor-decisions.json
 * (rules in src/avail/vendorDecisions.ts), in one transaction:
 *
 *   rename   manufacturer → canonical spelling (Yamaha Pro Audio → Yamaha, Netgear → NETGEAR);
 *   scope    Sony outside keepDeviceTypes, NETGEAR outside keepModelPattern → deleted;
 *   generic  brands we do not carry: per deviceType the most complete template becomes
 *            "Generic <type>" (same id, so schematics keep their link), the others are
 *            deleted. No duplicates: when a class-level Generic of that type ("Generic …")
 *            is already at least as complete, all of them go; when it is less complete, its
 *            row takes the new data (keeping its id). Curated-library Generics are never
 *            overwritten;
 *   drop     manufacturers outside keep/rename/generic, and templates without one → deleted
 *            (templates + avail_template_meta).
 *
 * Templates of the curated library (library/avail/, meta source "avail-library") are never
 * touched. Deleting is safe for saved schematics: a device carries its own data, the
 * template id is only a link (see the tests).
 */
import type Database from "better-sqlite3";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { GENERIC_VENDOR } from "../../src/avail/library";
import { completeness, genericTemplate, VendorRules } from "../../src/avail/vendorDecisions";
import { AVAIL_LIBRARY_SOURCE } from "./importAvail";
import { VENDOR_DECISIONS_SOURCE } from "./importUpstream";
import { BUMP_LIBRARY_VERSION } from "./templateMeta";

export { VENDOR_DECISIONS_SOURCE };

export interface CreatedGeneric {
  id: string;
  label: string;
  deviceType: string;
  /** Branded template it was made from. */
  from: string;
  /** Existing, less complete Generic of the type whose row took the new data (no duplicate). */
  replaced?: string;
}

export interface VendorCleanupReport {
  dryRun: boolean;
  before: number;
  after: number;
  protectedCount: number;
  renamed: { from: string; to: string; count: number }[];
  scopeDeleted: Record<string, number>;
  genericCreated: CreatedGeneric[];
  /** deviceTypes where an existing Generic was already as complete: nothing created. */
  genericKeptExisting: string[];
  /** Branded templates folded into Generic (deleted), per manufacturer. */
  genericMerged: Record<string, number>;
  /** Deleted: manufacturer not decided, per manufacturer. */
  dropped: Record<string, number>;
  noManufacturer: number;
  deletedTotal: number;
  /** Deleted templates that a person had marked verified or draft. */
  deletedReviewed: { id: string; label: string; status: string }[];
  remainingByVendor: Record<string, number>;
}

type Row = TemplateRow & { avail_status: string | null; avail_source: string | null };

class DryRun extends Error {}

const inc = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

export function applyVendorDecisions(
  sqlite: Database.Database,
  options: { dryRun?: boolean; libraryIds?: Iterable<string>; rules?: VendorRules; updatedBy?: string } = {},
): VendorCleanupReport {
  const rules = options.rules ?? new VendorRules();
  const updatedBy = options.updatedBy ?? "vendor-decisions";
  const libraryIds = new Set(options.libraryIds ?? []);
  const rows = sqlite
    .prepare(
      `SELECT t.*, m.status AS avail_status, m.source AS avail_source FROM templates t
         LEFT JOIN avail_template_meta m ON m.template_id = t.id ORDER BY t.sort_order, t.id`,
    )
    .all() as Row[];

  const report: VendorCleanupReport = {
    dryRun: !!options.dryRun,
    before: rows.length,
    after: 0,
    protectedCount: 0,
    renamed: [],
    scopeDeleted: {},
    genericCreated: [],
    genericKeptExisting: [],
    genericMerged: {},
    dropped: {},
    noManufacturer: 0,
    deletedTotal: 0,
    deletedReviewed: [],
    remainingByVendor: {},
  };

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).filter((c) => c !== "id");
  const update = sqlite.prepare(
    `UPDATE templates SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const renameStmt = sqlite.prepare("UPDATE templates SET manufacturer = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?");
  const delMeta = sqlite.prepare("DELETE FROM avail_template_meta WHERE template_id = ?");
  const delTemplate = sqlite.prepare("DELETE FROM templates WHERE id = ?");
  // Rows written here get source "vendor-decisions": import:upstream leaves them alone, so a
  // repeated import cannot put the branded data back.
  const noteMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, source, upstream_id, updated_by, updated_at, status_reason, status_changed_at)
     VALUES (?, 'raw', '${VENDOR_DECISIONS_SOURCE}', NULL, ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET source = excluded.source, upstream_id = NULL, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at, status_reason = excluded.status_reason`,
  );

  const isProtected = (r: Row) => libraryIds.has(r.id) || r.avail_source === AVAIL_LIBRARY_SOURCE;
  const remove = (r: Row) => {
    if (r.avail_status === "verified" || r.avail_status === "draft") {
      report.deletedReviewed.push({ id: r.id, label: r.label, status: r.avail_status });
    }
    delMeta.run(r.id);
    delTemplate.run(r.id);
    report.deletedTotal++;
  };

  const run = sqlite.transaction(() => {
    const renames = new Map<string, { from: string; to: string; count: number }>();
    const genericByType = new Map<string, Row[]>();
    const kept: Row[] = [];

    for (const r of rows) {
      if (isProtected(r)) {
        report.protectedCount++;
        kept.push(r);
        continue;
      }
      const c = rules.classify({ manufacturer: r.manufacturer, deviceType: r.device_type, modelNumber: r.model_number, label: r.label });
      if (c.kind === "none") {
        report.noManufacturer++;
        remove(r);
      } else if (c.kind === "drop") {
        inc(report.dropped, c.manufacturer);
        remove(r);
      } else if (c.kind === "scope") {
        inc(report.scopeDeleted, c.manufacturer);
        remove(r);
      } else if (c.kind === "generic") {
        const list = genericByType.get(r.device_type) ?? [];
        list.push(r);
        genericByType.set(r.device_type, list);
      } else {
        if (c.renamed) {
          renameStmt.run(c.manufacturer, r.id);
          const k = `${r.manufacturer}→${c.manufacturer}`;
          const e = renames.get(k) ?? { from: r.manufacturer ?? "", to: c.manufacturer, count: 0 };
          e.count++;
          renames.set(k, e);
          r.manufacturer = c.manufacturer;
        }
        kept.push(r);
      }
    }
    report.renamed = [...renames.values()].sort((a, b) => b.count - a.count);

    // ---- Generic: one per deviceType, no duplicates with existing Generic templates
    for (const [deviceType, candidates] of [...genericByType].sort(([a], [b]) => a.localeCompare(b))) {
      const scored = candidates
        .map((r) => ({ r, generic: genericTemplate(rowToTemplate(r) as unknown as Record<string, unknown>) }))
        .map((x) => ({ ...x, score: completeness(x.generic) }))
        .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
      const best = scored[0];
      // Class-level Generic templates of this type ("Generic Display"); product templates
      // filed under Generic (an SFP module, "Trolley TV") are other things and not compared.
      // Both sides are scored in their Generic form, so the conversion itself gives no edge.
      const existing = kept
        .filter((k) => k.manufacturer === GENERIC_VENDOR && k.device_type === deviceType && k.label.startsWith(`${GENERIC_VENDOR} `))
        .map((k) => ({ k, score: completeness(genericTemplate(rowToTemplate(k) as unknown as Record<string, unknown>)) }))
        .sort((a, b) => b.score - a.score);
      for (const x of scored) inc(report.genericMerged, x.r.manufacturer ?? "?");

      if (existing.length && existing[0].score >= best.score) {
        report.genericKeptExisting.push(deviceType);
        for (const x of scored) remove(x.r);
        continue;
      }
      // The more complete data wins; an existing Generic keeps its id (schematics link to it).
      const replace = existing.find((e) => !isProtected(e.k));
      const targetId = replace ? replace.k.id : best.r.id;
      const from = `${best.r.manufacturer} ${best.r.model_number ?? best.r.label}`.trim();
      update.run(templateToRow({ ...(best.generic as never as Parameters<typeof templateToRow>[0]), id: targetId, sortOrder: (replace?.k ?? best.r).sort_order }));
      noteMeta.run(targetId, updatedBy, `vendor-decisions: Generic made from ${from}`);
      report.genericCreated.push({
        id: targetId,
        label: String(best.generic.label),
        deviceType,
        from,
        ...(replace ? { replaced: `${replace.k.label} [${replace.k.id}]` } : {}),
      });
      for (const x of scored) if (x.r.id !== targetId) remove(x.r);
    }

    const remaining = sqlite.prepare("SELECT manufacturer, COUNT(*) AS n FROM templates GROUP BY manufacturer ORDER BY n DESC").all() as {
      manufacturer: string | null;
      n: number;
    }[];
    report.after = remaining.reduce((s, x) => s + x.n, 0);
    for (const x of remaining) report.remainingByVendor[x.manufacturer ?? "(none)"] = x.n;

    if (report.deletedTotal > 0 || report.renamed.length > 0 || report.genericCreated.length > 0) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
    if (options.dryRun) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

const total = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);
const top = (m: Record<string, number>, n = 15) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

export function formatVendorCleanupReport(r: VendorCleanupReport): string {
  const lines = [
    `Vendor decisions: docs/avail/vendor-decisions.json${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `Templates: ${r.before} → ${r.after}; deleted ${r.deletedTotal}; curated library (untouched) ${r.protectedCount}`,
    "",
    `Renamed: ${r.renamed.reduce((s, x) => s + x.count, 0)}`,
    ...r.renamed.map((x) => `  ${x.from} → ${x.to}: ${x.count}`),
    `Deleted by scope: ${total(r.scopeDeleted)}${total(r.scopeDeleted) ? ` (${top(r.scopeDeleted)})` : ""}`,
    `Folded into Generic: ${total(r.genericMerged)} branded templates (${top(r.genericMerged)})`,
    `Generic templates created: ${r.genericCreated.length}`,
    ...r.genericCreated.map((g) => `  ${g.label} [${g.id}] from ${g.from}${g.replaced ? `, written over the less complete ${g.replaced}` : ""}`),
    `Types where an existing Generic was kept: ${r.genericKeptExisting.length ? r.genericKeptExisting.join(", ") : "-"}`,
    `Deleted, manufacturer not decided: ${total(r.dropped)} (${Object.keys(r.dropped).length} manufacturers; top: ${top(r.dropped, 10) || "-"})`,
    `Deleted, no manufacturer: ${r.noManufacturer}`,
  ];
  if (r.deletedReviewed.length) {
    lines.push(`Deleted although reviewed (verified/draft): ${r.deletedReviewed.length}`);
    for (const d of r.deletedReviewed) lines.push(`  ${d.status.padEnd(8)} ${d.label} [${d.id}]`);
  }
  lines.push("", "Remaining by vendor:", ...Object.entries(r.remainingByVendor).map(([k, n]) => `  ${k.padEnd(24)} ${n}`));
  return lines.join("\n") + "\n";
}
