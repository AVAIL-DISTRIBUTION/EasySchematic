/**
 * End-to-end: the real upstream Hono app from api/src, served over HTTP by
 * @hono/node-server, on a fresh DATA_DIR.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { listMigrations } from "../src/migrate";
import { bundledTemplateRows } from "../src/seed";

const ADMIN_TOKEN = "test-admin-token-0123456789";
let dataDir: string;
let api: ApiServer;
let server: ReturnType<typeof serve>;
let base: string;
const logs: string[] = [];

function config(extra: Record<string, string> = {}) {
  return {
    ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN, GOOGLE_CLIENT_ID: "client-id", ...extra }),
    log: (m: string) => logs.push(m),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-smoke-"));
  api = createApiServer(config({ API_PUBLIC_URL: "https://api.avail.test/" }));
  await new Promise<void>((resolve) => {
    server = serve({ fetch: (req) => api.fetch(req), port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function sessionCookie(email = "eng@avail.test"): Promise<string> {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  api.db.sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(userId, email);
  api.db.sqlite
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .run(sessionId, userId);
  return `session=${sessionId}`;
}

describe("api-avail smoke", () => {
  it("applied every migration on a fresh database: upstream's, then ours (9xxx)", () => {
    const ours = listMigrations(path.resolve(__dirname, "../migrations"));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((f) => f.startsWith("9"))).toBe(true);
    const expected = [...listMigrations(path.resolve(__dirname, "../../api/migrations")), ...ours];
    expect(api.migrations.applied).toEqual(expected);
    const rows = api.db.sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(expected);
  });

  it("seeded the bundled library", () => {
    expect(api.seed.seeded).toBe(bundledTemplateRows().length);
    expect(api.seed.seeded).toBeGreaterThan(100);
  });

  it("GET /health answers", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /templates returns the seeded templates, with a working ETag", async () => {
    const res = await fetch(`${base}/templates`);
    expect(res.status).toBe(200);
    const templates = (await res.json()) as { id: string; label: string; ports: unknown[] }[];
    expect(templates.length).toBe(api.seed.seeded);
    expect(templates[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
    expect(Array.isArray(templates[0].ports)).toBe(true);

    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await fetch(`${base}/templates`, { headers: { "If-None-Match": etag! } });
    expect(again.status).toBe(304);
  });

  it("GET /templates/summary works", async () => {
    const res = await fetch(`${base}/templates/summary`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(api.seed.seeded);
  });

  it("saves, lists, reads, updates and deletes a schematic (D1 row + R2 object)", async () => {
    const cookie = await sessionCookie();
    const doc = { name: "Переговорная 1", version: 1, nodes: [{ id: "n1" }], edges: [] };

    const created = await fetch(`${base}/schematics`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string; name: string };
    expect(row.name).toBe(doc.name);
    expect(readdirSync(path.join(dataDir, "r2", "objects"))).toContain(encodeURIComponent(`schematics/${row.id}.json`).replace(/\./g, "%2E"));

    const list = await fetch(`${base}/schematics`, { headers: { Cookie: cookie } });
    expect(((await list.json()) as { id: string }[]).map((s) => s.id)).toEqual([row.id]);

    const read = await fetch(`${base}/schematics/${row.id}`, { headers: { Cookie: cookie } });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toContain("application/json");
    expect(await read.json()).toEqual(doc);

    const updatedDoc = { ...doc, name: "Переговорная 1 (v2)" };
    const put = await fetch(`${base}/schematics/${row.id}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(updatedDoc),
    });
    expect(put.status).toBe(200);
    expect(await (await fetch(`${base}/schematics/${row.id}`, { headers: { Cookie: cookie } })).json()).toEqual(updatedDoc);

    const del = await fetch(`${base}/schematics/${row.id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(204);
    expect(await api.bucket.get(`schematics/${row.id}.json`)).toBeNull();
  });

  it("another user can't read someone else's schematic", async () => {
    const owner = await sessionCookie("owner@avail.test");
    const other = await sessionCookie("other@avail.test");
    const created = await fetch(`${base}/schematics`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "private", version: 1, nodes: [], edges: [] }),
    });
    const { id } = (await created.json()) as { id: string };
    expect((await fetch(`${base}/schematics/${id}`, { headers: { Cookie: other } })).status).toBe(404);
  });

  it("anonymous requests to schematics are rejected", async () => {
    expect((await fetch(`${base}/schematics`)).status).toBe(401);
  });

  it("Google sign-in uses API_PUBLIC_URL for redirect_uri", async () => {
    const res = await fetch(`${base}/auth/google/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.hostname).toBe("accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe("https://api.avail.test/auth/google/callback");
    expect(location.searchParams.get("client_id")).toBe("client-id");
  });

  it("restart on the same DATA_DIR applies nothing and doesn't reseed", () => {
    const again = createApiServer(config());
    try {
      expect(again.migrations.applied).toEqual([]);
      expect(again.seed.seeded).toBe(0);
    } finally {
      again.close();
    }
  });

  it("refuses to start without a real ADMIN_TOKEN", () => {
    expect(() => createApiServer({ ...config(), vars: { ...config().vars, ADMIN_TOKEN: "" } })).toThrow(/ADMIN_TOKEN/);
  });
});
