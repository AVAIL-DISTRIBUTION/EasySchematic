/**
 * Builds the Workers-style `env` for the unmodified Hono app in api/src and wraps
 * its fetch handler for Node. main.ts listens; tests call createApiServer() directly.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import upstream, { app as upstreamApp } from "../../api/src/index";
import { D1DatabaseShim } from "./d1";
import { R2BucketShim } from "./r2";
import { applyMigrations, type MigrationResult } from "./migrate";
import { parseSeedMode, seedLibrary, type SeedResult } from "./seed";
import { installMailStub } from "./mail";
import { registerAvailRoutes } from "./routes";
import { auditsTemplates, beginTemplateAudit, endTemplateAudit, proposalAuditEntry, readProposalDecision, refuseDisabledSignIn, resolveActor, userRouteRewrite, type ProposalDecision } from "./requestAudit";
import { requestContext, writeAudit } from "./audit";
import { registerUserRoutes } from "./users";
import { duplicateConflict } from "./duplicateGuard";
import { CONFLICT_PATH, pendingConflicts, registerDuplicateRoutes } from "./duplicates";
import { registerNotDuplicateRoutes } from "./notDuplicates";
import { beginProposalOverrides, endProposalOverrides, registerOverrideRoutes, type ProposalOverrideScope } from "./overrides";
import { logTokenRequest, pendingRefusals, rateLimitFromEnv, REFUSAL_PATH, registerAccessTokenRoutes, resolveAccessToken, TokenRateLimiter } from "./accessTokens";
import { registerAssistantRoutes } from "./assistant";
import { handleMcp, MCP_PATH, mcpUnauthorized } from "./mcp";
import { relintAll, syncLintLevels } from "./templateMeta";

const here = path.dirname(fileURLToPath(import.meta.url));

// Our routes (/avail/...) join the upstream app once, before it serves any request
// (Hono builds its router on the first match and refuses new routes after that).
registerAvailRoutes(upstreamApp);
registerUserRoutes(upstreamApp);
registerDuplicateRoutes(upstreamApp);
registerNotDuplicateRoutes(upstreamApp);
registerAccessTokenRoutes(upstreamApp);
registerAssistantRoutes(upstreamApp);
registerOverrideRoutes(upstreamApp);

export interface ApiConfig {
  dataDir: string;
  migrationsDir: string;
  /** Our migrations (api-avail/migrations, 9xxx), applied after upstream's. */
  availMigrationsDir: string;
  seedMode: string | undefined;
  /** Requests a minute per AI Assistant access token (AI_TOKEN_RATE_LIMIT, default 120). */
  tokenRateLimit?: number;
  /** Secrets and settings handed to the app as Workers bindings. */
  vars: {
    ADMIN_TOKEN: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    SUPPORT_FORWARD_EMAIL: string;
    API_PUBLIC_URL: string;
    ALLOWED_ORIGINS: string;
    GOOGLE_ALLOWED_DOMAIN: string;
    DISABLE_MAGIC_LINK: string;
    MAX_SCHEMATICS_PER_USER: string;
  };
  log?: (msg: string) => void;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    // Source (api-avail/src) and bundle (api-avail/dist) both sit two levels below the repo root.
    migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? path.join(here, "../../api/migrations")),
    availMigrationsDir: path.resolve(env.AVAIL_MIGRATIONS_DIR ?? path.join(here, "../migrations")),
    seedMode: env.SEED_LIBRARY,
    tokenRateLimit: rateLimitFromEnv(env.AI_TOKEN_RATE_LIMIT),
    vars: {
      ADMIN_TOKEN: env.ADMIN_TOKEN ?? "",
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "",
      SUPPORT_FORWARD_EMAIL: env.SUPPORT_FORWARD_EMAIL ?? "",
      API_PUBLIC_URL: env.API_PUBLIC_URL ?? "",
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? "",
      GOOGLE_ALLOWED_DOMAIN: env.GOOGLE_ALLOWED_DOMAIN ?? "",
      DISABLE_MAGIC_LINK: env.DISABLE_MAGIC_LINK ?? "",
      MAX_SCHEMATICS_PER_USER: env.MAX_SCHEMATICS_PER_USER ?? "",
    },
  };
}

export interface ApiServer {
  fetch: (request: Request) => Promise<Response>;
  db: D1DatabaseShim;
  bucket: R2BucketShim;
  migrations: MigrationResult;
  seed: SeedResult;
  close: () => void;
}

/** Minimal ExecutionContext: Hono only needs it to exist; waitUntil work is just awaited-and-logged. */
function executionContext(log: (msg: string) => void): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      promise.catch((err) => log(`waitUntil task failed: ${String(err)}`));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

