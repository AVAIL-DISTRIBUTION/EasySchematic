/**
 * apply:vendor-decisions — cleans the library by docs/avail/vendor-decisions.json
 * (rules in src/avail/vendorDecisions.ts), in one transaction:
 *
 *   rename   manufacturer → canonical spelling, the one of our accounting system (Yamaha Pro Audio →
 *            Yamaha, NETGEAR → Netgear-AV, WyreStorm → Wyrestorm); a label that starts with the old
 *            spelling gets the new one ("NETGEAR M4350-16V4C" → "Netgear-AV M4350-16V4C");
 *   scope    Sony outside keepDeviceTypes, Netgear-AV outside keepModelPattern → deleted;
 *   generic  brands we do not carry: for a deviceType without any Generic template, the most
 *            complete branded one becomes "Generic <type>" (same id, so schematics keep their
 *            link) and the others are deleted; where a Generic of that type exists, all the
 *            branded ones are deleted. An existing Generic is never overwritten;
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
import { labelWithManufacturer } from "../../src/avail/normalize";
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
}

export interface FinalGeneric {
  id: string;
  label: string;
  deviceType: string;
  /** Set for a Generic created by this run: the branded template it was made from. */
  from?: string;
}

export interface VendorCleanupReport {
  dryRun: boolean;
  before: number;
  after: number;
  protectedCount: number;
  renamed: { from: string; to: string; count: number }[];
  scopeDeleted: Record<string, number>;
  genericCreated: CreatedGeneric[];
  /** deviceTypes that already had a Generic: nothing created, the branded templates deleted. */
  genericKeptExisting: string[];
  /** Every Generic template after the run, new ones with their source. */
  genericFinal: FinalGeneric[];
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
    genericFinal: [],
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
  const renameStmt = sqlite.prepare("UPDATE templates SET manufacturer = ?, label = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?");
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
          // The label follows only when it starts with a spelling of this vendor.
          const relabeled = labelWithManufacturer(r.label, c.manufacturer, r.manufacturer ?? "");
          const label = relabeled.endsWith(` ${r.label}`) ? r.label : relabeled;
          renameStmt.run(c.manufacturer, label, r.id);
          r.label = label;
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

    // ---- Generic: a new "Generic <type>" only for types that have no Generic template yet.
    // Existing Generic templates (any, class-level or a product filed under Generic) are never
    // overwritten with branded data.
    const genericTypes = new Set(kept.filter((k) => k.manufacturer === GENERIC_VENDOR).map((k) => k.device_type));
    for (const [deviceType, candidates] of [...genericByType].sort(([a], [b]) => a.localeCompare(b))) {
      for (const r of candidates) inc(report.genericMerged, r.manufacturer ?? "?");
      if (genericTypes.has(deviceType)) {
        report.genericKeptExisting.push(deviceType);
        for (const r of candidates) remove(r);
        continue;
      }
      const best = candidates
        .map((r) => ({ r, generic: genericTemplate(rowToTemplate(r) as unknown as Record<string, unknown>) }))
        .map((x) => ({ ...x, score: completeness(x.generic) }))
        .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id))[0];
      const mn = best.r.model_number;
      const from = mn && !best.r.label.includes(mn) ? `${best.r.label} (${mn})` : best.r.label;
      update.run(templateToRow({ ...(best.generic as never as Parameters<typeof templateToRow>[0]), id: best.r.id, sortOrder: best.r.sort_order }));
      noteMeta.run(best.r.id, updatedBy, `vendor-decisions: Generic made from ${from}`);
      report.genericCreated.push({ id: best.r.id, label: String(best.generic.label), deviceType, from });
      genericTypes.add(deviceType);
      for (const r of candidates) if (r.id !== best.r.id) remove(r);
    }

    // Every Generic template after the cleanup, the new ones with their source (dry run too).
    const created = new Map(report.genericCreated.map((g) => [g.id, g]));
    const generics = sqlite
      .prepare("SELECT id, label, device_type FROM templates WHERE manufacturer = ? ORDER BY device_type, label")
      .all(GENERIC_VENDOR) as { id: string; label: string; device_type: string }[];
    report.genericFinal = generics.map((g) => ({
      id: g.id,
      label: g.label,
      deviceType: g.device_type,
      ...(created.has(g.id) ? { from: created.get(g.id)!.from } : {}),
    }));

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
    `Types that already had a Generic (branded templates deleted): ${r.genericKeptExisting.length ? r.genericKeptExisting.join(", ") : "-"}`,
    `Deleted, manufacturer not decided: ${total(r.dropped)} (${Object.keys(r.dropped).length} manufacturers; top: ${top(r.dropped, 10) || "-"})`,
    `Deleted, no manufacturer: ${r.noManufacturer}`,
  ];
  if (r.deletedReviewed.length) {
    lines.push(`Deleted although reviewed (verified/draft): ${r.deletedReviewed.length}`);
    for (const d of r.deletedReviewed) lines.push(`  ${d.status.padEnd(8)} ${d.label} [${d.id}]`);
  }
  const newCount = r.genericFinal.filter((g) => g.from).length;
  lines.push("", `Generic templates after the run: ${r.genericFinal.length} (new ${newCount}, marked NEW with their source)`);
  const w = Math.max(10, ...r.genericFinal.map((g) => g.deviceType.length));
  for (const g of r.genericFinal) {
    lines.push(`  ${g.from ? "NEW" : "   "} ${g.deviceType.padEnd(w)}  ${g.label} [${g.id}]${g.from ? ` ← ${g.from}` : ""}`);
  }
  lines.push("", "Remaining by vendor:", ...Object.entries(r.remainingByVendor).map(([k, n]) => `  ${k.padEnd(24)} ${n}`));
  return lines.join("\n") + "\n";
}
