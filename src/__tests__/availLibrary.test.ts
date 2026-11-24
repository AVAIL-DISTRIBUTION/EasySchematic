/**
 * AVAIL library in the editor: mode detection from the API, statuses and badges,
 * "show unverified", taxonomy grouping, review checklist, unverified blocks in reports,
 * and the templateApi hook points (query, no bundled floor in AVAIL mode).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockStatus,
  getShowUnverified,
  isAvailLibrary,
  libraryQuery,
  noteCachedLibrary,
  noteLibraryResponse,
  notifyLibraryChanged,
  onLibraryChanged,
  resetForTests,
  setRole,
  setShowUnverified,
  statusBadge,
  statusOfTemplate,
} from "../avail/libraryMode";
import { groupByTaxonomy, REVIEW_CHECKLIST, UNCATEGORIZED_GROUP, unverifiedBlocks } from "../avail/libraryView";
import type { DeviceTemplate } from "../types";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    dump: () => Object.fromEntries(m),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
  resetForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const tpl = (id: string, availStatus?: string, category?: string) =>
  ({ id, label: id, deviceType: "switcher", category, ports: [], ...(availStatus && { availStatus }) }) as unknown as DeviceTemplate;
const avail = (data: DeviceTemplate[]) =>
  noteLibraryResponse(new Response("[]", { headers: { "X-Avail-Library": "1" } }), data);

describe("libraryMode", () => {
  it("turns on from the X-Avail-Library header and remembers it; off against upstream", () => {
    expect(isAvailLibrary()).toBe(false);
    avail([]);
    expect(isAvailLibrary()).toBe(true);
    expect(storage.dump()["avail.library"]).toBe("1");
    resetForTests(); // next page load
    expect(isAvailLibrary()).toBe(true);
    noteLibraryResponse(new Response("[]"), []);
    expect(isAvailLibrary()).toBe(false);
    expect(storage.dump()["avail.library"]).toBeUndefined();
  });

  it("block status: from the loaded library; not listed → raw; nothing outside AVAIL or before loading", () => {
    expect(blockStatus("a")).toBeNull();
    avail([tpl("a", "verified"), tpl("b", "draft")]);
    expect(blockStatus("a")).toBe("verified");
    expect(blockStatus("b")).toBe("draft");
    expect(blockStatus("zzz")).toBe("raw");
    expect(blockStatus(undefined)).toBeNull();
    noteLibraryResponse(new Response("[]"), [tpl("a", "verified")]);
    expect(blockStatus("zzz")).toBeNull();
  });

  it("cached library fallback keeps statuses in AVAIL mode", () => {
    avail([]);
    noteCachedLibrary([tpl("c", "hidden")]);
    expect(blockStatus("c")).toBe("hidden");
  });

  it("badges: verified none, then Draft / Unverified / Hidden", () => {
    expect(statusBadge("verified")).toBeNull();
    expect(statusBadge("draft")).toBe("Draft");
    expect(statusBadge("raw")).toBe("Unverified");
    expect(statusBadge("hidden")).toBe("Hidden");
    expect(statusBadge(null)).toBeNull();
    expect(statusOfTemplate(tpl("x", "draft"))).toBe("draft");
    expect(statusOfTemplate(tpl("x", "bogus"))).toBeNull();
  });

  it("show unverified: off by default, remembered, adds include=raw (and hidden for moderators)", () => {
    expect(getShowUnverified()).toBe(false);
    expect(libraryQuery()).toBe("");
    const reload = vi.fn();
    onLibraryChanged(reload);
    setShowUnverified(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(libraryQuery()).toBe("?include=raw");
    setRole("moderator");
    expect(reload).toHaveBeenCalledTimes(2); // moderators now get hidden too
    expect(libraryQuery()).toBe("?include=raw,hidden");
    setRole("contributor");
    expect(libraryQuery()).toBe("?include=raw");
    resetForTests();
    expect(getShowUnverified()).toBe(true);
    setShowUnverified(false);
    expect(storage.dump()["avail.library.showUnverified"]).toBeUndefined();
  });

  it("works without localStorage (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    });
    resetForTests();
    expect(() => setShowUnverified(true)).not.toThrow();
    expect(getShowUnverified()).toBe(true);
  });

  it("notifyLibraryChanged calls every registered reload", () => {
    const a = vi.fn();
    const off = onLibraryChanged(a);
    notifyLibraryChanged();
    off();
    notifyLibraryChanged();
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe("groupByTaxonomy", () => {
  it("group → subcategory in taxonomy order; the rest under Uncategorized", () => {
    const groups = groupByTaxonomy([
      { label: "Audio Products / DSP", templates: ["dsp"] },
      { label: "AV distribution / Extenders", templates: ["ext"] },
      { label: "AV distribution / AVoIP", templates: ["ip"] },
      { label: "Connectivity / Bulk Cables", templates: ["cable"] },
      { label: "Other", templates: ["none"] },
      { label: "Video", templates: [] },
    ]);
    expect(groups.map((g) => [g.group, g.sections.map((s) => `${s.label}:${s.templates.join()}`)])).toEqual([
      ["AV distribution", ["AVoIP:ip", "Extenders:ext"]],
      ["Audio Products", ["DSP:dsp"]],
      [UNCATEGORIZED_GROUP, ["Connectivity / Bulk Cables:cable", "—:none"]],
    ]);
  });
});

describe("REVIEW_CHECKLIST", () => {
  it("is the engineer checklist of the standard, word for word", () => {
    const md = readFileSync(fileURLToPath(new URL("../../docs/avail/device-block-standard.md", import.meta.url)), "utf8");
    const items = [...md.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1].trim());
    expect([...REVIEW_CHECKLIST]).toEqual(items);
  });
});

describe("unverifiedBlocks", () => {
  it("raw and hidden device blocks; verified, draft, non-devices and blocks without a template are fine", () => {
    const statuses: Record<string, "verified" | "draft" | "raw" | "hidden"> = { v: "verified", d: "draft", r: "raw", h: "hidden" };
    const nodes = [
      { id: "1", type: "device", data: { templateId: "v", label: "TX 1" } },
      { id: "2", type: "device", data: { templateId: "d", label: "DSP" } },
      { id: "3", type: "device", data: { templateId: "r", label: "Camera" } },
      { id: "4", type: "device", data: { templateId: "h", label: "Old" } },
      { id: "5", type: "room", data: { templateId: "r", label: "Room" } },
      { id: "6", type: "device", data: { label: "Custom" } },
    ];
    expect(unverifiedBlocks(nodes, (id) => (id ? statuses[id] : null))).toEqual([
      { nodeId: "3", label: "Camera", status: "raw" },
      { nodeId: "4", label: "Old", status: "hidden" },
    ]);
  });

  it("nothing outside AVAIL mode", () => {
    expect(unverifiedBlocks([{ id: "1", type: "device", data: { templateId: "r" } }])).toEqual([]);
  });
});

describe("templateApi hook points", () => {
  async function load(headers: Record<string, string>, body: unknown[]) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { headers }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const api = await import("../templateApi");
    const mode = await import("../avail/libraryMode");
    // fetchTemplates also loads GET /types once; only the library requests matter here.
    const libraryCalls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0])).filter((u) => /\/templates/.test(u));
    return { api, mode, fetchMock, libraryCalls };
  }

  it("AVAIL API: asks with the status query, lists exactly what came back (no bundled floor)", async () => {
    storage.setItem("avail.library.showUnverified", "1");
    const { api, libraryCalls } = await load({ "X-Avail-Library": "1" }, [tpl("only-one", "raw")]);
    const list = await api.fetchTemplates();
    expect(libraryCalls()).toEqual([expect.stringMatching(/\/templates\?include=raw$/)]);
    expect(list.map((t) => t.id)).toEqual(["only-one"]);
    // Lookups by id still see the bundled library (existing schematics, slot cards).
    const bundledId = api.getBundledTemplates().find((t) => t.id)!.id!;
    expect(api.getTemplateById(bundledId)?.id).toBe(bundledId);
  });

  it("upstream API: unchanged — no query, bundled floor under the API answer", async () => {
    const { api, libraryCalls } = await load({}, [tpl("only-one")]);
    const list = await api.fetchTemplates();
    expect(libraryCalls()).toEqual([expect.stringMatching(/\/templates$/)]);
    expect(list.length).toBeGreaterThan(1);
  });

  it("invalidateTemplates makes the next fetchTemplates ask again", async () => {
    const { api, libraryCalls } = await load({ "X-Avail-Library": "1" }, []);
    await api.fetchTemplates();
    await api.fetchTemplates();
    expect(libraryCalls()).toHaveLength(1);
    api.invalidateTemplates();
    await api.fetchTemplates();
    expect(libraryCalls()).toHaveLength(2);
  });
});
