/**
 * apply:worklist — applies the engineers' worklist solutions (worklistSolutions.ts) to the
 * library, and export:vendor-requests — what manufacturers do not publish, per vendor.
 *
 * Per Template id: the structured actions of the "applied" lines are written (version + 1, meta
 * updated_by "worklist"); statuses are not changed (a person approves); curated templates
 * (library/avail) are skipped — their file is the source. Afterwards every template's level is
 * recomputed against the library, and each line N is checked against Issue N: a false positive is
 * confirmed when the issue is gone under the current rules, an applied line when its fix removed it.
 */
import type Database from "better-sqlite3";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { findVendor } from "../../src/avail/library";
import { AVAIL_LIBRARY_SOURCE } from "./importAvail";
import { BUMP_LIBRARY_VERSION, relintAll, slotContext } from "./templateMeta";
import { applyActions, parseSolution, type SolutionLine } from "./worklistSolutions";

export interface WorklistRowInput {
  "Template id"?: string;
  Vendor?: string;
  Model?: string;
  "Part number"?: string;
  "Issue 1"?: string;
  "Issue 2"?: string;
  "Issue 3"?: string;
  Solution?: string;
  "Solution status"?: string;
}

export interface LineCheck {
  templateId: string;
  model: string;
  n: number;
  issue: string;
  text: string;
}

export interface ApplyWorklistReport {
  dryRun: boolean;
  rows: number;
  templatesChanged: number;
  /** Templates whose data already matches the solutions (an earlier run). */
  alreadyApplied: number;
  missingTemplates: string[];
  curatedSkipped: string[];
  lines: Record<SolutionLine["kind"], number>;
  actionsApplied: number;
  /** Actions that could not be applied (port not found, unknown connector, …). */
  actionsSkipped: { templateId: string; model: string; reason: string }[];
  /** Lines (or parts) that are free text: for a person. */
  manual: { templateId: string; model: string; n: number; text: string }[];
  falsePositiveGone: number;
  /** False positives whose issue is still reported under the current rules. */
  falsePositiveRemaining: LineCheck[];
  appliedGone: number;
  /** Applied lines whose issue is still there (the fix was partial or about something else). */
  appliedRemaining: LineCheck[];
  noData: number;
  levelsBefore: Record<string, Record<BlockLevel, number>>;
  levelsAfter: Record<string, Record<BlockLevel, number>>;
}

class DryRun extends Error {}

/** The lint message of an Issue cell: "W \"X\": label in all caps" → "\"X\": label in all caps". */
function issueMessage(issue: string): string {
  return issue.replace(/^[EW]\s+/, "").trim();
}

function levelsByVendor(sqlite: Database.Database): Record<string, Record<BlockLevel, number>> {
  const ctx = slotContext(sqlite);
  const out: Record<string, Record<BlockLevel, number>> = {};
  for (const r of sqlite.prepare("SELECT * FROM templates WHERE flagged_for_deletion = 0").all() as TemplateRow[]) {
    const v = findVendor(r.manufacturer)?.name;
    if (!v) continue;
    const lv = lintBlock(rowToTemplate(r), ctx).level;
    out[v] ??= { A: 0, B: 0, FIX: 0 };
    out[v][lv]++;
  }
  return out;
}

