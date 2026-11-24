/**
 * apply:generic-plan — brings the Generic vendor to a reviewed set by
 * docs/avail/generic-plan.json, in one transaction:
 *
 *   rename  "Generic <type or purpose>" in English, no brands: label, shortName, GEN- code,
 *           search terms from the label, no links or brand physical data (genericTemplate);
 *           optional deviceType / category (e.g. power adapters and SD cards go to
 *           schematic=false categories). The row keeps its id: schematics stay linked.
 *   delete  branded products filed under Generic, and duplicates (templates + meta).
 *
 * Templates of the curated library (library/avail, meta source "avail-library") are never
 * touched. Rows written here get meta source "generic-plan", which import:upstream does not
 * overwrite; ids the plan deletes are skipped by import:upstream (see importUpstream.ts).
 */
import type Database from "better-sqlite3";
import planJson from "../../docs/avail/generic-plan.json";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { genericModelNumber, lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { GENERIC_VENDOR } from "../../src/avail/library";
import { genericTemplate } from "../../src/avail/vendorDecisions";
import { AVAIL_LIBRARY_SOURCE } from "./importAvail";
import { BUMP_LIBRARY_VERSION } from "./templateMeta";

export const GENERIC_PLAN_SOURCE = "generic-plan";

export type GenericPlanEntry =
  | { id: string; was: string; action: "rename"; label: string; deviceType?: string; category?: string }
  | { id: string; was: string; action: "delete"; reason: string };

export interface GenericPlan {
  version: number;
  templates: GenericPlanEntry[];
}

export const GENERIC_PLAN = planJson as unknown as GenericPlan;

/** Ids the plan deletes: import:upstream must not bring them back. */
export function plannedDeletions(plan: GenericPlan = GENERIC_PLAN): Set<string> {
  return new Set(plan.templates.filter((e) => e.action === "delete").map((e) => e.id));
}

/** The template a rename entry produces from the stored one. */
export function plannedTemplate(row: TemplateRow, e: Extract<GenericPlanEntry, { action: "rename" }>): Record<string, unknown> {
  const base = genericTemplate({ ...(rowToTemplate(row) as unknown as Record<string, unknown>), ...(e.deviceType ? { deviceType: e.deviceType } : {}) });
  const shortName = e.label.slice(GENERIC_VENDOR.length + 1);
  return {
    ...base,
    label: e.label,
    shortName,
    modelNumber: genericModelNumber(e.label),
    ...(e.category ? { category: e.category } : {}),
    searchTerms: [...new Set([shortName.toLowerCase(), String(base.deviceType), "generic"])],
  };
}

export interface GenericPlanReport {
  dryRun: boolean;
  genericBefore: number;
  genericAfter: number;
  renamed: { id: string; was: string; label: string }[];
  unchanged: number;
  deleted: { id: string; was: string; reason: string }[];
  /** Plan entries whose template is not in this database (already deleted, or never imported). */
  missing: string[];
  /** Plan entries pointing at the curated library: skipped. */
  protectedSkipped: string[];
  levelsAfter: Record<BlockLevel, number>;
}

class DryRun extends Error {}

export function applyGenericPlan(
  sqlite: Database.Database,
  options: { dryRun?: boolean; plan?: GenericPlan; libraryIds?: Iterable<string>; updatedBy?: string } = {},
): GenericPlanReport {
  const plan = options.plan ?? GENERIC_PLAN;
  const libraryIds = new Set(options.libraryIds ?? []);
  const updatedBy = options.updatedBy ?? GENERIC_PLAN_SOURCE;
  const countGeneric = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM templates WHERE manufacturer = ?").get(GENERIC_VENDOR) as { n: number }).n;
  const report: GenericPlanReport = {
    dryRun: !!options.dryRun,
    genericBefore: countGeneric(),
    genericAfter: 0,
    renamed: [],
    unchanged: 0,
    deleted: [],
    missing: [],
    protectedSkipped: [],
    levelsAfter: { A: 0, B: 0, FIX: 0 },
  };

  const getRow = sqlite.prepare("SELECT t.*, m.source AS avail_source FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id WHERE t.id = ?");
  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).filter((c) => c !== "id");
  const update = sqlite.prepare(
    `UPDATE templates SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const noteMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, source, upstream_id, updated_by, updated_at, status_reason, status_changed_at)
     VALUES (?, 'raw', '${GENERIC_PLAN_SOURCE}', NULL, ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET source = excluded.source, upstream_id = NULL, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at, status_reason = excluded.status_reason`,
  );
  const delMeta = sqlite.prepare("DELETE FROM avail_template_meta WHERE template_id = ?");
  const delTemplate = sqlite.prepare("DELETE FROM templates WHERE id = ?");

  const run = sqlite.transaction(() => {
    let changed = false;
    for (const e of plan.templates) {
      const row = getRow.get(e.id) as (TemplateRow & { avail_source: string | null }) | undefined;
      if (!row) {
        report.missing.push(`${e.was} [${e.id}]`);
        continue;
      }
      if (libraryIds.has(row.id) || row.avail_source === AVAIL_LIBRARY_SOURCE) {
        report.protectedSkipped.push(`${row.label} [${row.id}]`);
        continue;
      }
      if (e.action === "delete") {
        delMeta.run(row.id);
        delTemplate.run(row.id);
        report.deleted.push({ id: row.id, was: e.was, reason: e.reason });
        changed = true;
        continue;
      }
      const next = templateToRow({ ...(plannedTemplate(row, e) as never as Parameters<typeof templateToRow>[0]), id: row.id, sortOrder: row.sort_order }) as Record<string, unknown>;
      if (row.avail_source === GENERIC_PLAN_SOURCE && columns.every((c) => ((row as unknown as Record<string, unknown>)[c] ?? null) === (next[c] ?? null))) {
        report.unchanged++;
        continue;
      }
      update.run(next);
      noteMeta.run(row.id, updatedBy, `generic-plan: was "${e.was}"`);
      report.renamed.push({ id: row.id, was: e.was, label: e.label });
      changed = true;
    }
    report.genericAfter = countGeneric();
    for (const r of sqlite.prepare("SELECT * FROM templates WHERE manufacturer = ?").all(GENERIC_VENDOR) as TemplateRow[]) {
      report.levelsAfter[lintBlock(rowToTemplate(r)).level]++;
    }
    if (changed) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
    if (options.dryRun) throw new DryRun();
  });
  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

export function formatGenericPlanReport(r: GenericPlanReport): string {
  const lines = [
    `Generic plan: docs/avail/generic-plan.json${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `Generic templates: ${r.genericBefore} → ${r.genericAfter}; renamed ${r.renamed.length}, unchanged ${r.unchanged}, deleted ${r.deleted.length}`,
    `Levels of Generic templates after: A ${r.levelsAfter.A} / B ${r.levelsAfter.B} / FIX ${r.levelsAfter.FIX}`,
    "",
    "Renamed:",
    ...r.renamed.map((x) => `  ${x.was} → ${x.label} [${x.id}]`),
    "",
    "Deleted:",
    ...r.deleted.map((x) => `  ${x.was} [${x.id}]: ${x.reason}`),
  ];
  if (r.missing.length) lines.push("", `Not in this database (${r.missing.length}):`, ...r.missing.map((m) => `  ${m}`));
  if (r.protectedSkipped.length) lines.push("", "Curated library, skipped:", ...r.protectedSkipped.map((m) => `  ${m}`));
  return lines.join("\n") + "\n";
}
