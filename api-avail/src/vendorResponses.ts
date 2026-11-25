/**
 * apply:vendor-responses — vendors' answers to our data requests (step 1.8b),
 * tools/avail/incoming/vendor-responses.json:
 *
 *   delete  templates removed for good (end of life, not ours): the template row and its
 *           avail_template_meta (template_notes go with them, ON DELETE CASCADE). Their ids are
 *           kept in docs/avail/deleted-templates.json, which import:upstream skips.
 *   update  `set` fields written as in the file (no "improvements"); `note` becomes a moderator
 *           note of the template (upstream template_notes, GET /templates/:id/notes, shown in
 *           the Review card), authored by a system user. Statuses are not changed.
 *
 * Templates of the curated library (library/avail) are never deleted or changed: if the file
 * names one, nothing is written at all and the report lists them (blocked). One transaction;
 * a second run changes nothing.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import deletedJson from "../../docs/avail/deleted-templates.json";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import type { BlockLevel } from "../../src/avail/blockLint";
import { levelsByVendor } from "./applyWorklist";
import { AVAIL_LIBRARY_SOURCE } from "./importAvail";
import { BUMP_LIBRARY_VERSION, relintAll, syncLintLevels } from "./templateMeta";

export interface VendorResponses {
  source?: string;
  delete: { id: string; vendor: string; model: string; reason: string }[];
  update: Record<string, { vendor: string; model: string; set?: Record<string, unknown>; note?: string }>;
}

export interface DeletedTemplatesFile {
  version: number;
  /** partNumber: also matched by vendor + part number (import:catalog removes such rows, step 1.9). */
  templates: { id: string; vendor: string; model: string; partNumber?: string; reason: string; source?: string }[];
}

export const DELETED_TEMPLATES = deletedJson as unknown as DeletedTemplatesFile;

/** Ids deleted from the library for good: import:upstream must not bring them back. */
export function deletedTemplateIds(file: DeletedTemplatesFile = DELETED_TEMPLATES): Set<string> {
  return new Set(file.templates.map((t) => t.id));
}

/** Template fields a vendor answer may set, with the type each must have. */
const FIELDS: Record<string, "number" | "string"> = {
  heightMm: "number",
  widthMm: "number",
  depthMm: "number",
  weightKg: "number",
  powerDrawW: "number",
  poeDrawW: "number",
  voltage: "string",
  referenceUrl: "string",
  modelNumber: "string",
};

/** Author of the notes written here: a users row nobody can sign in as (banned, .invalid address). */
export const VENDOR_NOTES_USER = { id: "avail-vendor-responses", email: "vendor-responses@avail.invalid", name: "Vendor responses" };
export const VENDOR_RESPONSES_SOURCE = "vendor-responses";

export interface VendorResponsesReport {
  dryRun: boolean;
  source: string;
  /** Curated templates named in the file: the run stopped, nothing written. */
  blocked: { id: string; model: string; action: "delete" | "update" }[];
  deleted: { id: string; vendor: string; model: string; reason: string }[];
  /** Delete entries whose template is not in this database (already deleted). */
  alreadyDeleted: number;
  /** Delete entries missing from docs/avail/deleted-templates.json (import:upstream would bring them back). */
  notInDeletedList: string[];
  updated: { id: string; vendor: string; model: string; fields: string[]; note: boolean }[];
  /** Update entries already as in the file. */
  unchanged: number;
  missingUpdates: string[];
  invalid: string[];
  statusesBefore: Record<string, number>;
  statusesAfter: Record<string, number>;
  levelsBefore: Record<string, Record<BlockLevel, number>>;
  levelsAfter: Record<string, Record<BlockLevel, number>>;
}

class DryRun extends Error {}

function statusCounts(sqlite: Database.Database): Record<string, number> {
  const rows = sqlite
    .prepare("SELECT COALESCE(m.status, 'raw') AS s, COUNT(*) AS n FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id GROUP BY 1")
    .all() as { s: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.s, r.n]));
}

function noteId(templateId: string, body: string): string {
  return `vendor-${createHash("sha256").update(`${templateId}\n${body}`).digest("hex").slice(0, 24)}`;
}

