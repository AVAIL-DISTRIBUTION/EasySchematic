/**
 * MAX_SCHEMATICS_PER_USER: per-user cap on saved schematics. 0 = no limit,
 * unset or invalid = upstream's 10.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const dirs: string[] = [];
const servers: ApiServer[] = [];

function makeServer(env: Record<string, string> = {}): ApiServer {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-limits-"));
  dirs.push(dataDir);
  const api = createApiServer({
    ...configFromEnv({
      DATA_DIR: dataDir,
      ADMIN_TOKEN: "test-admin-token-0123456789",
      SEED_LIBRARY: "off",
      ...env,
    }),
    log: () => {},
  });
  servers.push(api);
  return api;
}

afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A signed-in user who already owns `existing` schematics (rows inserted directly, past the save rate limit). */
function userWith(api: ApiServer, existing: number): string {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(userId, `${userId}@avail.test`);
  api.db.sqlite
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .run(sessionId, userId);
  const insert = api.db.sqlite.prepare("INSERT INTO schematics (id, user_id, name) VALUES (?, ?, ?)");
  for (let i = 0; i < existing; i++) insert.run(crypto.randomUUID(), userId, `s${i}`);
  return `session=${sessionId}`;
}

function save(api: ApiServer, cookie: string): Promise<Response> {
  return api.fetch(
    new Request("http://api.internal/schematics", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Переговорная", version: 1, nodes: [], edges: [] }),
    }),
  );
}

describe("MAX_SCHEMATICS_PER_USER", () => {
  it("unset: upstream limit of 10", async () => {
    const api = makeServer();
    expect((await save(api, userWith(api, 9))).status).toBe(201);
    const full = await save(api, userWith(api, 10));
    expect(full.status).toBe(400);
    expect(((await full.json()) as { error: string }).error).toContain("Maximum 10 schematics");
  });

  it("0: no limit", async () => {
    const api = makeServer({ MAX_SCHEMATICS_PER_USER: "0" });
    expect((await save(api, userWith(api, 250))).status).toBe(201);
  });

  it("a number sets the limit", async () => {
    const api = makeServer({ MAX_SCHEMATICS_PER_USER: "3" });
    expect((await save(api, userWith(api, 2))).status).toBe(201);
    const full = await save(api, userWith(api, 3));
    expect(full.status).toBe(400);
    expect(((await full.json()) as { error: string }).error).toContain("Maximum 3 schematics");
  });

  it("invalid value falls back to upstream's 10", async () => {
    for (const value of ["abc", "-1", "2.5", ""]) {
      const api = makeServer({ MAX_SCHEMATICS_PER_USER: value });
      expect((await save(api, userWith(api, 9))).status, value).toBe(201);
      expect((await save(api, userWith(api, 10))).status, value).toBe(400);
    }
  });
});
