/**
 * Roles and the audit log in the editor (step 2.1): role names over upstream's users.role,
 * audit change lines, the admin API client, the account menu entries per role.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvailAccountMenuItems } from "../avail/AdminUi";
import { auditChanges, fetchAudit, setUserActive, setUserRole, type AuditRecord } from "../avail/adminApi";
import { getAdminPage, openAdminPage } from "../avail/adminPages";
import { AUTH_ERROR_MESSAGES } from "../avail/auth";
import { resetForTests, setRole } from "../avail/libraryMode";
import { availRoleOf, isLibrarianOrAdmin, isSystemAccount, ROLE_LABELS, upstreamRoleOf } from "../avail/roles";

describe("roles", () => {
  it("AVAIL names over upstream's values; unknown is the least privileged", () => {
    expect([availRoleOf("contributor"), availRoleOf("moderator"), availRoleOf("admin"), availRoleOf("user"), availRoleOf(undefined)]).toEqual([
      "engineer", "librarian", "admin", "engineer", "engineer",
    ]);
    expect([upstreamRoleOf("engineer"), upstreamRoleOf("librarian"), upstreamRoleOf("admin")]).toEqual(["contributor", "moderator", "admin"]);
    expect(upstreamRoleOf("moderator")).toBe("moderator");
    expect(upstreamRoleOf("superuser")).toBeNull();
    expect(isLibrarianOrAdmin("moderator") && isLibrarianOrAdmin("admin") && !isLibrarianOrAdmin("contributor")).toBe(true);
    expect(ROLE_LABELS).toEqual({ engineer: "Engineer", assistant: "AI Assistant", librarian: "Librarian", admin: "Admin" });
  });

  it("a disabled account has its own sign-in message", () => {
    expect(AUTH_ERROR_MESSAGES.account_disabled).toMatch(/disabled/);
  });
});

describe("audit change lines", () => {
  const rec = (over: Partial<AuditRecord>): AuditRecord => ({
    id: 1, at: "2026-11-26 10:00:00", actor: "a@avail.test", actorId: null, entity: "template", entityId: "t", entityLabel: "T",
    action: "updated", before: null, after: null, ...over,
  });
  it("field: before → after, long values shortened, nothing for created and deleted", () => {
    expect(auditChanges(rec({ before: { label: "A" }, after: { label: "B", heightMm: 44 } }))).toEqual(['label: A → B', "heightMm: — → 44"]);
    const long = auditChanges(rec({ before: { ports: [] }, after: { ports: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })) } }))[0];
    expect(long.endsWith("…")).toBe(true);
    expect(auditChanges(rec({ action: "role", entity: "user", before: { role: "engineer" }, after: { role: "librarian" } }))).toEqual(["role: engineer → librarian"]);
    expect(auditChanges(rec({ action: "created", after: { label: "X" } }))).toEqual([]);
    expect(auditChanges(rec({ entity: "run", action: "run", after: { command: "import:catalog", args: [], commit: "0123456789abcdef", counts: { created: 5, updated: 3 } } }))).toEqual([
      "created 5, updated 3", "commit 0123456789ab",
    ]);
  });
});

describe("admin API client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends the role and access changes, reads the audit with filters, throws the server's error", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.includes("/active")) return new Response(JSON.stringify({ error: "The last active admin cannot be demoted or disabled." }), { status: 409 });
      return new Response(JSON.stringify(url.includes("/audit") ? [] : { id: "u1", role: "librarian" }), { status: 200 });
    });
    await setUserRole("u1", "librarian");
    await expect(setUserActive("u1", false)).rejects.toThrow(/last active admin/);
    await fetchAudit({ entity: "user", before: 50, limit: 10 });
    expect(calls[0][0]).toMatch(/\/avail\/users\/u1\/role$/);
    expect(calls[0][1]).toMatchObject({ method: "PUT", credentials: "include", body: '{"role":"librarian"}' });
    expect(calls[2][0]).toMatch(/\/avail\/audit\?entity=user&before=50&limit=10$/);
  });
});

describe("account menu", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AVAIL", "1");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    resetForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const menu = () => renderToString(createElement(AvailAccountMenuItems, { onPick: () => {} }));

  it("engineer: the role only; librarian: Audit log; admin: Users and Audit log", () => {
    setRole("contributor");
    expect(menu()).toContain("Role: <!-- -->Engineer");
    expect(menu()).not.toContain("Audit log");
    setRole("moderator");
    expect(menu()).toContain("Librarian");
    expect(menu()).toContain("Audit log");
    expect(menu()).not.toContain(">Users<");
    setRole("admin");
    expect(menu()).toContain(">Users<");
    expect(menu()).toContain("Audit log");
  });

  it("opening a page", () => {
    openAdminPage("users");
    expect(getAdminPage()).toBe("users");
    openAdminPage(null);
    expect(getAdminPage()).toBeNull();
  });
});

describe("isSystemAccount", () => {
  it("is an email on the .invalid domain", () => {
    expect(isSystemAccount("vendor-responses@avail.invalid")).toBe(true);
    expect(isSystemAccount(" X@Y.INVALID ")).toBe(true);
    expect(isSystemAccount("ceo@avail-int.com")).toBe(false);
    expect(isSystemAccount("invalid@avail.test")).toBe(false);
    expect(isSystemAccount(null)).toBe(false);
  });
});
