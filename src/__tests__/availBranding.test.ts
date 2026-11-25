/**
 * AVAIL interface (VITE_AVAIL=1): build flag, branding, sign-in gate decisions, new
 * schematic defaults, category-group header colors, library panel width.
 * Store-level behaviour is in availUiStore.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AVAIL_APP_NAME,
  FORK_SOURCE_URL,
  appDocumentTitle,
  docsUrl,
  isAvailBuild,
  sourceUrlFor,
} from "../avail/brand";
import { availHelpMenu, availSaveActions, AVAIL_HIDDEN_VIEW_ITEMS } from "../avail/menus";
import {
  REDIRECT_LOOP_WINDOW_MS,
  decideGate,
  displayNameOf,
  fetchSession,
  googleSignInUrl,
  type SessionCheck,
} from "../avail/session";
import {
  AVAIL_SIGNAL_COLORS,
  AVAIL_SIGNAL_LINE_STYLES,
  availNewSchematicDefaults,
  availTitleBlockLayout,
  isoLocalDate,
} from "../avail/schematicDefaults";
import { GROUP_HEADER_COLORS, groupHeaderColor, groupOfCategory, templateHeaderColor } from "../avail/headerColors";
import { TAXONOMY } from "../avail/library";
import { contrastingTextColor } from "../colorContrast";
import { getPaperSize } from "../printConfig";
import { DEFAULT_SIGNAL_COLORS } from "../signalColors";
import {
  LIBRARY_WIDTH_DEFAULT,
  LIBRARY_WIDTH_MAX,
  LIBRARY_WIDTH_MIN,
  clampLibraryWidth,
  libraryWidthKey,
  loadLibraryWidth,
  saveLibraryWidth,
} from "../avail/libraryWidth";
import { brandIndexHtml } from "../../vite.avail";

describe("build flag", () => {
  it("is on only for VITE_AVAIL=1/true", () => {
    expect(isAvailBuild({ VITE_AVAIL: "1" })).toBe(true);
    expect(isAvailBuild({ VITE_AVAIL: "true" })).toBe(true);
    expect(isAvailBuild({ VITE_AVAIL: "0" })).toBe(false);
    expect(isAvailBuild({ VITE_AVAIL: "" })).toBe(false);
    expect(isAvailBuild({})).toBe(false);
  });
});

describe("branding", () => {
  it("tab title names AVAIL Schematic in our build and stays upstream otherwise", () => {
    expect(appDocumentTitle("Room 101", true)).toBe("Room 101 — AVAIL Schematic");
    expect(appDocumentTitle("", true)).toBe(AVAIL_APP_NAME);
    expect(appDocumentTitle("Room 101", false)).toBe("Room 101 — EasySchematic");
    expect(appDocumentTitle("", false)).toBe("EasySchematic — AV Signal Flow Diagram Tool");
  });

  it("links the source of the running commit, or the repository", () => {
    expect(sourceUrlFor("7ba200f")).toBe(`${FORK_SOURCE_URL}/tree/7ba200f`);
    expect(sourceUrlFor("unknown")).toBe(FORK_SOURCE_URL);
    expect(sourceUrlFor(undefined)).toBe(FORK_SOURCE_URL);
  });

  it("documentation link only for an http(s) VITE_DOCS_URL", () => {
    expect(docsUrl({ VITE_DOCS_URL: "https://docs.example.com" })).toBe("https://docs.example.com");
    expect(docsUrl({ VITE_DOCS_URL: "javascript:alert(1)" })).toBeNull();
    expect(docsUrl({})).toBeNull();
  });

  it("rewrites index.html: title, favicon, no public-site SEO tags", () => {
    const html = readFileSync("index.html", "utf-8");
    const out = brandIndexHtml(html);
    expect(out).toContain("<title>AVAIL Schematic</title>");
    expect(out).toContain('href="/avail/favicon-64.png"');
    expect(out).toContain('href="/avail/apple-touch-icon-180x180.png"');
    expect(out).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(out).not.toContain("easyschematic.live");
    expect(out).not.toContain("EasySchematic"); // the theme script keeps its localStorage key
    expect(out).not.toContain("og:");
    expect(out).not.toContain("twitter:");
    expect(out).not.toContain("google-site-verification");
    expect(out).not.toContain("application/ld+json");
    // The app still mounts.
    expect(out).toContain('<div id="root"></div>');
    expect(out).toContain('src="/src/main.tsx"');
  });

  it("ships the logo and icons it references", () => {
    for (const f of ["avail-logo.png", "avail-logo-white.png", "avail-mark.png", "favicon-64.png", "apple-touch-icon-180x180.png", "pwa-192x192.png", "pwa-512x512.png"]) {
      expect(readFileSync(`public/avail/${f}`).length).toBeGreaterThan(0);
    }
  });
});

describe("menus without upstream cloud features", () => {
  it("Help: our docs when configured, About AVAIL Schematic, nothing from easyschematic.live", () => {
    const about = vi.fn();
    const withoutDocs = availHelpMenu(about, null);
    expect(withoutDocs.map((e) => (e.type === "item" ? e.label : "—"))).toEqual(["About AVAIL Schematic"]);
    const withDocs = availHelpMenu(about, "https://docs.example.com");
    expect(withDocs.map((e) => (e.type === "item" ? e.label : "—"))).toEqual([
      "Documentation ↗",
      "—",
      "About AVAIL Schematic",
    ]);
    const last = withDocs[2];
    if (last.type === "item") last.onClick();
    expect(about).toHaveBeenCalledOnce();
  });

  it("View: no Owned Gear", () => {
    expect(AVAIL_HIDDEN_VIEW_ITEMS.has("Show Owned Gear")).toBe(true);
  });

  it("Device Editor: no Submit to Community in our build", () => {
    const actions = ["save-user-template", "submit-community", "update-as-custom"];
    expect(availSaveActions(actions, true)).toEqual(["save-user-template", "update-as-custom"]);
    expect(availSaveActions(actions, false)).toEqual(actions);
  });
});

describe("sign-in gate", () => {
  const signedOut: SessionCheck = { kind: "signed-out" };
  const now = 1_700_000_000_000;

  it("opens the editor for a signed-in user", () => {
    const session: SessionCheck = { kind: "signed-in", user: { id: "u1", email: "a@b.c", name: "A" } };
    expect(decideGate({ session, search: "", lastRedirectAt: null, now })).toBe("app");
  });

  it("sends a signed-out visitor straight to Google", () => {
    expect(decideGate({ session: signedOut, search: "", lastRedirectAt: null, now })).toBe("redirect");
    expect(decideGate({ session: signedOut, search: "?fixture=test", lastRedirectAt: null, now })).toBe("redirect");
  });

  it("shows the sign-in screen when the API refused the sign-in", () => {
    expect(decideGate({ session: signedOut, search: "?error=domain_not_allowed", lastRedirectAt: null, now })).toBe("sign-in");
  });

  it("does not loop: back from Google and still signed out shows the screen", () => {
    expect(decideGate({ session: signedOut, search: "", lastRedirectAt: now - 5_000, now })).toBe("sign-in");
    expect(decideGate({ session: signedOut, search: "", lastRedirectAt: now - REDIRECT_LOOP_WINDOW_MS - 1, now })).toBe("redirect");
  });

  it("does not redirect when the API is unreachable", () => {
    expect(decideGate({ session: { kind: "unreachable" }, search: "", lastRedirectAt: null, now })).toBe("unreachable");
  });

  it("reads GET /auth/me: 200 signed in, 401 signed out, other errors unreachable", async () => {
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await fetchSession(reply(200, { id: "u1", email: "e@x", name: null }), "http://api")).toEqual({
      kind: "signed-in",
      user: { id: "u1", email: "e@x", name: null },
    });
    expect(await fetchSession(reply(401, { error: "Not authenticated" }), "http://api")).toEqual({ kind: "signed-out" });
    expect(await fetchSession(reply(502, {}), "http://api")).toEqual({ kind: "unreachable" });
    const failing = vi.fn(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await fetchSession(failing, "http://api")).toEqual({ kind: "unreachable" });
  });

  it("returns to the page the user asked for", () => {
    expect(googleSignInUrl("https://sch.example.com/s/abc?x=1", "https://sch.example.com/api")).toBe(
      "https://sch.example.com/api/auth/google/start?returnTo=https%3A%2F%2Fsch.example.com%2Fs%2Fabc%3Fx%3D1",
    );
  });

  it("names the user by Google name, else email", () => {
    expect(displayNameOf({ id: "1", email: "j.doe@x.com", name: "Jane Doe" })).toBe("Jane Doe");
    expect(displayNameOf({ id: "1", email: "j.doe@x.com", name: null })).toBe("j.doe@x.com");
    expect(displayNameOf(null)).toBe("");
  });
});

describe("new schematic defaults", () => {
  it("are off in upstream builds", () => {
    expect(availNewSchematicDefaults({ avail: false })).toBeNull();
  });

  it("palette: video magenta, Ethernet blue, Dante/AVB green, USB gray, analog orange, fiber gray dashed", () => {
    for (const s of ["hdmi", "hdbaset", "sdi", "displayport", "dvi"]) expect(AVAIL_SIGNAL_COLORS[s]).toBe("#aa00aa");
    expect(AVAIL_SIGNAL_COLORS.ethernet).toBe("#0055cc");
    expect(AVAIL_SIGNAL_COLORS.dante).toBe("#007700");
    expect(AVAIL_SIGNAL_COLORS.avb).toBe("#007700");
    expect(AVAIL_SIGNAL_COLORS.usb).toBe("#333333");
    expect(AVAIL_SIGNAL_COLORS["analog-audio"]).toBe("#cc6600");
    expect(AVAIL_SIGNAL_COLORS["speaker-level"]).toBe("#cc6600");
    expect(AVAIL_SIGNAL_COLORS.fiber).toBe("#808080");
    expect(AVAIL_SIGNAL_LINE_STYLES.fiber).toBe("dashed");
  });

  it("every colored signal is a built-in signal type", () => {
    for (const s of Object.keys(AVAIL_SIGNAL_COLORS)) expect(DEFAULT_SIGNAL_COLORS, s).toHaveProperty(s);
  });

  it("title block: AVAIL DISTRIBUTION, FZCO, the signed-in engineer, today; A3 landscape", () => {
    const d = availNewSchematicDefaults({
      avail: true,
      user: { id: "u1", email: "jane@x.com", name: "Jane Doe" },
      now: new Date(2026, 10, 5, 9, 30),
    })!;
    expect(d.state.titleBlock.company).toBe("AVAIL DISTRIBUTION, FZCO");
    expect(d.state.titleBlock.engineer).toBe("Jane Doe");
    expect(d.state.titleBlock.date).toBe("2026-11-05");
    expect(d.state.printPaperId).toBe("iso-a3");
    expect(d.state.printOrientation).toBe("landscape");
    expect(getPaperSize("iso-a3").label).toBe("A3");
  });

  it("title block layout shows the company on top of upstream's rows", () => {
    const layout = availTitleBlockLayout();
    const top = layout.cells.filter((c) => c.row === 0);
    expect(top).toHaveLength(1);
    expect(top[0].content).toEqual({ type: "field", field: "company" });
    expect(top[0].colSpan).toBe(layout.columns.length);
    expect(layout.rows).toHaveLength(7);
    expect(layout.rows.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const fields = layout.cells.map((c) => (c.content.type === "field" ? c.content.field : c.content.type));
    for (const f of ["showName", "venue", "designer", "engineer", "date", "drawingTitle", "pageNumber"]) expect(fields).toContain(f);
    expect(new Set(layout.cells.map((c) => c.id)).size).toBe(layout.cells.length);
  });

  it("local date, zero-padded", () => {
    expect(isoLocalDate(new Date(2026, 0, 2))).toBe("2026-01-02");
  });
});

describe("header color by category group", () => {
  const groups = [...new Set(TAXONOMY.categories.map((c) => c.group))];

  it("every taxonomy group except Other has a distinct color", () => {
    for (const g of groups.filter((g) => g !== "Other")) expect(GROUP_HEADER_COLORS, g).toHaveProperty([g]);
    expect(GROUP_HEADER_COLORS).not.toHaveProperty(["Other"]);
    expect(Object.keys(GROUP_HEADER_COLORS).every((g) => groups.includes(g))).toBe(true);
    const colors = Object.values(GROUP_HEADER_COLORS);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("colors are muted enough for white header text", () => {
    for (const [g, c] of Object.entries(GROUP_HEADER_COLORS)) expect(contrastingTextColor(c), g).toBe("#ffffff");
  });

  it("finds the group of a category path", () => {
    expect(groupOfCategory("AV distribution / Extenders")).toBe("AV distribution");
    expect(groupOfCategory("Audio Products / DSP")).toBe("Audio Products");
    expect(groupOfCategory("Networking")).toBeUndefined(); // upstream category name, not a path
    expect(groupOfCategory("Processing")).toBeUndefined();
    expect(groupOfCategory("networking / something new")).toBe("Networking");
    expect(groupOfCategory("Sources")).toBeUndefined(); // upstream category
    expect(groupOfCategory(undefined)).toBeUndefined();
  });

  it("template color > group color; upstream builds have no group colors", () => {
    expect(groupHeaderColor("Displays / Monitors", true)).toBe(GROUP_HEADER_COLORS.Displays);
    expect(groupHeaderColor("Displays / Monitors", false)).toBeUndefined();
    expect(templateHeaderColor({ headerColor: "#123456", category: "Displays / Monitors" }, true)).toBe("#123456");
    expect(templateHeaderColor({ headerColor: "junk", category: "Displays / Monitors" }, true)).toBe(GROUP_HEADER_COLORS.Displays);
    expect(templateHeaderColor({ category: "Displays / Monitors" }, true)).toBe(GROUP_HEADER_COLORS.Displays);
    expect(templateHeaderColor({ category: "Other / Generic" }, true)).toBeUndefined();
    expect(templateHeaderColor({ category: "Displays / Monitors" }, false)).toBeUndefined();
  });
});

describe("library panel width", () => {
  it("stays within reasonable bounds and half the window", () => {
    expect(clampLibraryWidth(50)).toBe(LIBRARY_WIDTH_MIN);
    expect(clampLibraryWidth(5000)).toBe(LIBRARY_WIDTH_MAX);
    expect(clampLibraryWidth(300.4)).toBe(300);
    expect(clampLibraryWidth(500, 800)).toBe(400);
    expect(clampLibraryWidth(500, 300)).toBe(LIBRARY_WIDTH_MIN);
    expect(clampLibraryWidth(Number.NaN)).toBe(LIBRARY_WIDTH_DEFAULT);
  });

  it("is remembered per user", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      expect(loadLibraryWidth("u1")).toBe(LIBRARY_WIDTH_DEFAULT);
      saveLibraryWidth(360, "u1");
      saveLibraryWidth(9999, "u2");
      expect(store.get(libraryWidthKey("u1"))).toBe("360");
      expect(loadLibraryWidth("u1")).toBe(360);
      expect(loadLibraryWidth("u2")).toBe(LIBRARY_WIDTH_MAX);
      expect(loadLibraryWidth("u3")).toBe(LIBRARY_WIDTH_DEFAULT);
      store.set(libraryWidthKey("u3"), "garbage");
      expect(loadLibraryWidth("u3")).toBe(LIBRARY_WIDTH_DEFAULT);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
