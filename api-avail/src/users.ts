/**
 * AVAIL users and the audit log (step 2.1), registered on the upstream Hono app next to
 * routes.ts. Roles are upstream's users.role under AVAIL names (src/avail/roles.ts); access is
 * upstream's users.banned (a disabled user is signed out and cannot sign in, server.ts).
 *
 *   GET /avail/users                 admin (session or ADMIN_TOKEN): every user with name, email,
 *                                    role, created, last sign-in, active
 *   PUT /avail/users/:id/role        admin: { "role": "engineer" | "librarian" | "admin" }
 *                                    (upstream's contributor / moderator / admin also accepted)
 *   PUT /avail/users/:id/active      admin: { "active": true | false }; disabling deletes sessions
 *   GET /avail/audit                 librarian or admin: the audit log, newest first;
 *                                    ?entity=user|template&entityId=&actor=&before=<id>&limit=
 *
 * The last active admin can be neither demoted nor disabled (409). Every change is written to
 * the audit log. Upstream's PUT /users/:id/role and /users/:id/ban are served by these routes
 * (server.ts), so the guard and the log cannot be bypassed.
 */
import type { app as UpstreamAppValue } from "../../api/src/index";
import { requireAdminOrToken, requireModeratorOrToken } from "../../api/src/auth";
import { availRoleOf, upstreamRoleOf, type AvailRole } from "../../src/avail/roles";
import { ADMIN_TOKEN_ACTOR, AUDIT_PAGE, listAudit, writeAuditD1, type AuditEntity } from "./audit";

type UpstreamApp = typeof UpstreamAppValue;
/** Hono context of the upstream app (api/src has its own copy of hono). */
type Ctx = Parameters<typeof requireAdminOrToken>[0];

export interface AvailUser {
  id: string;
  email: string;
  name: string | null;
  role: AvailRole;
  createdAt: string;
  lastLoginAt: string | null;
  active: boolean;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  banned: number;
  created_at: string;
  last_login_at: string | null;
}

const NO_CACHE = { "Cache-Control": "no-store" };

function toUser(r: UserRow): AvailUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: availRoleOf(r.role),
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    active: !r.banned,
  };
}

function actorOf(auth: { id: string; email: string } | "token"): { actor: string; actorId: string | null } {
  return auth === "token" ? { actor: ADMIN_TOKEN_ACTOR, actorId: null } : { actor: auth.email, actorId: auth.id };
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT id, email, name, role, banned, created_at, last_login_at FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/** Active admins other than `exceptId`. */
async function otherActiveAdmins(db: D1Database, exceptId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND banned = 0 AND id <> ?").bind(exceptId).first<{ n: number }>();
  return r?.n ?? 0;
}

export const LAST_ADMIN_ERROR = "The last active admin cannot be demoted or disabled. Make another user an admin first.";

/** Role change; shared by PUT /avail/users/:id/role and upstream's PUT /users/:id/role. */
async function changeRole(c: Ctx): Promise<Response> {
  const auth = requireAdminOrToken(c);
  if (!auth) return c.json({ error: "Admin access required" }, 403);
  const body = await readJson(c);
  const role = upstreamRoleOf(body?.role);
  if (!role) return c.json({ error: "role must be engineer, librarian or admin" }, 400);
  const db = c.env.easyschematic_db;
  const user = await getUser(db, c.req.param("id")!);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.role === role) return c.json(toUser(user), 200, NO_CACHE);
  if (user.role === "admin" && !user.banned && (await otherActiveAdmins(db, user.id)) === 0) {
    return c.json({ error: LAST_ADMIN_ERROR }, 409);
  }
  await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, user.id).run();
  await writeAuditD1(db, [{
    ...actorOf(auth), entity: "user", entityId: user.id, entityLabel: user.email, action: "role",
    before: { role: availRoleOf(user.role) }, after: { role: availRoleOf(role) },
  }]);
  return c.json(toUser({ ...user, role }), 200, NO_CACHE);
}

/** Access change; `active` from PUT /avail/users/:id/active, or !banned from upstream's /ban. */
async function changeAccess(c: Ctx, active: boolean | null): Promise<Response> {
  const auth = requireAdminOrToken(c);
  if (!auth) return c.json({ error: "Admin access required" }, 403);
  if (active === null) return c.json({ error: "active must be true or false" }, 400);
  const db = c.env.easyschematic_db;
  const user = await getUser(db, c.req.param("id")!);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (!user.banned === active) return c.json(toUser(user), 200, NO_CACHE);
  if (!active && user.role === "admin" && (await otherActiveAdmins(db, user.id)) === 0) {
    return c.json({ error: LAST_ADMIN_ERROR }, 409);
  }
  await db.batch([
    db.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(active ? 0 : 1, user.id),
    // Disabled: signed out everywhere at once.
    ...(active ? [] : [db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)]),
  ]);
  await writeAuditD1(db, [{
    ...actorOf(auth), entity: "user", entityId: user.id, entityLabel: user.email, action: "access",
    before: { active: !user.banned }, after: { active },
  }]);
  return c.json(toUser({ ...user, banned: active ? 0 : 1 }), 200, NO_CACHE);
}

export function registerUserRoutes(app: UpstreamApp): void {
  app.get("/avail/users", async (c) => {
    if (!requireAdminOrToken(c)) return c.json({ error: "Admin access required" }, 403);
    const { results } = await c.env.easyschematic_db
      .prepare("SELECT id, email, name, role, banned, created_at, last_login_at FROM users ORDER BY email")
      .all<UserRow>();
    return c.json(results.map(toUser), 200, NO_CACHE);
  });

  app.put("/avail/users/:id/role", changeRole);
  app.put("/avail/users/:id/active", async (c) => {
    const body = await readJson(c);
    return changeAccess(c, typeof body?.active === "boolean" ? body.active : null);
  });
  // Upstream's own admin calls, rewritten here by server.ts.
  app.put("/avail/upstream/users/:id/role", changeRole);
  app.put("/avail/upstream/users/:id/ban", async (c) => {
    const body = await readJson(c);
    return changeAccess(c, typeof body?.banned === "boolean" ? !body.banned : null);
  });

  app.get("/avail/audit", async (c) => {
    if (!requireModeratorOrToken(c)) return c.json({ error: "Librarian or admin access required" }, 403);
    const entity = c.req.query("entity");
    if (entity && entity !== "user" && entity !== "template") return c.json({ error: "entity must be user or template" }, 400);
    const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    const entries = await listAudit(c.env.easyschematic_db, {
      entity: entity as AuditEntity | undefined,
      entityId: c.req.query("entityId") || undefined,
      actor: c.req.query("actor") || undefined,
      before: num(c.req.query("before")),
      limit: num(c.req.query("limit")) ?? AUDIT_PAGE,
    });
    return c.json(entries, 200, NO_CACHE);
  });
}
