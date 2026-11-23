import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1DatabaseShim } from "../src/d1";

let db: D1DatabaseShim;

beforeEach(async () => {
  db = new D1DatabaseShim(":memory:");
  await db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, n INTEGER, flag INTEGER, data BLOB);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id));
  `);
});
afterEach(() => db.close());

describe("D1 shim: prepared statements", () => {
  it("bind() returns a new statement and leaves the original reusable", async () => {
    const base = db.prepare("INSERT INTO users (id, email) VALUES (?, ?)");
    await base.bind("a", "a@x").run();
    await base.bind("b", "b@x").run();
    const { results } = await db.prepare("SELECT id FROM users ORDER BY id").all();
    expect(results).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("first() returns the row, null when empty, and a column value when named", async () => {
    await db.prepare("INSERT INTO users (id, email, n) VALUES (?, ?, ?)").bind("a", "a@x", 7).run();
    expect(await db.prepare("SELECT id, n FROM users WHERE id = ?").bind("a").first()).toEqual({ id: "a", n: 7 });
    expect(await db.prepare("SELECT id FROM users WHERE id = ?").bind("zzz").first()).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS cnt FROM users").first("cnt")).toBe(1);
    await expect(db.prepare("SELECT id FROM users").first("nope")).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
  });

  it("run() reports changes and last_row_id", async () => {
    await db.prepare("INSERT INTO users (id, email) VALUES ('u', 'u@x')").run();
    const ins = await db.prepare("INSERT INTO posts (user_id) VALUES (?)").bind("u").run();
    expect(ins.success).toBe(true);
    expect(ins.meta.changes).toBe(1);
    expect(ins.meta.last_row_id).toBe(1);
    const upd = await db.prepare("UPDATE users SET n = 1 WHERE id = ?").bind("missing").run();
    expect(upd.meta.changes).toBe(0);
  });

  it("all() on a write and run() on a read both work, as in D1", async () => {
    const w = await db.prepare("INSERT INTO users (id, email) VALUES ('a', 'a@x')").all();
    expect(w.results).toEqual([]);
    expect(w.meta.changes).toBe(1);
    const r = await db.prepare("SELECT id FROM users").run();
    expect(r.results).toEqual([{ id: "a" }]);
  });

  it("RETURNING yields rows and still counts changes", async () => {
    const r = await db.prepare("INSERT INTO users (id, email) VALUES ('a', 'a@x') RETURNING id").all();
    expect(r.results).toEqual([{ id: "a" }]);
    expect(r.meta.changes).toBe(1);
  });

  it("raw() returns arrays, optionally with column names first", async () => {
    await db.prepare("INSERT INTO users (id, email, n) VALUES ('a', 'a@x', 1)").run();
    expect(await db.prepare("SELECT id, n FROM users").raw()).toEqual([["a", 1]]);
    expect(await db.prepare("SELECT id, n FROM users").raw({ columnNames: true })).toEqual([["id", "n"], ["a", 1]]);
  });

  it("converts booleans to 1/0, blobs to number[], and rejects undefined", async () => {
    await db.prepare("INSERT INTO users (id, email, flag, data) VALUES (?, ?, ?, ?)")
      .bind("a", "a@x", true, new Uint8Array([1, 2, 3]))
      .run();
    expect(await db.prepare("SELECT flag, data FROM users").first()).toEqual({ flag: 1, data: [1, 2, 3] });
    expect(() => db.prepare("SELECT ?").bind(undefined as never)).toThrow(/D1_TYPE_ERROR/);
  });

  it("enforces foreign keys like D1", async () => {
    await expect(db.prepare("INSERT INTO posts (user_id) VALUES ('ghost')").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("supports sqlite functions api/src relies on (datetime, json)", async () => {
    const row = await db.prepare("SELECT datetime('now') > '2000' AS ok, json_extract('{\"a\":2}', '$.a') AS a").first();
    expect(row).toEqual({ ok: 1, a: 2 });
  });
});

describe("D1 shim: batch and exec", () => {
  it("batch() runs all statements and returns one result each", async () => {
    const results = await db.batch([
      db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("a", "a@x"),
      db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("b", "b@x"),
      db.prepare("SELECT COUNT(*) AS c FROM users"),
    ]);
    expect(results).toHaveLength(3);
    expect(results[2].results).toEqual([{ c: 2 }]);
  });

  it("batch() is atomic: a failing statement rolls back the earlier ones", async () => {
    await expect(
      db.batch([
        db.prepare("INSERT INTO users (id, email) VALUES ('a', 'a@x')"),
        db.prepare("INSERT INTO users (id, email) VALUES ('b', 'a@x')"), // UNIQUE violation
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.prepare("SELECT COUNT(*) AS c FROM users").first("c")).toBe(0);
  });

  it("exec() runs multiple statements and counts them", async () => {
    const r = await db.exec("INSERT INTO users (id, email) VALUES ('a','a@x'); INSERT INTO users (id, email) VALUES ('b','b@x');");
    expect(r.count).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) AS c FROM users").first("c")).toBe(2);
  });
});
