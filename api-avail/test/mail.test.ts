import { describe, expect, it, vi } from "vitest";
import { createMailStubFetch } from "../src/mail";

describe("mail stub", () => {
  it("swallows Resend calls, logs recipient and subject but not the body", async () => {
    const real = vi.fn();
    const logs: string[] = [];
    const f = createMailStubFetch(real as never, (m) => logs.push(m));
    const res = await f("https://api.resend.com/emails", {
      method: "POST",
      body: JSON.stringify({ to: "a@b.c", subject: "Log in", text: "secret-token-123" }),
    });
    expect(res.ok).toBe(true);
    expect(real).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("a@b.c");
    expect(logs.join("\n")).toContain("Log in");
    expect(logs.join("\n")).not.toContain("secret-token-123");
  });

  it("passes every other request to the real fetch", async () => {
    const real = vi.fn(async () => new Response("ok"));
    const f = createMailStubFetch(real as never, () => {});
    await f("https://oauth2.googleapis.com/token", { method: "POST" });
    expect(real).toHaveBeenCalledOnce();
  });
});
