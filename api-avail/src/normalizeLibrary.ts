/**
 * Runs the block normalizer (src/avail/normalize.ts) over the library templates of our
 * vendors (avail-vendors.json, Generic included) that are raw or draft.
 *
 * A template is written only when normalization raises its standard level
 * (FIX → B, FIX → A, B → A); its status stays as it was — a human approves.
 * Written templates get version + 1 (like an upstream save) and a fresh lint level.
 */
import type Database from "better-sqlite3";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { findVendor, VENDORS } from "../../src/avail/library";
import { normalizeBlock } from "../../src/avail/normalize";
import { BUMP_LIBRARY_VERSION, type TemplateStatus } from "./templateMeta";

const RANK: Record<BlockLevel, number> = { FIX: 0, B: 1, A: 2 };
const NORMALIZED_STATUSES: TemplateStatus[] = ["raw", "draft"];

export interface VendorStats {
  processed: number;
  written: number;
  fixToB: number;
  fixToA: number;
  bToA: number;
}

export interface NormalizeLibraryReport {
  dryRun: boolean;
  processed: number;
  /** Templates whose level went up (written, unless dry run). */
  improved: number;
  /** "FIX→B", "B→A", "FIX→FIX", … (level before → level after normalization). */
  transitions: Record<string, number>;
  /** Normalization changed something but the level stayed: not written. */
  sameLevelNotWritten: number;
  byVendor: Record<string, VendorStats>;
  /** Most frequent lint messages left after the run (E/W, port names masked). */
  topReasons: { reason: string; count: number }[];
  /** Most frequent "requires manual fix" notes of the normalizer. */
  topManual: { reason: string; count: number }[];
  levelsAfter: Record<BlockLevel, number>;
}

/** Lint message without the specific port / value: "«HDMI In»: нет connectorType" → "E нет connectorType". */
export function reasonKey(kind: "E" | "W", message: string): string {
  const m = message
    .replace(/^«[^»]*»: /, "")
    .replace(/«[^»]*»/g, "«…»")
    .replace(/\(([^\s)]+)\)$/, "(…)");
  return `${kind} ${m}`;
}

function top(counter: Map<string, number>, n: number): { reason: string; count: number }[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

export function normalizeLibrary(
  sqlite: Database.Database,
  options: { dryRun?: boolean; updatedBy?: string } = {},
): NormalizeLibraryReport {
  const report: NormalizeLibraryReport = {
    dryRun: !!options.dryRun,
    processed: 0,
    improved: 0,
    transitions: {},
    sameLevelNotWritten: 0,
    byVendor: Object.fromEntries(VENDORS.map((v) => [v.name, { processed: 0, written: 0, fixToB: 0, fixToA: 0, bToA: 0 }])),
    topReasons: [],
    topManual: [],
    levelsAfter: { A: 0, B: 0, FIX: 0 },
  };
  const reasons = new Map<string, number>();
  const manual = new Map<string, number>();

  const rows = sqlite
    .prepare(
      `SELECT t.*, COALESCE(m.status, 'raw') AS avail_status FROM templates t
         LEFT JOIN avail_template_meta m ON m.template_id = t.id
        WHERE COALESCE(m.status, 'raw') IN (${NORMALIZED_STATUSES.map(() => "?").join(", ")})
        ORDER BY t.sort_order, t.label`,
    )
    .all(...NORMALIZED_STATUSES) as (TemplateRow & { avail_status: TemplateStatus })[];

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).filter((c) => c !== "id");
  const update = sqlite.prepare(
    `UPDATE templates SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, version = version + 1, updated_at = datetime('now')
      WHERE id = @id`,
  );
  const upsertMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, lint_level, linted_version, updated_by, updated_at)
     VALUES (@id, @status, @level, @version, @by, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET lint_level = excluded.lint_level, linted_version = excluded.linted_version,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );

  const run = sqlite.transaction(() => {
    let wrote = false;
    for (const row of rows) {
      const vendor = findVendor(row.manufacturer);
      if (!vendor) continue;
      const stats = report.byVendor[vendor.name];
      report.processed++;
      stats.processed++;

      const template = rowToTemplate(row);
      const before = lintBlock(template);
      const { template: normalized, changes } = normalizeBlock(template);
      const after = lintBlock(normalized);
      const key = `${before.level}→${after.level}`;
      report.transitions[key] = (report.transitions[key] ?? 0) + 1;
      for (const c of changes) if (c.manual) manual.set(c.note.replace(/«[^»]*»/g, "«…»"), (manual.get(c.note.replace(/«[^»]*»/g, "«…»")) ?? 0) + 1);

      const improves = RANK[after.level] > RANK[before.level];
      const final = improves ? after : before;
      if (improves) {
        report.improved++;
        if (key === "FIX→B") stats.fixToB++;
        if (key === "FIX→A") stats.fixToA++;
        if (key === "B→A") stats.bToA++;
        if (!options.dryRun) {
          const next = templateToRow({ ...(normalized as never as Parameters<typeof templateToRow>[0]), id: row.id, sortOrder: row.sort_order });
          update.run(next);
          upsertMeta.run({ id: row.id, status: row.avail_status, level: after.level, version: row.version + 1, by: options.updatedBy ?? "normalize" });
          stats.written++;
          wrote = true;
        }
      } else if (changes.some((c) => !c.manual)) {
        report.sameLevelNotWritten++;
      }
      report.levelsAfter[final.level]++;
      for (const e of final.errors) reasons.set(reasonKey("E", e), (reasons.get(reasonKey("E", e)) ?? 0) + 1);
      for (const w of final.warnings) reasons.set(reasonKey("W", w), (reasons.get(reasonKey("W", w)) ?? 0) + 1);
    }
    if (wrote) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
  });
  run();

  report.topReasons = top(reasons, 10);
  report.topManual = top(manual, 5);
  return report;
}

export function formatNormalizeReport(r: NormalizeLibraryReport): string {
  const vendors = Object.entries(r.byVendor).filter(([, s]) => s.processed > 0);
  const w = Math.max(6, ...vendors.map(([n]) => n.length));
  const transitions = Object.entries(r.transitions).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  return [
    `Нормализация шаблонов наших вендоров (raw/draft)${r.dryRun ? " — пробный запуск, в базу ничего не записано" : ""}`,
    `Обработано: ${r.processed}; уровень вырос: ${r.improved}${r.dryRun ? "" : " (записано)"}; изменения без роста уровня (не записаны): ${r.sameLevelNotWritten}`,
    `Переходы: ${transitions || "—"}`,
    `Уровни после: A ${r.levelsAfter.A} / B ${r.levelsAfter.B} / FIX ${r.levelsAfter.FIX}`,
    ``,
    `По вендорам:   ${"обработано".padStart(10)}  FIX→B  FIX→A  B→A`,
    ...vendors.map(([name, s]) => `  ${name.padEnd(w)}  ${String(s.processed).padStart(10)}  ${String(s.fixToB).padStart(5)}  ${String(s.fixToA).padStart(5)}  ${String(s.bToA).padStart(3)}`),
    ``,
    `Топ-10 оставшихся причин:`,
    ...r.topReasons.map((x, i) => `  ${String(i + 1).padStart(2)}. ${x.reason} — ${x.count}`),
    ``,
    `Требует ручной правки (топ-5):`,
    ...r.topManual.map((x) => `  - ${x.reason} — ${x.count}`),
  ].join("\n") + "\n";
}
