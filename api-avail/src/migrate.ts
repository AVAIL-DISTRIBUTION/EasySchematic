/**
 * Applies api/migrations/*.sql in filename order, each once.
 *
 * Bookkeeping uses the same `d1_migrations` table wrangler keeps, so a database
 * exported from D1 (`wrangler d1 export`) can be dropped in and continue from where
 * production was.
 *
 * Each migration runs in its own transaction with foreign keys off, then
 * `PRAGMA foreign_key_check` must come back clean before it commits — the standard
 * SQLite recipe for table rebuilds (see 0027), where DROP TABLE under enforced FKs
 * would otherwise cascade or fail.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

export function listMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
}

export function applyMigrations(sqlite: Database.Database, dir: string, log: (msg: string) => void = () => {}): MigrationResult {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);

  const done = new Set(
    (sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const pending = listMigrations(dir).filter((f) => !done.has(f));
  if (pending.length === 0) return { applied: [], skipped: done.size };

  const fkWasOn = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  sqlite.pragma("foreign_keys = OFF");
  try {
    for (const file of pending) {
      const sql = readFileSync(path.join(dir, file), "utf-8");
      sqlite.transaction(() => {
        sqlite.exec(sql);
        const violations = sqlite.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(`Migration ${file} left ${violations.length} foreign key violation(s)`);
        }
        sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
      })();
      log(`migration applied: ${file}`);
    }
  } finally {
    if (fkWasOn) sqlite.pragma("foreign_keys = ON");
  }
  return { applied: pending, skipped: done.size };
}
