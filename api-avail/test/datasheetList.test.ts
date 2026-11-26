/**
 * Data sheets to download (src/avail/datasheetList.ts) and the .xlsx writer (xlsxWrite.ts).
 */
import { describe, expect, it } from "vitest";
import type { CatalogFile } from "../../src/avail/catalogPorts";
import { communityCards, datasheetGroups, datasheetRows, familyOf, formatDatasheetList } from "../../src/avail/datasheetList";
import { readXlsx } from "../src/xlsx";
import { writeXlsx } from "../src/xlsxWrite";

const card = (file: string, label: string, pn: string, url: string, portsSource?: Record<string, unknown>): CatalogFile => ({
  file,
  template: {
    id: `id-${pn}`, label, manufacturer: label.split(" ")[0], modelNumber: pn, deviceType: "x", referenceUrl: url, ports: [{ id: "1" }],
    _avail: { status: "ports-filled", ...(portsSource ? { portsSource } : {}) },
  } as never,
});

describe("datasheet list", () => {
  const files = [
    card("extron/ca-163-lp-black.json", "Extron CA 163 LP (Black)", "42-1", "https://www.extron.com/product/ca163", { kind: "db" }),
    card("extron/ca-163-lp-white.json", "Extron CA 163 LP (White)", "42-2", "https://www.extron.com/product/ca163", { kind: "variant", from: "extron/ca-163-lp-black.json" }),
    card("extron/ca-163-pt-black.json", "Extron CA 163 PT (Black)", "42-3", "https://www.extron.com/product/ca163/", { kind: "db" }),
    card("extron/fox3-t-301-mm.json", "Extron FOX3 T 301 (MM)", "60-1", "https://www.extron.com/product/fox3t301", { kind: "db" }),
    card("extron/fox3-t-301-sm.json", "Extron FOX3 T 301 (SM)", "60-2", "https://www.extron.com/product/fox3t301sm", { kind: "db" }),
    card("extron/dtp3-t-203.json", "Extron DTP3 T 203", "60-3", "https://www.extron.com/product/dtp3t203", { kind: "stencil" }),
    card("biamp/x.json", "Biamp Parlé VBC 2800", "911", "https://www.biamp.com/x", { kind: "datasheet", from: "biamp/x.pdf" }),
  ];

  it("only community ports: db, and variants of db", () => {
    expect(communityCards(files).map((f) => f.file)).toEqual(files.slice(0, 5).map((f) => f.file));
  });

  it("one group per product page or model without the variant; most cards first", () => {
    const g = datasheetGroups(files);
    expect(g.map((x) => [x.family, x.cards, x.partNumbers])).toEqual([
      ["CA", 3, ["42-1", "42-2", "42-3"]], // same page (trailing slash ignored)
      ["FOX3", 2, ["60-1", "60-2"]], // two pages, one model without MM / SM
    ]);
    expect(g[1].pages).toEqual(["https://www.extron.com/product/fox3t301", "https://www.extron.com/product/fox3t301sm"]);
    const md = formatDatasheetList(g, "2026-11-26");
    expect(md).toContain("**5** cards, **2** documents");
    expect(md).toContain("| Extron | CA | CA 163 LP (Black); CA 163 LP (White); CA 163 PT (Black) | 42-1, 42-2, 42-3 | [extron.com/product/ca163]");
  });

  it("family as written: words up to the first with a digit, a digit word alone", () => {
    expect(familyOf({ label: "Extron Cable Cubby 100 EU AC", manufacturer: "Extron" })).toBe("Cable Cubby");
    expect(familyOf({ label: "Extron FOX3 Matrix 24x", manufacturer: "Extron" })).toBe("FOX3");
    expect(familyOf({ label: "Extron AC+USB 212 UK", manufacturer: "Extron" })).toBe("AC+USB");
    expect(familyOf({ label: "Biamp TesiraFORTÉ AVB VT4", manufacturer: "Biamp" })).toBe("TesiraFORTÉ AVB");
  });

  it("the xlsx reads back: header, rows, numbers stay numbers", () => {
    const rows = datasheetRows(datasheetGroups(files));
    const buf = writeXlsx("Data sheets", ["Vendor", "Family", "Models", "Part numbers", "Product page", "Cards it closes"], rows, [10, 10, 40, 30, 40, 8]);
    const sheet = [...readXlsx(buf).values()][0];
    expect(sheet[0]).toEqual(["Vendor", "Family", "Models", "Part numbers", "Product page", "Cards it closes"]);
    expect(sheet[1].slice(0, 2)).toEqual(["Extron", "CA"]);
    expect(sheet[1][5]).toBe("3");
    expect(sheet).toHaveLength(3);
  });
});