export function applyVendorResponses(
  sqlite: Database.Database,
  input: VendorResponses,
  options: { dryRun?: boolean; libraryIds?: Iterable<string>; deletedList?: DeletedTemplatesFile } = {},
): VendorResponsesReport {
  const curated = new Set(options.libraryIds ?? []);
  const listed = deletedTemplateIds(options.deletedList);
  const report: VendorResponsesReport = {
    dryRun: !!options.dryRun,
    source: input.source ?? "",
    blocked: [],
    deleted: [],
    alreadyDeleted: 0,
    notInDeletedList: input.delete.filter((d) => !listed.has(d.id)).map((d) => `${d.vendor} ${d.model} [${d.id}]`),
    updated: [],
    unchanged: 0,
    missingUpdates: [],
    invalid: [],
    statusesBefore: statusCounts(sqlite),
    statusesAfter: {},
    levelsBefore: levelsByVendor(sqlite),
    levelsAfter: {},
  };

  const getRow = sqlite.prepare("SELECT t.*, m.source AS avail_source FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id WHERE t.id = ?");
  type Row = TemplateRow & { avail_source: string | null };
  const isCurated = (r: Row | undefined, id: string) => curated.has(id) || r?.avail_source === AVAIL_LIBRARY_SOURCE;

  // Curated templates are never deleted or changed: stop before writing anything.
  for (const d of input.delete) if (isCurated(getRow.get(d.id) as Row | undefined, d.id)) report.blocked.push({ id: d.id, model: `${d.vendor} ${d.model}`, action: "delete" });
  for (const [id, u] of Object.entries(input.update)) if (isCurated(getRow.get(id) as Row | undefined, id)) report.blocked.push({ id, model: `${u.vendor} ${u.model}`, action: "update" });
  if (report.blocked.length) {
    report.statusesAfter = report.statusesBefore;
    report.levelsAfter = report.levelsBefore;
    return report;
  }

  const columns = Object.keys(templateToRow({ id: "x", label: "x", deviceType: "x", category: "", ports: [] })).filter((c) => c !== "id");
  const update = sqlite.prepare(
    `UPDATE templates SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, version = version + 1, updated_at = datetime('now') WHERE id = @id`,
  );
  const noteMeta = sqlite.prepare(
    `INSERT INTO avail_template_meta (template_id, status, updated_by, updated_at) VALUES (?, 'raw', '${VENDOR_RESPONSES_SOURCE}', datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  const delMeta = sqlite.prepare("DELETE FROM avail_template_meta WHERE template_id = ?");
  const delTemplate = sqlite.prepare("DELETE FROM templates WHERE id = ?");
  const hasNote = sqlite.prepare("SELECT 1 FROM template_notes WHERE id = ?");
  const addNote = sqlite.prepare("INSERT INTO template_notes (id, template_id, author_id, body) VALUES (?, ?, ?, ?)");

  const run = sqlite.transaction(() => {
    let changed = false;
    for (const d of input.delete) {
      if (!getRow.get(d.id)) {
        report.alreadyDeleted++;
        continue;
      }
      delMeta.run(d.id);
      delTemplate.run(d.id);
      report.deleted.push({ id: d.id, vendor: d.vendor, model: d.model, reason: d.reason });
      changed = true;
    }

    let userReady = false;
    for (const [id, u] of Object.entries(input.update)) {
      const row = getRow.get(id) as Row | undefined;
      if (!row) {
        report.missingUpdates.push(`${u.vendor} ${u.model} [${id}]`);
        continue;
      }
      const bad = Object.entries(u.set ?? {}).filter(([k, v]) => !FIELDS[k] || typeof v !== FIELDS[k] || (typeof v === "number" && !(v > 0)));
      if (bad.length) {
        report.invalid.push(`${u.vendor} ${u.model} [${id}]: ${bad.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}`);
        continue;
      }
      const t = rowToTemplate(row) as unknown as Record<string, unknown>;
      const fields = Object.entries(u.set ?? {}).filter(([k, v]) => t[k] !== v).map(([k]) => k);
      const body = u.note?.trim();
      const nid = body ? noteId(id, body) : "";
      const needNote = !!body && !hasNote.get(nid);
      if (!fields.length && !needNote) {
        report.unchanged++;
        continue;
      }
      if (fields.length) {
        const next = templateToRow({ ...(t as never as Parameters<typeof templateToRow>[0]), ...u.set, id, sortOrder: row.sort_order });
        update.run(next);
      }
      if (needNote) {
        if (!userReady) {
          sqlite
            .prepare("INSERT INTO users (id, email, name, role, banned) VALUES (?, ?, ?, 'contributor', 1) ON CONFLICT(id) DO NOTHING")
            .run(VENDOR_NOTES_USER.id, VENDOR_NOTES_USER.email, VENDOR_NOTES_USER.name);
          userReady = true;
        }
        addNote.run(nid, id, VENDOR_NOTES_USER.id, body);
      }
      noteMeta.run(id);
      report.updated.push({ id, vendor: u.vendor, model: u.model, fields, note: needNote });
      changed = true;
    }

    if (changed) sqlite.prepare(BUMP_LIBRARY_VERSION).run();
    // lint_level of every template (slot context may change with deletions), then the saved
    // ones as on any save (linted_version); statuses are compared before/after in the report.
    relintAll(sqlite);
    syncLintLevels(sqlite);
    report.statusesAfter = statusCounts(sqlite);
    report.levelsAfter = levelsByVendor(sqlite);
    if (options.dryRun) throw new DryRun();
  });
  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

export function formatVendorResponsesReport(r: VendorResponsesReport, file: string): string {
  const total = (m: Record<BlockLevel, number>) => `A ${m.A} / B ${m.B} / FIX ${m.FIX}`;
  const sum = (x: Record<string, Record<BlockLevel, number>>) =>
    Object.values(x).reduce((s, m) => ({ A: s.A + m.A, B: s.B + m.B, FIX: s.FIX + m.FIX }), { A: 0, B: 0, FIX: 0 });
  const head = `Vendor responses: ${file}${r.source ? ` (${r.source})` : ""}${r.dryRun ? " (dry run, nothing written)" : ""}`;
  if (r.blocked.length) {
    return [
      head,
      `STOPPED: the file names ${r.blocked.length} template(s) of the curated library (library/avail). Nothing was written.`,
      "Remove them from the file, or change the library file instead:",
      ...r.blocked.map((b) => `  ${b.action}: ${b.model} [${b.id}]`),
    ].join("\n") + "\n";
  }
  const byVendor = new Map<string, number>();
  for (const d of r.deleted) byVendor.set(d.vendor, (byVendor.get(d.vendor) ?? 0) + 1);
  const statuses = (m: Record<string, number>) => ["verified", "draft", "raw", "hidden"].map((s) => `${s} ${m[s] ?? 0}`).join(" / ");
  const vendors = [...new Set([...Object.keys(r.levelsBefore), ...Object.keys(r.levelsAfter)])].sort();
  const w = Math.max(10, ...vendors.map((v) => v.length));
  const lines = [
    head,
    `Deleted: ${r.deleted.length} (already gone: ${r.alreadyDeleted}); updated: ${r.updated.length} (already as in the file: ${r.unchanged}); notes added: ${r.updated.filter((u) => u.note).length}`,
    `Statuses: ${statuses(r.statusesBefore)} → ${statuses(r.statusesAfter)}`,
    "",
    "Deleted by vendor:",
    ...([...byVendor].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => `  ${v.padEnd(w)}  ${n}`)),
    ...(byVendor.size ? [] : ["  -"]),
    "",
    `Levels by vendor (our vendors):  before → after`,
    ...vendors.map((v) => `  ${v.padEnd(w)}  ${total(r.levelsBefore[v] ?? { A: 0, B: 0, FIX: 0 }).padEnd(26)} → ${total(r.levelsAfter[v] ?? { A: 0, B: 0, FIX: 0 })}`),
    `  ${"Total".padEnd(w)}  ${total(sum(r.levelsBefore)).padEnd(26)} → ${total(sum(r.levelsAfter))}`,
    "",
    "Updated:",
    ...(r.updated.length ? r.updated.map((u) => `  ${u.vendor} ${u.model} [${u.id}]: ${[...u.fields, ...(u.note ? ["note"] : [])].join(", ")}`) : ["  -"]),
    "",
    "Deleted:",
    ...(r.deleted.length ? r.deleted.map((d) => `  ${d.vendor} ${d.model} [${d.id}]: ${d.reason}`) : ["  -"]),
  ];
  if (r.invalid.length) lines.push("", "Not applied (field or value not accepted):", ...r.invalid.map((x) => `  ${x}`));
  if (r.missingUpdates.length) lines.push("", "Updates for templates not in this database:", ...r.missingUpdates.map((x) => `  ${x}`));
  if (r.notInDeletedList.length) lines.push("", "WARNING: deleted but not in docs/avail/deleted-templates.json (import:upstream would bring them back):", ...r.notInDeletedList.map((x) => `  ${x}`));
  return lines.join("\n") + "\n";
}
