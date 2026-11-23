/**
 * AVAIL routes, registered on the upstream Hono app (api/src/index.ts exports it),
 * so they run behind the same CORS, session and security-header middleware.
 *
 *   GET /avail/templates/status[?status=raw]  every template's status (no auth, like GET /templates)
 *   GET /avail/templates/:id/status           one template's status
 *   PUT /avail/templates/:id/status           { "status": "verified" | "draft" | "raw" | "hidden" }
 *                                             moderator/admin session or ADMIN_TOKEN bearer;
 *                                             verified only at standard level A (else 400 + lint)
 *
 *   GET /avail/library/templates[?include=raw,hidden]   the library filtered by status
 *   GET /avail/library/summary[?include=raw,hidden]
 *     server.ts serves GET /templates and GET /templates/summary from these, so the
 *     editor gets verified + draft by default; include=raw adds raw, include=hidden
 *     (moderator/admin only) adds hidden.
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireModeratorOrToken } from "../../api/src/auth";
import { rowToSummary, rowToTemplate, type TemplateRow } from "../../api/src/db";
import {
  getTemplateMeta,
  isTemplateStatus,
  listTemplateMeta,
  setTemplateStatus,
  TEMPLATE_STATUSES,
  type TemplateStatus,
} from "./templateMeta";

type UpstreamApp = typeof UpstreamAppValue;

/** Response header that tells the editor it talks to an AVAIL API (status-filtered library). */
export const AVAIL_LIBRARY_HEADER = "X-Avail-Library";

const registered = new WeakSet<object>();

/** Statuses GET /templates returns for an `include` query; null + error when not allowed. */
export function libraryStatuses(
  include: string | undefined,
  isModerator: boolean,
): { statuses: TemplateStatus[] } | { error: string; status: 400 | 403 } {
  const statuses: TemplateStatus[] = ["verified", "draft"];
  for (const part of (include ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part === "raw") statuses.push("raw");
    else if (part === "hidden") {
      if (!isModerator) return { error: "include=hidden is for moderators and admins", status: 403 };
      statuses.push("hidden");
    } else return { error: "include must be raw and/or hidden", status: 400 };
  }
  return { statuses: [...new Set(statuses)] };
}

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
    const result = await setTemplateStatus(c.env.easyschematic_db, c.req.param("id"), status, by);
    if (result.ok) return c.json(result.meta);
    if (result.reason === "not_found") return c.json({ error: "Template not found" }, 404);
    return c.json(
      {
        error: `verified only at standard level A; this template is ${result.lint.level}`,
        level: result.lint.level,
        errors: result.lint.errors,
        warnings: result.lint.warnings,
      },
      400,
    );
  });

  for (const [path, shape] of [
    ["/avail/library/templates", "full"],
    ["/avail/library/summary", "summary"],
  ] as const) {
    app.get(path, async (c) => {
      const allowed = libraryStatuses(c.req.query("include"), !!requireModeratorOrToken(c));
      if ("error" in allowed) return c.json({ error: allowed.error }, allowed.status);
      const statuses = allowed.statuses.sort();
      const db = c.env.easyschematic_db;

      // ETag per library version (rolled on template writes and status changes) and status set.
      const lib = await db.prepare("SELECT version FROM library_meta WHERE id = 1").first<{ version: number }>();
      const etag = `"avail-${lib?.version ?? 0}-${shape}-${statuses.join("+")}"`;
      const headers = {
        "Cache-Control": "no-cache",
        ETag: etag,
        Vary: "Cookie, Authorization",
        [AVAIL_LIBRARY_HEADER]: "1",
        "Access-Control-Expose-Headers": `${AVAIL_LIBRARY_HEADER}, ETag`,
      };
      const inm = c.req.header("If-None-Match");
      if (inm && inm.split(",").some((t) => t.trim() === etag)) return c.body(null, 304, headers);

      const { results } = await db
        .prepare(
          `SELECT t.*, COALESCE(m.status, 'raw') AS avail_status
             FROM templates t LEFT JOIN avail_template_meta m ON m.template_id = t.id
            WHERE t.flagged_for_deletion = 0 AND COALESCE(m.status, 'raw') IN (${statuses.map(() => "?").join(", ")})
            ORDER BY t.sort_order, t.label`,
        )
        .bind(...statuses)
        .all<TemplateRow & { avail_status: TemplateStatus }>();
      const out = results.map((row) => ({
        ...(shape === "full" ? rowToTemplate(row) : rowToSummary(row)),
        availStatus: row.avail_status,
      }));
      return c.json(out, 200, headers);
    });
  }
}
