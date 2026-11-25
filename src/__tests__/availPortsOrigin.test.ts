/**
 * Ports origin (src/avail/portsOrigin.ts) and the moderator's library filter by it
 * (src/avail/libraryMode.ts): manufacturer / community / none, and the review queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterByPortsOrigin,
  getPortsFilter,
  noteLibraryResponse,
  resetForTests,
  setPortsFilter,
  setRole,
} from "../avail/libraryMode";
import { catalogIndex, describeOrigin, parseCatalogMeta, portsOrigin, type CatalogMeta } from "../avail/portsOrigin";
import type { DeviceTemplate } from "../types";

describe("portsOrigin", () => {
  const files = catalogIndex([
    { file: "extron/a.json", portsSource: { kind: "stencil", from: "DTP.vssx" } },
    { file: "extron/b.json", portsSource: { kind: "db", from: "id-1" } },
    null,
  ]);
  const cat = (portsSource?: CatalogMeta["portsSource"]): { source: string; catalog: CatalogMeta } => ({
    source: "avail-catalog",
    catalog: { file: "extron/x.json", ...(portsSource ? { portsSource } : {}) },
  });

  it("manufacturer: stencil, datasheet, library; the curated library itself", () => {
    expect(portsOrigin(cat({ kind: "stencil", from: "DTP.vssx" }), files)).toEqual({ origin: "manufacturer", kind: "stencil", from: "DTP.vssx" });
    expect(portsOrigin(cat({ kind: "datasheet", from: "https://x" }), files).origin).toBe("manufacturer");
    expect(portsOrigin(cat({ kind: "library" }), files).origin).toBe("manufacturer");
    expect(portsOrigin({ source: "avail-library" }, files)).toEqual({ origin: "manufacturer", kind: "library" });
  });

  it("community: db, easyschematic.live; none: nothing recorded", () => {
    expect(portsOrigin(cat({ kind: "db", from: "id" }), files).origin).toBe("community");
    expect(portsOrigin({ source: "easyschematic.live" }, files)).toEqual({ origin: "community", kind: "upstream" });
    expect(portsOrigin(cat(), files).origin).toBe("none");
    expect(portsOrigin({ source: null }, files).origin).toBe("none");
  });

  it("a variant takes the origin of the file it copied", () => {
    const v = portsOrigin(cat({ kind: "variant", from: "extron/a.json" }), files);
    expect(v).toEqual({ origin: "manufacturer", kind: "variant", from: "DTP.vssx", via: { file: "extron/a.json", kind: "stencil" } });
    expect(describeOrigin(v)).toBe("stencil (DTP.vssx) via variant extron/a.json");
    expect(portsOrigin(cat({ kind: "variant", from: "extron/b.json" }), files).origin).toBe("community");
    expect(portsOrigin(cat({ kind: "variant", from: "extron/missing.json" }), files).origin).toBe("none");
  });

  it("parseCatalogMeta tolerates null and broken JSON", () => {
    expect(parseCatalogMeta(null)).toBeNull();
    expect(parseCatalogMeta("{")).toBeNull();
    expect(parseCatalogMeta('{"file":"a"}')).toEqual({ file: "a" });
  });
});

describe("library filter by ports origin", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    resetForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  const t = (id: string, availStatus: string, availPortsOrigin?: string, availLevel?: string) =>
    ({ id, label: id, ports: [], availStatus, ...(availPortsOrigin ? { availPortsOrigin } : {}), ...(availLevel ? { availLevel } : {}) }) as unknown as DeviceTemplate;
  const list = [t("m", "draft", "manufacturer", "A"), t("c-b", "draft", "community", "B"), t("c-a", "draft", "community", "A"), t("c-v", "verified", "community", "B"), t("n", "draft")];
  const ids = (l: readonly DeviceTemplate[]) => l.map((x) => x.id);

  it("filters only for moderators in AVAIL mode; remembered in the browser", () => {
    noteLibraryResponse(new Response("[]", { headers: { "X-Avail-Library": "1" } }), list);
    setPortsFilter("community");
    expect(ids(filterByPortsOrigin(list))).toEqual(ids(list)); // not a moderator
    setRole("moderator");
    expect(ids(filterByPortsOrigin(list))).toEqual(["c-b", "c-a", "c-v"]);
    expect(ids(filterByPortsOrigin(list, "manufacturer"))).toEqual(["m"]);
    expect(ids(filterByPortsOrigin(list, "none"))).toEqual(["n"]);
    expect(ids(filterByPortsOrigin(list, "review"))).toEqual(["c-b"]);
    resetForTests();
    expect(getPortsFilter()).toBe("community");
  });
});
