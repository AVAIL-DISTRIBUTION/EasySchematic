/** Entry point: start the API on PORT (default 8787, same as `wrangler dev`). */
import { serve } from "@hono/node-server";
import { configFromEnv, createApiServer } from "./server";

const api = createApiServer(configFromEnv());
const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";

const server = serve({ fetch: (req) => api.fetch(req), port, hostname }, (info) => {
  console.log(
    `easyschematic-api (avail) listening on http://${hostname}:${info.port} — ` +
      `${api.migrations.applied.length} migration(s) applied, ${api.migrations.skipped} already present`,
  );
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    api.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
