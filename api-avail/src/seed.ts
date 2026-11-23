/**
 * Seeds the templates table from the device library bundled in the repo
 * (src/deviceLibrary.ts), the same source api/seed/seed.ts uses — but in-process,
 * without wrangler and without contacting easyschematic.live.
 *
 * Rows are built with api/src/db.ts templateToRow(), the mapping the API itself uses
 * for writes, so the seeded rows have exactly the shape the routes read back.
 *
 * Modes (SEED_LIBRARY):
 *   if-empty (default) — seed only when the templates table has no rows;
 *   always             — upsert every bundled template on each start
 *                        (ON CONFLICT DO UPDATE, never INSERT OR REPLACE: REPLACE deletes
 *                        the row first and would fire ON DELETE CASCADE on template_notes);
 *   off                — never seed.
 */
import type Database from "better-sqlite3";
import { DEVICE_TEMPLATES, CARD_TEMPLATES } from "../../src/deviceLibrary";
import { templateToRow } from "../../api/src/db";

export type SeedMode = "if-empty" | "always" | "off";

export interface SeedResult {
  mode: SeedMode;
  seeded: number;
}

export function parseSeedMode(value: string | undefined): SeedMode {
  const v = (value ?? "if-empty").trim().toLowerCase();
  if (v === "if-empty" || v === "always" || v === "off") return v;
  throw new Error(`SEED_LIBRARY must be one of if-empty | always | off (got "${value}")`);
}

export function bundledTemplateRows(): Record<string, string | number | null>[] {
  const all = [...DEVICE_TEMPLATES, ...CARD_TEMPLATES];
  return all.map((t, i) => {
    const row = templateToRow({ ...(t as Parameters<typeof templateToRow>[0]), id: t.id ?? `auto-${i}`, sortOrder: i });
    return { ...row, version: t.version ?? 1 } as Record<string, string | number | null>;
  });
}

export function seedLibrary(sqlite: Database.Database, mode: SeedMode): SeedResult {
  if (mode === "off") return { mode, seeded: 0 };
  if (mode === "if-empty") {
    const { n } = sqlite.prepare("SELECT COUNT(*) AS n FROM templates").get() as { n: number };
    if (n > 0) return { mode, seeded: 0 };
  }

  const rows = bundledTemplateRows();
  if (rows.length === 0) return { mode, seeded: 0 };
  const columns = Object.keys(rows[0]);
  const updates = columns.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
  const stmt = sqlite.prepare(
    `INSERT INTO templates (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}, updated_at = datetime('now')`,
  );
  sqlite.transaction(() => {
    for (const row of rows) stmt.run(row);
    // Roll the library ETag so clients holding a cached copy refetch.
    sqlite.prepare("UPDATE library_meta SET version = version + 1 WHERE id = 1").run();
  })();
  return { mode, seeded: rows.length };
}
