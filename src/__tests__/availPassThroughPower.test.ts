/**
 * Pass-through power (`_avail.passThroughPower`, src/avail/passThroughPower.ts): shape check for
 * avail:check-library and the reader for a future power total; the Shure cards that carry it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { passThroughPowerOf, passThroughPowerProblems } from "../avail/passThroughPower";

describe("passThroughPowerProblems", () => {
  it("absent or {enabled: true, powers} is fine", () => {
    expect(passThroughPowerProblems({})).toEqual([]);
    expect(passThroughPowerProblems({ passThroughPower: { enabled: true, powers: "DC Out 1-4 to receivers" } })).toEqual([]);
  });
  it("anything else is reported", () => {
    expect(passThroughPowerProblems({ passThroughPower: true })).toHaveLength(1);
    expect(passThroughPowerProblems({ passThroughPower: { enabled: false, powers: "x" } })).toEqual(["_avail.passThroughPower.enabled must be true"]);
    expect(passThroughPowerProblems({ passThroughPower: { enabled: true, powers: " " } })).toEqual(["_avail.passThroughPower.powers must name what it powers"]);
    expect(passThroughPowerProblems({ passThroughPower: { enabled: true, powers: "x", watts: 5 } })).toEqual(["_avail.passThroughPower: unknown field watts"]);
  });
  it("passThroughPowerOf reads a valid field only", () => {
    expect(passThroughPowerOf({ passThroughPower: { enabled: true, powers: "bias" } })).toEqual({ enabled: true, powers: "bias" });
    expect(passThroughPowerOf({ passThroughPower: { enabled: true } })).toBeNull();
    expect(passThroughPowerOf(undefined)).toBeNull();
  });
});

describe("catalog: UA844+, PA411, UABIAST carry pass-through power (all variants)", () => {
  const dir = join(__dirname, "../../library/catalog/shure");
  const cards = readdirSync(dir).map((f) => ({ f, d: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
  it("every UA844+ / PA411 / UABIAST card has it with powerDrawW; no other Shure card does", () => {
    const want = /^(UA844\+|PA411|UABIAST)/;
    const withIt = cards.filter(({ d }) => d._avail?.passThroughPower).map(({ d }) => d.modelNumber).sort();
    const models = cards.filter(({ d }) => want.test(d.modelNumber)).map(({ d }) => d.modelNumber).sort();
    expect(models.length).toBeGreaterThanOrEqual(6);
    expect(withIt).toEqual(models);
    for (const { d } of cards.filter(({ d }) => want.test(d.modelNumber))) expect(d.powerDrawW, d.modelNumber).toBeGreaterThan(0);
  });
});