export function applyWorklist(
  sqlite: Database.Database,
  rows: WorklistRowInput[],
  options: { dryRun?: boolean; updatedBy?: string } = {},
): ApplyWorklistReport {
  const updatedBy = options.updatedBy ?? "worklist";
  const report: ApplyWorklistReport = {
    dryRun: !!options.dryRun,
    rows: rows.length,
    templatesChanged: 0,
    alreadyApplied: 0,
    missingTemplates: [],
    curatedSkipped: [],
    lines: { applied: 0, "false-positive": 0, "no-data": 0, manual: 0 },
    actionsApplied: 0,
    actionsSkipped: [],
    manual: [],
    falsePositiveGone: 0,
    falsePositiveRemaining: [],
    appliedGone: 0,
    appliedRemaining: [],
    noData: 0,
    levelsBefore: levelsByVendor(sqlite),
    levelsAfter: {},
  };

  const getRow = sqlite.prepare("SELECT t.*, m.source AS avail_source FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id WHERE t.id = ?");
  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).filter((c) => c !== "id");
  const update = sqlite.prepare(
    `UPDATE templates SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const noteMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, updated_by, updated_at) VALUES (?, 'raw', ?, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );

  const parsed = rows.map((r) => ({ row: r, id: (r["Template id"] ?? "").trim(), lines: parseSolution(r.Solution ?? "") }));

  const run = sqlite.transaction(() => {
    for (const { row, id, lines } of parsed) {
      const model = row.Model ?? id;
      for (const l of lines) {
        report.lines[l.kind]++;
        if (l.kind === "no-data") report.noData++;
        if (l.kind === "manual" || l.unparsed.length) {
          report.manual.push({ templateId: id, model, n: l.n, text: l.kind === "manual" ? l.text : l.unparsed.join("; ") });
        }
      }
      const actions = lines.filter((l) => l.kind === "applied").flatMap((l) => l.actions);
      if (!actions.length) continue;
      const dbRow = getRow.get(id) as (TemplateRow & { avail_source: string | null }) | undefined;
      if (!dbRow) {
        report.missingTemplates.push(`${model} [${id}]`);
        continue;
      }
      if (dbRow.avail_source === AVAIL_LIBRARY_SOURCE) {
        report.curatedSkipped.push(`${model} [${id}]`);
        continue;
      }
      const res = applyActions(rowToTemplate(dbRow) as unknown as Record<string, unknown>, actions);
      const next = templateToRow({ ...(res.template as never as Parameters<typeof templateToRow>[0]), id, sortOrder: dbRow.sort_order }) as Record<string, unknown>;
      // Written only when the data changes: a second run with the same file is a no-op.
      const changed = columns.some((c) => ((dbRow as unknown as Record<string, unknown>)[c] ?? null) !== (next[c] ?? null));
      if (!changed) {
        report.alreadyApplied++;
        continue;
      }
      for (const reason of res.skipped) report.actionsSkipped.push({ templateId: id, model, reason });
      if (!res.applied.length) continue;
      report.actionsApplied += res.applied.length;
      update.run(next);
      noteMeta.run(id, updatedBy);
      report.templatesChanged++;
    }
    if (report.templatesChanged) sqlite.prepare(BUMP_LIBRARY_VERSION).run();

    // Check every line against its issue with the current rules and data.
    const ctx = slotContext(sqlite);
    for (const { row, id, lines } of parsed) {
      const dbRow = getRow.get(id) as TemplateRow | undefined;
      if (!dbRow) continue;
      const lint = lintBlock(rowToTemplate(dbRow), ctx);
      const present = new Set([...lint.errors, ...lint.warnings]);
      for (const l of lines) {
        if (l.kind !== "false-positive" && l.kind !== "applied") continue;
        const issue = (row[`Issue ${l.n}` as keyof WorklistRowInput] as string | undefined) ?? "";
        if (!issue) continue;
        const gone = !present.has(issueMessage(issue));
        const check = { templateId: id, model: row.Model ?? id, n: l.n, issue, text: l.text };
        if (l.kind === "false-positive") {
          if (gone) report.falsePositiveGone++;
          else report.falsePositiveRemaining.push(check);
        } else if (gone) report.appliedGone++;
        else report.appliedRemaining.push(check);
      }
    }
    report.levelsAfter = levelsByVendor(sqlite);
    if (!options.dryRun) relintAll(sqlite);
    if (options.dryRun) throw new DryRun();
  });
  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

export function formatApplyWorklistReport(r: ApplyWorklistReport, source: string): string {
  const total = (m: Record<BlockLevel, number>) => `A ${m.A} / B ${m.B} / FIX ${m.FIX}`;
  const sum = (x: Record<string, Record<BlockLevel, number>>) =>
    Object.values(x).reduce((s, m) => ({ A: s.A + m.A, B: s.B + m.B, FIX: s.FIX + m.FIX }), { A: 0, B: 0, FIX: 0 });
  const vendors = [...new Set([...Object.keys(r.levelsBefore), ...Object.keys(r.levelsAfter)])].sort();
  const w = Math.max(10, ...vendors.map((v) => v.length));
  const lines = [
    `Worklist solutions: ${source}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `Rows: ${r.rows}; templates changed: ${r.templatesChanged} (already as in the file: ${r.alreadyApplied}); actions applied: ${r.actionsApplied}, not applied: ${r.actionsSkipped.length}`,
    `Lines: applied ${r.lines.applied}, false positive ${r.lines["false-positive"]}, no data ${r.lines["no-data"]}, manual ${r.lines.manual} (+ manual parts of other lines: ${r.manual.length - r.lines.manual})`,
    `False positives: gone under the current rules ${r.falsePositiveGone}, still reported ${r.falsePositiveRemaining.length}`,
    `Applied lines: issue gone ${r.appliedGone}, issue still there ${r.appliedRemaining.length}`,
    `Templates not in this database: ${r.missingTemplates.length}; curated (edit the library file instead): ${r.curatedSkipped.length}`,
    "",
    `Levels by vendor (our vendors):  before → after`,
    ...vendors.map((v) => `  ${v.padEnd(w)}  ${total(r.levelsBefore[v] ?? { A: 0, B: 0, FIX: 0 }).padEnd(26)} → ${total(r.levelsAfter[v] ?? { A: 0, B: 0, FIX: 0 })}`),
    `  ${"Total".padEnd(w)}  ${total(sum(r.levelsBefore)).padEnd(26)} → ${total(sum(r.levelsAfter))}`,
    "",
    `False positives still reported (rule or data to look at):`,
    ...(r.falsePositiveRemaining.length ? r.falsePositiveRemaining.map((x) => `  ${x.model} [${x.templateId}] #${x.n}: ${x.issue} — ${x.text.slice(0, 140)}`) : ["  -"]),
    "",
    `Manual (not applied):`,
    ...(r.manual.length ? r.manual.map((x) => `  ${x.model} [${x.templateId}] #${x.n}: ${x.text.slice(0, 200)}`) : ["  -"]),
    "",
    `Actions not applied:`,
    ...(r.actionsSkipped.length ? r.actionsSkipped.map((x) => `  ${x.model} [${x.templateId}]: ${x.reason}`) : ["  -"]),
    "",
    `Applied, but the issue is still there:`,
    ...(r.appliedRemaining.length ? r.appliedRemaining.map((x) => `  ${x.model} [${x.templateId}] #${x.n}: ${x.issue}`) : ["  -"]),
  ];
  if (r.missingTemplates.length) lines.push("", "Templates not in this database:", ...r.missingTemplates.map((m) => `  ${m}`));
  if (r.curatedSkipped.length) lines.push("", "Curated templates (library/avail), skipped:", ...r.curatedSkipped.map((m) => `  ${m}`));
  return lines.join("\n") + "\n";
}

