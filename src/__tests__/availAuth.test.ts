import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTH_ERROR_MESSAGES, isGoogleOnly, readAuthError, withoutAuthError } from "../avail/auth";
import LoginDialog from "../components/LoginDialog";

afterEach(() => vi.unstubAllEnvs());

describe("AVAIL auth: isGoogleOnly", () => {
  it("is on for 1 / true and off otherwise", () => {
    expect(isGoogleOnly({ VITE_AUTH_GOOGLE_ONLY: "1" })).toBe(true);
    expect(isGoogleOnly({ VITE_AUTH_GOOGLE_ONLY: "true" })).toBe(true);
    expect(isGoogleOnly({ VITE_AUTH_GOOGLE_ONLY: "0" })).toBe(false);
    expect(isGoogleOnly({})).toBe(false);
  });
});

describe("AVAIL auth: sign-in errors from the API redirect", () => {
  it("maps known codes to a message", () => {
    expect(readAuthError("?error=domain_not_allowed")).toEqual({
      code: "domain_not_allowed",
      message: AUTH_ERROR_MESSAGES.domain_not_allowed,
    });
    expect(readAuthError("?error=domain_not_allowed")!.message).toMatch(/Workspace/);
  });

  it("ignores unknown codes and missing params", () => {
    expect(readAuthError("?error=<script>")).toBeNull();
    expect(readAuthError("?project=1")).toBeNull();
    expect(readAuthError("")).toBeNull();
  });

  it("strips only the error param from the URL", () => {
    expect(withoutAuthError("https://sch.avail-int.com/?error=expired")).toBe("/");
    expect(withoutAuthError("https://sch.avail-int.com/?a=1&error=expired#x")).toBe("/?a=1#x");
  });
});

describe("AVAIL auth: LoginDialog", () => {
  const render = () => renderToStaticMarkup(createElement(LoginDialog, { open: true, onClose: () => {} }));

  it("shows only the Google button when VITE_AUTH_GOOGLE_ONLY=1", () => {
    vi.stubEnv("VITE_AUTH_GOOGLE_ONLY", "1");
    const html = render();
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("Send login link");
  });

  it("keeps email sign-in by default (upstream)", () => {
    vi.stubEnv("VITE_AUTH_GOOGLE_ONLY", "");
    const html = render();
    expect(html).toContain("Sign in with Google");
    expect(html).toContain('type="email"');
    expect(html).toContain("Send login link");
  });
});
