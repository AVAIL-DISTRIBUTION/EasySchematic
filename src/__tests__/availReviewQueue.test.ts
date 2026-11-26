/**
 * Review queue (src/avail/reviewQueue.ts) and the v0.9 room-mounted rule by name and description
 * (src/avail/blockLint.ts mountedByName).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRoomMounted, lintBlock, mountedByName } from "../avail/blockLint";
import { lintRule, proposalFor, reasonsOf, reviewQueue, formatReviewQueue, type QueueItem } from "../avail/reviewQueue";

const here = path.dirname(fileURLToPath(import.meta.url));
const dtp3 = () => JSON.parse(readFileSync(path.join(here, "../../library/avail/extron-dtp3-t-203.json"), "utf8")) as Record<string, unknown>;

describe("room-mounted by name and description (v0.9)", () => {
  it("mounting words in the label, shortName or catalog description; Extron Decorator-Style ' D'", () => {
    const yes = [
      { label: "Extron DTP3 T 322 D (Black)", manufacturer: "Extron" },
      { label: "Extron DTP3 R 201 D, White", manufacturer: "Extron" },
      { label: "Extron NBP 106 D", manufacturer: "Extron" },
      { label: "Extron HDMI AAP", manufacturer: "Extron" },
      { label: "Extron Cable Cubby 1202", manufacturer: "Extron" },
      { label: "Extron X", manufacturer: "Extron", _avail: { description: "4K/60 DTP3 Transmitter – Decorator-Style Wallplate" } },
      { label: "Biamp Desono In-Ceiling Sub", manufacturer: "Biamp" },
      { label: "Extron Under-Table Box", manufacturer: "Extron" },
    ];
    for (const b of yes) expect(mountedByName(b), b.label).toBe(true);
    const no = [
      { label: "Extron DTP3 T 203", manufacturer: "Extron" },
      { label: "Extron DMP 128 Plus C AT", manufacturer: "Extron" },
      { label: "Biamp Device D", manufacturer: "Biamp" }, // " D" is Extron's convention only
      { label: "Extron Retractable Cable", manufacturer: "Extron" },
      { label: "Extron SMP 352 3G-SDI - 400 GB SSD", manufacturer: "Extron" },
    ];
    for (const b of no) expect(mountedByName(b), b.label).toBe(false);
  });

  it("rackForm still wins; a room-mounted name drops the dimensions requirement only", () => {
    expect(isRoomMounted({ label: "Extron DTP3 T 322 D", manufacturer: "Extron", rackForm: "half" })).toBe(false);
    const t = { ...dtp3(), label: "Extron DTP3 T 203 D", heightMm: undefined, weightKg: undefined };
    expect(lintBlock(t).warnings.filter((w) => /^no (height|weight)/.test(w))).toEqual([]);
    expect(lintBlock({ ...t, label: "Extron DTP3 T 203" }).warnings).toContain("no heightMm");
  });
});

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: "x", label: "Extron X", manufacturer: "Extron", deviceType: "switcher", category: "", level: "B",
  warnings: [], origin: { origin: "manufacturer", kind: "stencil" }, where: "extron/x.json", ...over,
});

describe("review queue", () => {
  it("lint rules without port names; reasons: rules for B, source for A", () => {
    expect(lintRule('"HDMI Output 1 (Buffered Mirror)": label longer than 28 characters')).toBe("label longer than 28 characters");
    expect(lintRule('"X": section "Rear" is not in the vocabulary; use "Video Inputs"')).toBe("section … is not in the vocabulary");
    expect(reasonsOf(item({ warnings: ["no weightKg", '"A": label in all caps', '"B": label in all caps'] })).map((r) => r.reason)).toEqual(["no weightKg", "label in all caps"]);
    expect(reasonsOf(item({ level: "A", origin: { origin: "community", kind: "db" } }))).toEqual([{ reason: "db", kind: "source" }]);
    expect(reasonsOf(item({ level: "A", origin: { origin: "community", kind: "variant", via: { file: "f", kind: "db" } } }))[0].reason).toBe("variant of db");
    expect(reasonsOf(item({ level: "A", origin: { origin: "none" } }))[0].reason).toBe("no source");
  });

  it("groups by reason with counts, 'only', families, examples and a proposal", () => {
    const r = reviewQueue([
      item({ id: "1", label: "Extron DTP3 T 1", warnings: ["no weightKg"] }),
      item({ id: "2", label: "Extron DTP3 T 2", warnings: ["no weightKg", "no searchTerms"] }),
      item({ id: "3", label: "Biamp Voltera D 1", manufacturer: "Biamp", level: "A", origin: { origin: "community", kind: "db" } }),
    ]);
    expect(r.total).toBe(3);
    expect(r.byLevel).toEqual({ A: 1, B: 2 });
    const w = r.groups.find((g) => g.reason === "no weightKg")!;
    expect(w).toMatchObject({ kind: "lint", count: 2, only: 1, families: [["Extron dtp3", 2]], proposal: { kind: "data" } });
    expect(r.groups.find((g) => g.reason === "db")).toMatchObject({ kind: "source", count: 1, proposal: { kind: "manual" } });
    // Lint groups first, then sources.
    expect(r.groups.map((g) => g.kind)).toEqual(["lint", "lint", "source"]);
    const md = formatReviewQueue(r, { source: "test", date: "2026-11-26" });
    expect(md).toContain("| Level B | no weightKg | 2 | 1 |");
    expect(md).toContain("## Ports source: db (1)");
  });

  it("proposals: rule / data / manual", () => {
    expect(proposalFor("label in all caps").kind).toBe("rule");
    expect(proposalFor("no powerDrawW/voltage (or poeDrawW)").kind).toBe("data");
    expect(proposalFor("something new").kind).toBe("manual");
  });
});