export interface VendorRequest {
  vendor: string;
  model: string;
  partNumber: string;
  missing: string[];
  note: string;
  templateId: string;
  referenceUrl: string;
}

/** What manufacturers do not publish ("Нет данных" parts of the solutions), per vendor. */
export function vendorRequests(sqlite: Database.Database, rows: WorklistRowInput[]): VendorRequest[] {
  const get = sqlite.prepare("SELECT manufacturer, label, model_number, reference_url FROM templates WHERE id = ?");
  const out: VendorRequest[] = [];
  for (const r of rows) {
    const id = (r["Template id"] ?? "").trim();
    // Only fields a manufacturer can publish; library tasks ("no cards in the library") are not requests.
    const lines = parseSolution(r.Solution ?? "").filter((l) => l.missing.length);
    if (!lines.length) continue;
    const db = get.get(id) as { manufacturer: string | null; label: string; model_number: string | null; reference_url: string | null } | undefined;
    const missing = [...new Set(lines.flatMap((l) => l.missing))];
    out.push({
      vendor: findVendor(db?.manufacturer ?? r.Vendor)?.name ?? r.Vendor ?? "",
      model: db?.label ?? r.Model ?? "",
      partNumber: db?.model_number ?? r["Part number"] ?? "",
      missing,
      note: lines.map((l) => l.text.replace(/\s*\[нет данных\]\s*/gi, "")).join(" | "),
      templateId: id,
      referenceUrl: db?.reference_url ?? "",
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model));
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with a BOM (Excel), one row per template. */
export function vendorRequestsCsv(rows: VendorRequest[]): string {
  const header = ["Vendor", "Model", "Part number", "Missing fields", "Engineer note", "Reference URL", "Template id"];
  const body = rows.map((r) => [r.vendor, r.model, r.partNumber, r.missing.join(", "), r.note, r.referenceUrl, r.templateId].map(csvCell).join(","));
  return "﻿" + [header.join(","), ...body].join("\r\n") + "\r\n";
}