/** Upstream migrations, then ours; both are recorded in d1_migrations. */
export function applyAllMigrations(
  sqlite: D1DatabaseShim["sqlite"],
  config: Pick<ApiConfig, "migrationsDir" | "availMigrationsDir">,
  log: (msg: string) => void = () => {},
): MigrationResult {
  const upstreamResult = applyMigrations(sqlite, config.migrationsDir, log);
  const ours = applyMigrations(sqlite, config.availMigrationsDir, log);
  return { applied: [...upstreamResult.applied, ...ours.applied], skipped: upstreamResult.skipped };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** GET /templates and /templates/summary are served by our status-filtered routes (routes.ts). */
const LIBRARY_PATHS: Record<string, string> = {
  "/templates": "/avail/library/templates",
  "/templates/summary": "/avail/library/summary",
};

export function libraryRewrite(request: Request): Request {
  if (request.method !== "GET" && request.method !== "HEAD") return request;
  const url = new URL(request.url);
  const target = LIBRARY_PATHS[url.pathname.replace(/\/+$/, "") || "/"];
  if (!target) return request;
  url.pathname = target;
  return new Request(url, request);
}

export function createApiServer(config: ApiConfig): ApiServer {
  const log = config.log ?? ((msg: string) => console.log(msg));
  // api/src compares the bearer token with ===, so an empty ADMIN_TOKEN would let
  // "Authorization: Bearer " (no token) through as admin. Refuse to start instead.
  if (config.vars.ADMIN_TOKEN.length < 16) {
    throw new Error("ADMIN_TOKEN must be set to at least 16 characters (it grants admin via Authorization: Bearer)");
  }
  const magicLinkOff = config.vars.DISABLE_MAGIC_LINK === "1" || config.vars.DISABLE_MAGIC_LINK === "true";
  if (config.vars.GOOGLE_ALLOWED_DOMAIN && !magicLinkOff) {
    // Email sign-in creates accounts for any address, so the domain gate alone is bypassable.
    log("WARNING: GOOGLE_ALLOWED_DOMAIN is set but magic-link sign-in is on; set DISABLE_MAGIC_LINK=1");
  }
  mkdirSync(config.dataDir, { recursive: true });
  installMailStub(log);

  const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
  const bucket = new R2BucketShim(path.join(config.dataDir, "r2"));

  const migrations = applyAllMigrations(db.sqlite, config, log);
  const seed = seedLibrary(db.sqlite, parseSeedMode(config.seedMode));
  if (seed.seeded > 0) log(`library seeded: ${seed.seeded} templates (mode ${seed.mode})`);
  const synced = syncLintLevels(db.sqlite);
  if (synced.linted > 0) log(`lint levels updated: ${synced.linted} templates`);
  if (synced.demoted.length > 0) log(`verified below level A, moved to draft: ${synced.demoted.join(", ")}`);
  // Levels depend on the whole library (slots and cards): bring every stored level up to date.
  const relinted = relintAll(db.sqlite);
  if (relinted > 0) log(`lint levels re-checked against the library: ${relinted} changed`);

  const bindings = {
    easyschematic_db: db as unknown as D1Database,
    SCHEMATIC_STORAGE: bucket as unknown as R2Bucket,
    RESEND_API_KEY: "disabled",
    ...config.vars,
  };
  const ctx = executionContext(log);

  const limiter = new TokenRateLimiter(config.tokenRateLimit);
  const allowedOrigins = (config.vars.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  /** The app's public origin for links in MCP answers: API_PUBLIC_URL without /api. */
  const appOrigin = (() => {
    try {
      return config.vars.API_PUBLIC_URL ? new URL(config.vars.API_PUBLIC_URL).origin : "";
    } catch {
      return "";
    }
  })();
  /** An answer of ours served by an internal route of the app, so its CORS and security headers apply. */
  const internalAnswer = (request: Request, pathname: string) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    url.search = "";
    return new Request(url, { method: request.method, headers: request.headers });
  };

  async function serve(incoming: Request): Promise<Response> {
    // Disabled users run signed out; upstream's user admin calls go to ours (users.ts).
    const { request, actor } = resolveActor(db.sqlite, userRouteRewrite(incoming), config.vars.ADMIN_TOKEN);
    // A save that would duplicate another template (same manufacturer + part number): 409.
    try {
      const conflict = await duplicateConflict(db.sqlite, request);
      if (conflict) {
        const internal = internalAnswer(request, CONFLICT_PATH);
        pendingConflicts.set(internal, conflict);
        return await upstream.fetch(internal, bindings, ctx);
      }
    } catch (err) {
      log(`duplicate check failed: ${String(err)}`);
    }
    // Template writes through upstream's routes: snapshot before, log what changed after.
    let audit: ReturnType<typeof beginTemplateAudit> | null = null;
    try {
      if (auditsTemplates(request)) audit = beginTemplateAudit(db.sqlite, request);
    } catch (err) {
      log(`audit snapshot failed: ${String(err)}`);
    }
    // A proposal accepted or rejected in the library workspace: read before upstream decides it.
    let proposal: ProposalDecision | null = null;
    try {
      proposal = await readProposalDecision(db.sqlite, request);
    } catch (err) {
      log(`proposal audit read failed: ${String(err)}`);
    }
    // An accepted update proposal: what it changes becomes overrides (overrides.ts), read the template now.
    let overrides: ProposalOverrideScope | null = null;
    try {
      overrides = await beginProposalOverrides(db.sqlite, request);
    } catch (err) {
      log(`override read failed: ${String(err)}`);
    }
    let response = await upstream.fetch(libraryRewrite(request), bindings, ctx);
    if (overrides && response.status < 400) {
      try {
        endProposalOverrides(db.sqlite, overrides, actor);
      } catch (err) {
        log(`override write failed: ${String(err)}`);
      }
    }
    if (proposal && response.status < 400) {
      try {
        writeAudit(db.sqlite, [proposalAuditEntry(proposal, actor)]);
      } catch (err) {
        log(`proposal audit write failed: ${String(err)}`);
      }
    }
    if (audit && response.status < 400) {
      try {
        endTemplateAudit(db.sqlite, audit, actor);
      } catch (err) {
        log(`audit write failed: ${String(err)}`);
      }
    }
    if (new URL(request.url).pathname === "/auth/google/callback") response = await refuseDisabledSignIn(db.sqlite, response);
    // Whatever route saved a template (PUT /templates/:id, POST /templates, an approved
    // submission…), upstream bumped its version: re-lint the changed ones (a verified
    // one that fell below level A becomes draft).
    if (!READ_METHODS.has(request.method) && response.status < 400) {
      try {
        const { demoted } = syncLintLevels(db.sqlite);
        if (demoted.length > 0) log(`verified below level A, moved to draft: ${demoted.join(", ")}`);
      } catch (err) {
        log(`lint sync failed: ${String(err)}`);
      }
    }
    return response;
  }

  return {
    fetch: async (raw) => {
      // An AI Assistant access token (Authorization: Bearer avail_ai_…) signs its user in (accessTokens.ts).
      let token: { id: string; name: string; userId: string; email: string } | null = null;
      let incoming = raw;
      try {
        const t = resolveAccessToken(db.sqlite, raw, limiter);
        if (t.kind === "refused") {
          const internal = internalAnswer(raw, REFUSAL_PATH);
          pendingRefusals.set(internal, t);
          return await upstream.fetch(internal, bindings, ctx);
        }
        if (t.kind === "ok") {
          token = t.token;
          incoming = t.request;
        }
      } catch (err) {
        log(`access token check failed: ${String(err)}`);
        const internal = internalAnswer(raw, REFUSAL_PATH);
        pendingRefusals.set(internal, { status: 401, body: { error: "Access token could not be checked. Try again." } });
        return await upstream.fetch(internal, bindings, ctx);
      }
      // Every audit entry written while serving the request names the token (audit.ts).
      return requestContext.run({ token: token ? { id: token.id, name: token.name } : null }, async () => {
        // The remote MCP server (mcp.ts): AI Assistant tokens only; tools call our routes as its user.
        if (new URL(incoming.url).pathname.replace(/\/+$/, "") === MCP_PATH) {
          const origin = incoming.headers.get("Origin");
          if (origin && !allowedOrigins.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
          if (!token) return mcpUnauthorized();
          const cookie = incoming.headers.get("Cookie") ?? "";
          const forwarded = incoming.headers.get("X-Forwarded-For");
          return handleMcp(incoming, {
            token,
            sqlite: db.sqlite,
            appOrigin,
            call: (p, init = {}) =>
              serve(
                new Request(`http://api.internal${p}`, {
                  method: init.method ?? "GET",
                  headers: { Cookie: cookie, ...(forwarded ? { "X-Forwarded-For": forwarded } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
                  body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
                }),
              ),
          });
        }
        const response = await serve(incoming);
        if (token) {
          try {
            logTokenRequest(db.sqlite, token, incoming, response.status);
          } catch (err) {
            log(`token request audit failed: ${String(err)}`);
          }
        }
        return response;
      });
    },
    db,
    bucket,
    migrations,
    seed,
    close: () => db.close(),
  };
}
