/**
 * D1 shim over better-sqlite3.
 *
 * Implements the subset of the Cloudflare D1 binding API that api/src uses
 * (prepare/bind/first/all/run/raw, batch, exec), with D1's semantics where
 * they differ from better-sqlite3:
 *  - every call is async (returns a Promise), like the real binding;
 *  - bind() returns a new statement, the original stays reusable;
 *  - booleans bind as 1/0, `undefined` is rejected (D1 throws D1_TYPE_ERROR);
 *  - run() on a SELECT and all() on a write both work (better-sqlite3 throws);
 *  - first(column) returns that column's value, or throws if it's absent;
 *  - BLOB columns come back as number[] (D1's JSON wire format), not Buffer;
 *  - batch() runs in one transaction and rolls back as a whole on error.
 *
 * Not implemented (unused by api/src): dump(), withSession() bookmarks.
 */
import Database from "better-sqlite3";

export type D1Value = string | number | bigint | boolean | null | ArrayBuffer | ArrayBufferView;

export interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  rows_read: number;
  rows_written: number;
  size_after: number;
  served_by: string;
}

export interface D1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: D1Meta;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

type SqliteParam = string | number | bigint | Buffer | null;

function toSqlite(value: D1Value | undefined, index: number): SqliteParam {
  if (value === undefined) {
    throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value at index ${index}`);
}

function fromSqlite(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (Buffer.isBuffer(v)) row[key] = Array.from(v);
  }
  return row;
}

function fromSqliteArray(row: unknown[]): unknown[] {
  return row.map((v) => (Buffer.isBuffer(v) ? Array.from(v) : v));
}

export class D1PreparedStatementShim {
  constructor(
    private readonly db: D1DatabaseShim,
    readonly sql: string,
    private readonly params: SqliteParam[] = [],
  ) {}

  bind(...values: D1Value[]): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.db, this.sql, values.map(toSqlite));
  }

  /** Synchronous execution, shared by the async API and batch(). */
  execute<T = Record<string, unknown>>(): D1Result<T> {
    const started = performance.now();
    const stmt = this.db.sqlite.prepare(this.sql);
    let results: T[] = [];
    let changes = 0;
    let lastRowId = 0;
    if (stmt.reader) {
      results = (stmt.all(...this.params) as Record<string, unknown>[]).map(fromSqlite) as T[];
      // A write with RETURNING is a reader too; sqlite3_changes() still reports it.
      if (!/^\s*(select|with|pragma|explain)\b/i.test(this.sql)) {
        const info = this.db.sqlite
          .prepare("SELECT changes() AS c, last_insert_rowid() AS r")
          .get() as { c: number; r: number };
        changes = info.c;
        lastRowId = info.r;
      }
    } else {
      const info = stmt.run(...this.params);
      changes = info.changes;
      lastRowId = Number(info.lastInsertRowid);
    }
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        rows_read: stmt.reader ? results.length : 0,
        rows_written: changes,
        size_after: 0,
        served_by: "avail-d1-shim",
      },
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const stmt = this.db.sqlite.prepare(this.sql);
    if (!stmt.reader) {
      stmt.run(...this.params);
      return null;
    }
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    fromSqlite(row);
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.sqlite.prepare(this.sql);
    if (!stmt.reader) {
      stmt.run(...this.params);
      return options?.columnNames ? ([[]] as T[]) : [];
    }
    const rows = (stmt.raw(true).all(...this.params) as unknown[][]).map(fromSqliteArray);
    if (options?.columnNames) {
      return [stmt.columns().map((c) => c.name), ...rows] as T[];
    }
    return rows as T[];
  }
}

export class D1DatabaseShim {
  readonly sqlite: Database.Database;

  constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    // D1 enforces foreign keys and there is no way to turn that off per connection.
    this.sqlite.pragma("foreign_keys = ON");
  }

  prepare(sql: string): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementShim[]): Promise<D1Result<T>[]> {
    return this.sqlite.transaction(() => statements.map((s) => s.execute<T>()))();
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const started = performance.now();
    this.sqlite.exec(sql);
    // D1 counts executed queries; a split on statement terminators is close enough here.
    const count = sql.split(";").filter((s) => s.trim().length > 0).length;
    return { count, duration: performance.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("D1 shim: dump() is not supported; back up the SQLite file instead");
  }

  close(): void {
    this.sqlite.close();
  }
}
