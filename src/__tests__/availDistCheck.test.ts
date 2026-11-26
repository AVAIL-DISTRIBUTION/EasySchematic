/**
 * The AVAIL build without links to upstream's public services (step 2.5): the dist scanner,
 * the AVAIL Vite plugin's pieces, and the upstream addresses outside the AVAIL build.
 */
import { describe, expect, it } from "vitest";
import { AVAIL_DROPPED_PUBLIC, AVAIL_ROBOTS, stripUpstreamDocs } from "../../vite.avail";
import { ALLOWED_UPSTREAM, upstreamRefs } from "../avail/distCheck";
import { AVAIL_BUILD, DEFAULT_API_URL, DEFAULT_DEVICES_URL, UPSTREAM_DOCS_URL, UPSTREAM_SITE_URL } from "../avail/upstream";
import defaultSchematic from "../defaultSchematic.json";

describe("dist scanner", () => {
  it("finds upstream's services; only the upstream site on About is allowed", () => {
    const js = [
      'href:"https://devices.easyschematic.live/#/submit?draft="',
      'fetch(`https://api.easyschematic.live/templates`)',
      '"mailto:support@easyschematic.live"',
      'host==="www.easyschematic.live"',
      'label:"EasySchematic (upstream)",href:"https://easyschematic.live"',
    ].join(";");
    expect(upstreamRefs("App.js", js).map((h) => h.match)).toEqual([
      "https://devices.easyschematic.live/#/submit?draft=",
      "https://api.easyschematic.live/templates",
      "mailto:support@easyschematic.live",
      "www.easyschematic.live",
    ]);
    expect(upstreamRefs("robots.txt", AVAIL_ROBOTS)).toEqual([]);
  });

  it("the allowed address is the About link of upstream.ts", () => {
    expect(ALLOWED_UPSTREAM).toContain(UPSTREAM_SITE_URL);
  });
});

describe("AVAIL Vite plugin", () => {
  it("the welcome note loses upstream's docs line; public site files are dropped", () => {
    const json = JSON.stringify(defaultSchematic);
    expect(json).toContain("docs.easyschematic.live");
    const stripped = stripUpstreamDocs(json);
    expect(stripped).not.toContain("easyschematic.live");
    expect(() => JSON.parse(stripped)).not.toThrow();
    expect(AVAIL_DROPPED_PUBLIC).toEqual(["_headers", "sitemap.xml"]);
    expect(AVAIL_ROBOTS).toContain("Disallow: /");
  });
});

describe("upstream addresses outside the AVAIL build", () => {
  it("the upstream build (tests run without VITE_AVAIL) keeps upstream's defaults", () => {
    expect(AVAIL_BUILD).toBe(false);
    expect(DEFAULT_API_URL).toBe("https://api.easyschematic.live");
    expect(DEFAULT_DEVICES_URL).toBe("https://devices.easyschematic.live");
    expect(UPSTREAM_DOCS_URL).toBe("https://docs.easyschematic.live");
  });
});
