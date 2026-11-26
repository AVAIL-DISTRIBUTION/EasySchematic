/**
 * AI Assistant role and access tokens in the editor (step 2.5): the role between Engineer and
 * Librarian, the audit log text for tokens and API requests, the token API client, the Users
 * page's Tokens panel.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTION_LABELS, auditActor, auditChanges, createToken, expiryDate, revokeToken, type AuditRecord } from "../avail/adminApi";
import { AI_ASSISTANT_EMAIL, AVAIL_ROLES, availRoleOf, canReadAudit, isAssistant, isLibrarianOrAdmin, isSystemAccount, ROLE_DESCRIPTIONS, upstreamRoleOf } from "../avail/roles";
import { TokensPanel } from "../avail/TokensUi";

describe("the AI Assistant role", () => {
  it("between Engineer and Librarian; stored as 'assistant'; not a moderator; reads the audit log", () => {
    expect(AVAIL_ROLES).toEqual(["engineer", "assistant", "librarian", "admin"]);
    expect([upstreamRoleOf("assistant"), availRoleOf("assistant")]).toEqual(["assistant", "assistant"]);
    expect(isAssistant("assistant") && !isLibrarianOrAdmin("assistant")).toBe(true);
    expect(["contributor", "assistant", "moderator", "admin"].map(canReadAudit)).toEqual([false, true, true, true]);
    expect(ROLE_DESCRIPTIONS.assistant).toMatch(/access token/);
    expect(isSystemAccount(AI_ASSISTANT_EMAIL)).toBe(true);
  });
});

describe("audit log: tokens and API requests", () => {
  const rec = (over: Partial<AuditRecord>): AuditRecord => ({
    id: 1, at: "2026-11-26 10:00:00", actor: "boss@avail.test", actorId: null, entity: "user", entityId: "u", entityLabel: "claude@avail.invalid",
    action: "token", before: null, after: null, ...over,
  });
  it("created, revoked, a request; the actor names the token", () => {
    expect(AUDIT_ACTION_LABELS.token).toBe("Access token");
    expect(auditChanges(rec({ after: { created: "nightly", expiresAt: "2027-02-24 23:59:59" } }))).toEqual(["Created “nightly”, expires 2027-02-24"]);
    expect(auditChanges(rec({ after: { revoked: "nightly", reason: "user disabled" } }))).toEqual(["Revoked “nightly”: user disabled"]);
    const req = rec({ action: "request", actor: "claude@avail.invalid", token: "nightly", after: { method: "POST", path: "/avail/templates/draft", status: 201 } });
    expect(auditChanges(req)).toEqual(["POST /avail/templates/draft → 201"]);
    expect(auditActor(req)).toBe("claude@avail.invalid (token “nightly”)");
    expect(auditActor(rec({}))).toBe("boss@avail.test");
  });
});

describe("token API client and the Tokens panel", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("expiry presets are dates from today", () => {
    expect(expiryDate(30, new Date("2026-11-26T12:00:00Z"))).toBe("2026-12-26");
    expect(expiryDate(365, new Date("2026-11-26T12:00:00Z"))).toBe("2027-11-26");
  });
  it("creates with name and expiry, revokes by id, throws the server's message", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith("/revoke")) return new Response(JSON.stringify({ error: "Token not found" }), { status: 404 });
      return new Response(JSON.stringify({ token: { id: "t1" }, value: "avail_ai_x" }), { status: 201 });
    });
    expect((await createToken("avail-ai-assistant", "nightly", "2027-01-31")).value).toBe("avail_ai_x");
    await expect(revokeToken("t1")).rejects.toThrow("Token not found");
    expect(calls.map(([u, i]) => [u.replace(/^.*?\/avail/, "/avail"), i?.method, i?.body])).toEqual([
      ["/avail/users/avail-ai-assistant/tokens", "POST", JSON.stringify({ name: "nightly", expiresAt: "2027-01-31" })],
      ["/avail/tokens/t1/revoke", "POST", "{}"],
    ]);
  });
  it("the panel: the new-token form for an active user, a note for a disabled one", () => {
    const u = { id: "u", email: "claude@avail.invalid", name: "Claude", role: "assistant" as const, createdAt: "", lastLoginAt: null, active: true };
    const html = renderToString(createElement(TokensPanel, { user: u, onChanged: () => {} }));
    expect(html).toContain("Create token");
    expect(html).toContain("Loading tokens…");
    expect(renderToString(createElement(TokensPanel, { user: { ...u, active: false }, onChanged: () => {} }))).toContain("their tokens are revoked");
  });
});
