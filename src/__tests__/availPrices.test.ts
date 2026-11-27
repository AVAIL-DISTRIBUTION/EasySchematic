/**
 * src/avail/prices.ts — no prices in the public repository.
 */
import { describe, expect, it } from "vitest";
import { checkCatalog, checkLibraryFile } from "../avail/libraryFiles";
import { isPriceKey, priceFields, withoutPrices } from "../avail/prices";

describe("price fields", () => {
  it("recognises price keys and nothing else", () => {
    for (const k of ["unitCost", "msrp", "MSRP (USD)", "price", "listPrice", "dealer_cost", "unit cost"]) expect(isPriceKey(k), k).toBe(true);
    for (const k of ["powerDrawW", "poeBudgetW", "source", "portsSource", "description", "costume"]) expect(isPriceKey(k), k).toBe(false);
  });

  it("finds nested price fields and removes them", () => {
    const t = { id: "x", unitCost: 10, _avail: { msrp: 5, note: "Price list weight" }, ports: [{ id: "p1", price: 1 }] };
    expect(priceFields(t)).toEqual(["unitCost", "_avail.msrp", "ports[0].price"]);
    expect(withoutPrices(t)).toEqual({ id: "x", _avail: { note: "Price list weight" }, ports: [{ id: "p1" }] });
  });

  it("avail:check-library fails on a price in the catalog and in library/avail", () => {
    const card = { id: "avail-biamp-1", label: "Biamp X", manufacturer: "Biamp", modelNumber: "1", ports: [], _avail: { status: "awaiting-ports" }, unitCost: 100 };
    const r = checkCatalog([{ file: "biamp/biamp-x.json", template: card }]);
    expect(r.ok).toBe(false);
    expect(r.files[0].problems).toContain("price fields are not allowed in the repository: unitCost");
    const { unitCost: _u, ...clean } = card;
    expect(checkCatalog([{ file: "biamp/biamp-x.json", template: clean }]).ok).toBe(true);
    expect(checkLibraryFile({ file: "biamp-x.json", template: card }, false).problems).toContain("price fields are not allowed in the repository: unitCost");
  });
});
