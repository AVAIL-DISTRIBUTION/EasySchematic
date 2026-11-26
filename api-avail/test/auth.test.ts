/**
 * Self-hosting auth knobs added to api/src: ALLOWED_ORIGINS (CORS + returnTo),
 * GOOGLE_ALLOWED_DOMAIN (hd claim) and DISABLE_MAGIC_LINK. Each is checked both
 * when set and when unset (upstream behaviour must not change).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

const OURS = "https://sch.avail-int.com";
const API = "https://sch.avail-int.com/api";
const dirs: string[] = [];
const servers: ApiServer[] = [];

function makeServer(env: Record<string, string> = {}): ApiServer {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-auth-"));
  dirs.push(dataDir);
  const api = createApiServer({
    ...configFromEnv({
      DATA_DIR: dataDir,
      ADMIN_TOKEN: "test-admin-token-0123456789",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
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

const req = (api: ApiServer, p: string, init?: RequestInit) => api.fetch(new Request(`http://api.internal${p}`, init));

// ---------------------------------------------------------------- CORS / returnTo

describe("ALLOWED_ORIGINS", () => {
  const ours = makeServer({ ALLOWED_ORIGINS: `${OURS}, http://localhost:5173/` });
  const upstream = makeServer();

  it("echoes a listed origin with credentials", async () => {
    const res = await req(ours, "/auth/me", { headers: { Origin: OURS } });
    expect(res.headers.get("access-control-allow-origin")).toBe(OURS);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("trims spaces and trailing slashes in the list", async () => {
    const res = await req(ours, "/auth/me", { headers: { Origin: "http://localhost:5173" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("answers a credentialed preflight for a listed origin", async () => {
    const res = await req(ours, "/schematics", {
      method: "OPTIONS",
      headers: { Origin: OURS, "Access-Control-Request-Method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(OURS);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("replaces the defaults: official hosts and unlisted loopback are refused", async () => {
    for (const origin of ["https://easyschematic.live", "http://localhost:3000", "https://evil.example"]) {
      const res = await req(ours, "/auth/me", { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });

  it("unset: upstream behaviour (official hosts and loopback yes, ours no)", async () => {
    const official = await req(upstream, "/auth/me", { headers: { Origin: "https://easyschematic.live" } });
    expect(official.headers.get("access-control-allow-origin")).toBe("https://easyschematic.live");
    const loopback = await req(upstream, "/auth/me", { headers: { Origin: "http://localhost:3000" } });
    expect(loopback.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const mine = await req(upstream, "/auth/me", { headers: { Origin: OURS } });
    expect(mine.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("the library (GET /templates, served by our status-filtered route) is not open to any origin", async () => {
    const evil = await req(ours, "/templates/summary", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const mine = await req(ours, "/templates/summary", { headers: { Origin: OURS } });
    expect(mine.headers.get("access-control-allow-origin")).toBe(OURS);
    // Other public reads keep upstream's open CORS.
    const cats = await req(ours, "/templates/categories", { headers: { Origin: "https://evil.example" } });
    expect(cats.headers.get("access-control-allow-origin")).toBe("*");
  });

  async function storedReturnTo(api: ApiServer, returnTo: string): Promise<string | null> {
    const res = await req(api, `/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    const state = new URL(res.headers.get("location")!).searchParams.get("state");
    const row = api.db.sqlite.prepare("SELECT return_to FROM oauth_states WHERE id = ?").get(state) as { return_to: string | null };
    return row.return_to;
  }

  it("keeps a returnTo on a listed origin and drops others", async () => {
    expect(await storedReturnTo(ours, `${OURS}/?project=1`)).toBe(`${OURS}/?project=1`);
    expect(await storedReturnTo(ours, "https://easyschematic.live/")).toBeNull();
    expect(await storedReturnTo(upstream, `${OURS}/`)).toBeNull();
    expect(await storedReturnTo(upstream, "https://easyschematic.live/")).toBe("https://easyschematic.live/");
  });
});

// ---------------------------------------------------------------- Google hd

/** Fake Google token endpoint: answers with an id_token carrying the given claims. */
function mockGoogle(claims: Record<string, unknown>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const b64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return Response.json({ id_token: `header.${b64}.signature` });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

async function googleLogin(api: ApiServer, claims: Record<string, unknown>) {
  restore = mockGoogle({ sub: `sub-${claims.email}`, email_verified: true, name: "Test", ...claims });
  const start = await req(api, `/auth/google/start?returnTo=${encodeURIComponent(`${OURS}/`)}`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return req(api, `/auth/google/callback?code=abc&state=${state}`);
}

// People only: the AI Assistant service account (migration 9010) is always there.
const userCount = (api: ApiServer) => (api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email NOT LIKE '%.invalid'").get() as { n: number }).n;

describe("GOOGLE_ALLOWED_DOMAIN", () => {
  const env = { ALLOWED_ORIGINS: OURS, API_PUBLIC_URL: API, GOOGLE_ALLOWED_DOMAIN: "avail-int.com", DISABLE_MAGIC_LINK: "1" };

  it("lets a verified account from the domain in", async () => {
    const api = makeServer(env);
    const res = await googleLogin(api, { email: "eng@avail-int.com", hd: "avail-int.com" });
    expect(res.status).toBe(200); // cookieRedirect page
    expect(res.headers.get("set-cookie")).toMatch(/^session=[^;]+;/);
    expect(await res.text()).toContain(`${OURS}/`);
    expect(userCount(api)).toBe(1);
  });

  it("matches hd case-insensitively", async () => {
    const api = makeServer(env);
    const res = await googleLogin(api, { email: "eng@avail-int.com", hd: "AVAIL-INT.com" });
    expect(res.status).toBe(200);
  });

  it.each([
    ["another Workspace domain", { email: "x@other.com", hd: "other.com" }],
    ["a consumer account (no hd)", { email: "someone@gmail.com" }],
    ["a look-alike email without hd", { email: "eng@avail-int.com" }],
  ])("refuses %s with domain_not_allowed and creates no user", async (_label, claims) => {
    const api = makeServer(env);
    const res = await googleLogin(api, claims);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${OURS}/?error=domain_not_allowed`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(userCount(api)).toBe(0);
  });

  it("refuses an unverified email even on the right domain", async () => {
    const api = makeServer(env);
    const res = await googleLogin(api, { email: "eng@avail-int.com", hd: "avail-int.com", email_verified: false });
    expect(res.headers.get("location")).toBe(`${OURS}/?error=email_not_verified`);
    expect(userCount(api)).toBe(0);
  });

  it("asks Google to pre-select the domain and uses API_PUBLIC_URL for redirect_uri", async () => {
    const api = makeServer(env);
    const loc = new URL((await req(api, "/auth/google/start")).headers.get("location")!);
    expect(loc.searchParams.get("hd")).toBe("avail-int.com");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${API}/auth/google/callback`);
  });

  it("unset: any verified Google account signs in, no hd hint (upstream)", async () => {
    const api = makeServer({ ALLOWED_ORIGINS: OURS });
    const res = await googleLogin(api, { email: "someone@gmail.com" });
    expect(res.status).toBe(200);
    expect(userCount(api)).toBe(1);
    const loc = new URL((await req(api, "/auth/google/start")).headers.get("location")!);
    expect(loc.searchParams.has("hd")).toBe(false);
  });
});

// ---------------------------------------------------------------- magic link

describe("DISABLE_MAGIC_LINK", () => {
  const off = makeServer({ DISABLE_MAGIC_LINK: "1" });
  const on = makeServer();
  const login = (api: ApiServer) =>
    req(api, "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@avail-int.com" }),
    });

  it("answers 403 on every email sign-in endpoint", async () => {
    const responses = [
      await login(off),
      await req(off, "/auth/verify?token=x"),
      await req(off, "/auth/verify", { method: "POST", body: new URLSearchParams({ token: "x" }) }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/Google/);
    }
    expect((off.db.sqlite.prepare("SELECT COUNT(*) AS n FROM magic_links").get() as { n: number }).n).toBe(0);
  });

  it("leaves Google sign-in working", async () => {
    expect((await req(off, "/auth/google/start")).status).toBe(302);
  });

  it("unset: email sign-in works as upstream (link stored, mail stubbed)", async () => {
    const res = await login(on);
    expect(res.status).toBe(200);
    expect((on.db.sqlite.prepare("SELECT COUNT(*) AS n FROM magic_links").get() as { n: number }).n).toBe(1);
  });
});
