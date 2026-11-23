/**
 * Builds the Workers-style `env` for the unmodified Hono app in api/src and wraps
 * its fetch handler for Node. main.ts listens; tests call createApiServer() directly.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import upstream from "../../api/src/index";
import { D1DatabaseShim } from "./d1";
import { R2BucketShim } from "./r2";
import { applyMigrations, type MigrationResult } from "./migrate";
import { parseSeedMode, seedLibrary, type SeedResult } from "./seed";
import { installMailStub } from "./mail";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ApiConfig {
  dataDir: string;
  migrationsDir: string;
  seedMode: string | undefined;
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
    seedMode: env.SEED_LIBRARY,
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

  const migrations = applyMigrations(db.sqlite, config.migrationsDir, log);
  const seed = seedLibrary(db.sqlite, parseSeedMode(config.seedMode));
  if (seed.seeded > 0) log(`library seeded: ${seed.seeded} templates (mode ${seed.mode})`);

  const bindings = {
    easyschematic_db: db as unknown as D1Database,
    SCHEMATIC_STORAGE: bucket as unknown as R2Bucket,
    RESEND_API_KEY: "disabled",
    ...config.vars,
  };
  const ctx = executionContext(log);

  return {
    fetch: async (request) => upstream.fetch(request, bindings, ctx),
    db,
    bucket,
    migrations,
    seed,
    close: () => db.close(),
  };
}
