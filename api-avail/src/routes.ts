/**
 * AVAIL routes, registered on the upstream Hono app (api/src/index.ts exports it),
 * so they run behind the same CORS, session and security-header middleware.
 *
 *   GET /avail/templates/status[?status=raw]  every template's status (no auth, like GET /templates)
 *   GET /avail/templates/:id/status           one template's status
 *   PUT /avail/templates/:id/status           { "status": "verified" | "draft" | "raw" | "hidden" }
 *                                             moderator/admin session or ADMIN_TOKEN bearer
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { getTemplateMeta, isTemplateStatus, listTemplateMeta, setTemplateStatus, TEMPLATE_STATUSES } from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;

const registered = new WeakSet<object>();

export function registerAvailRoutes(app: UpstreamApp): void {
  if (registered.has(app)) return;
  registered.add(app);

  app.get("/avail/templates/status", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !isTemplateStatus(status)) {
      return c.json({ error: `status must be one of ${TEMPLATE_STATUSES.join(", ")}` }, 400);
    }
    return c.json(await listTemplateMeta(c.env.easyschematic_db, status));
  });

  app.get("/avail/templates/:id/status", async (c) => {
    const meta = await getTemplateMeta(c.env.easyschematic_db, c.req.param("id"));
    if (!meta) return c.json({ error: "Template not found" }, 404);
    return c.json(meta);
  });

  app.put("/avail/templates/:id/status", async (c) => {
    const auth = requireModeratorOrToken(c);
    if (!auth) return c.json({ error: "Moderator access required" }, 403);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const status = (body as { status?: unknown } | null)?.status;
    if (!isTemplateStatus(status)) {
      return c.json({ error: `status must be one of ${TEMPLATE_STATUSES.join(", ")}` }, 400);
    }

    const by = auth === "token" ? "admin-token" : auth.email;
    const meta = await setTemplateStatus(c.env.easyschematic_db, c.req.param("id"), status, by);
    if (!meta) return c.json({ error: "Template not found" }, 404);
    return c.json(meta);
  });
}
