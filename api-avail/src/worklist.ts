/**
 * export:worklist — the manual work on our vendors' templates as a CSV for engineers: every
 * template of a vendor in avail-vendors.json at level B or FIX (not hidden), with vendor, model,
 * part number, level, status and the top 3 issues (errors first), sorted by vendor, then FIX before
 * B, then model. Levels are computed against the whole library (slots and cards).
 */
import type Database from "better-sqlite3";
import { rowToTemplate, type TemplateRow } from "../../api/src/db";
import { lintBlock, type BlockLevel } from "../../src/avail/blockLint";
import { findVendor } from "../../src/avail/library";
import { slotContext } from "./templateMeta";

export interface WorklistRow {
  vendor: string;
  model: string;
  partNumber: string;
  deviceType: string;
  category: string;
  level: BlockLevel;
  status: string;
  errors: number;
  warnings: number;
  issue1: string;
  issue2: string;
  issue3: string;
  templateId: string;
}

const LEVEL_ORDER: Record<BlockLevel, number> = { FIX: 0, B: 1, A: 2 };

export function buildWorklist(sqlite: Database.Database): WorklistRow[] {
  const ctx = slotContext(sqlite);
  const rows = sqlite
    .prepare(
      `SELECT t.*, COALESCE(m.status, 'raw') AS avail_status FROM templates t
         LEFT JOIN avail_template_meta m ON m.template_id = t.id
        WHERE t.flagged_for_deletion = 0 AND COALESCE(m.status, 'raw') <> 'hidden'`,
    )
    .all() as (TemplateRow & { avail_status: string })[];
  const out: WorklistRow[] = [];
  for (const r of rows) {
    const vendor = findVendor(r.manufacturer)?.name;
    if (!vendor) continue;
    const lint = lintBlock(rowToTemplate(r), ctx);
    if (lint.level === "A") continue;
    const issues = [...lint.errors.map((m) => `E ${m}`), ...lint.warnings.map((m) => `W ${m}`)];
    out.push({
      vendor,
      model: r.label,
      partNumber: r.model_number ?? "",
      deviceType: r.device_type,
      category: r.category ?? "",
      level: lint.level,
      status: r.avail_status,
      errors: lint.errors.length,
      warnings: lint.warnings.length,
      issue1: issues[0] ?? "",
      issue2: issues[1] ?? "",
      issue3: issues[2] ?? "",
      templateId: r.id,
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.model.localeCompare(b.model));
}

const COLUMNS: [keyof WorklistRow, string][] = [
  ["vendor", "Vendor"], ["model", "Model"], ["partNumber", "Part number"], ["deviceType", "Device type"], ["category", "Category"],
  ["level", "Level"], ["status", "Status"], ["errors", "E"], ["warnings", "W"],
  ["issue1", "Issue 1"], ["issue2", "Issue 2"], ["issue3", "Issue 3"], ["templateId", "Template id"],
];

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with a header row; starts with a BOM so Excel reads UTF-8. */
export function worklistCsv(rows: WorklistRow[]): string {
  const lines = [COLUMNS.map(([, h]) => h).join(","), ...rows.map((r) => COLUMNS.map(([k]) => csvCell(r[k])).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
