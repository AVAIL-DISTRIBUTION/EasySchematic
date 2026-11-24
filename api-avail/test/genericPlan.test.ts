/**
 * Generic vendor review (docs/avail/generic-plan.json, src/genericPlan.ts): the plan file
 * itself, renames and deletes in one transaction, the curated library untouched, dry run,
 * idempotency, and import:upstream neither re-imports deleted ids nor overwrites renamed rows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { genericModelNumber } from "../../src/avail/blockLint";
import { findCategory } from "../../src/avail/library";
import { applyGenericPlan, formatGenericPlanReport, GENERIC_PLAN, type GenericPlan } from "../src/genericPlan";
import { AVAIL_LIBRARY_SOURCE } from "../src/importAvail";
import { importTemplates } from "../src/importUpstream";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";

describe("docs/avail/generic-plan.json", () => {
  const renames = GENERIC_PLAN.templates.filter((e) => e.action === "rename") as Extract<GenericPlan["templates"][number], { action: "rename" }>[];

  it("unique ids; every rename is \"Generic <…>\" with a unique label and GEN code", () => {
    const ids = GENERIC_PLAN.templates.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of renames) expect(e.label, e.was).toMatch(/^Generic \S/);
    const labels = renames.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    const codes = labels.map(genericModelNumber);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("no brand names in the new labels; categories are leaves of the taxonomy", () => {
    const brands = /\b(ecler|wyrestorm|logitech|samsung|novastar|displaylink|decklink|zoom|elc|apple|l-acoustics|regv)\b/i;
    for (const e of renames) {
      expect(e.label, e.was).not.toMatch(brands);
      if (e.category) expect(findCategory(e.category)?.leaf, e.category).toBe(true);
    }
  });

  it("power adapters and SD cards go to schematic=false categories", () => {
    const nonSchematic = renames.filter((e) => e.category && findCategory(e.category)?.schematic === false).map((e) => e.label);
    expect(nonSchematic).toEqual(expect.arrayContaining(["Generic 13A to IEC Adapter (UK/EU)", "Generic SDHC Card (32 GB)", "Generic Edison to IEC Adapter (NA)"]));
  });

  it("deletes carry a reason; the curated Generic templates are not in the plan", () => {
    for (const e of GENERIC_PLAN.templates) if (e.action === "delete") expect(e.reason.length, e.was).toBeGreaterThan(10);
    const planned = new Set(GENERIC_PLAN.templates.map((e) => e.was));
    for (const l of ["Generic Mini PC", "Generic LED Cabinet", "Generic Audio DSP", "Generic Camera", "Generic Conference System"]) expect(planned.has(l)).toBe(false);
  });
});

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-generic-plan-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const POWER = { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };

function insert(id: string, over: Record<string, unknown> = {}, source?: string) {
  const row = templateToRow({ id, label: `Thing ${id}`, manufacturer: "Generic", deviceType: "switcher", category: "", ports: [POWER], ...over } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source, upstream_id) VALUES (?, 'raw', ?, ?)").run(id, source ?? "easyschematic.live", source ? null : id);
}
const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id) as Record<string, unknown> | undefined;

const plan: GenericPlan = {
  version: 1,
  templates: [
    { id: "melangeur", was: "Melangeur Video (Vision Switcher)", action: "rename", label: "Generic Vision Switcher", category: "Processing / Videomixers" },
    { id: "grille", was: "Grille de Brassage SDI 64x64", action: "rename", label: "Generic SDI Router 64x64", deviceType: "router" },
    { id: "ecler", was: "Generic Ecler AURA-4B300", action: "delete", reason: "Branded product filed under Generic" },
    { id: "lib", was: "Generic LED Cabinet", action: "delete", reason: "must be skipped: curated library" },
    { id: "gone", was: "Already gone", action: "delete", reason: "not in this database" },
  ],
};

describe("applyGenericPlan", () => {
  beforeEach(() => {
    insert("melangeur", { label: "Melangeur Video (Vision Switcher)", referenceUrl: "https://x.example", heightMm: 88, searchTerms: ["melangeur"] });
    insert("grille", { label: "Grille de Brassage SDI 64x64 (REGV-MATRIX)" });
    insert("ecler", { label: "Generic Ecler AURA-4B300", deviceType: "amplifier" });
    insert("lib", { label: "Generic LED Cabinet", deviceType: "led-cabinet" }, AVAIL_LIBRARY_SOURCE);
  });

  it("renames (id kept, GEN code, no links or brand physics), deletes, skips the curated library, reports missing", () => {
    const r = applyGenericPlan(api.db.sqlite, { plan });
    expect(row("melangeur")).toMatchObject({
      label: "Generic Vision Switcher", short_name: "Vision Switcher", model_number: "GEN-VISION-SWITCHER", manufacturer: "Generic",
      category: "Processing / Videomixers", reference_url: null, height_mm: null, version: 2,
    });
    expect(JSON.parse(row("melangeur")!.search_terms as string)).toEqual(["vision switcher", "switcher", "generic"]);
    expect(meta("melangeur")).toMatchObject({ source: "generic-plan", upstream_id: null, status_reason: 'generic-plan: was "Melangeur Video (Vision Switcher)"' });
    expect(row("grille")).toMatchObject({ label: "Generic SDI Router 64x64", device_type: "router", category: "AV distribution / Matrix Switchers" });
    expect(row("ecler")).toBeUndefined();
    expect(meta("ecler")).toBeUndefined();
    expect(row("lib")).toBeDefined();
    expect(r).toMatchObject({ genericBefore: 4, genericAfter: 3, missing: ["Already gone [gone]"], protectedSkipped: ["Generic LED Cabinet [lib]"] });
    const text = formatGenericPlanReport(r);
    expect(text).toContain("Generic templates: 4 → 3; renamed 2, unchanged 0, deleted 1");
    expect(text).toContain("Melangeur Video (Vision Switcher) → Generic Vision Switcher [melangeur]");
    expect(text).toContain("Generic Ecler AURA-4B300 [ecler]: Branded product filed under Generic");
  });

  it("dry run writes nothing; a second run changes nothing", () => {
    const before = api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all();
    expect(applyGenericPlan(api.db.sqlite, { plan, dryRun: true }).renamed).toHaveLength(2);
    expect(api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all()).toEqual(before);
    applyGenericPlan(api.db.sqlite, { plan });
    const after = api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all();
    expect(applyGenericPlan(api.db.sqlite, { plan })).toMatchObject({ renamed: [], unchanged: 2, deleted: [] });
    expect(api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all()).toEqual(after);
  });

  it("import:upstream neither brings back deleted ids nor overwrites renamed rows", () => {
    applyGenericPlan(api.db.sqlite, { plan });
    const source = [
      { id: "melangeur", deviceType: "switcher", label: "Melangeur Video (Vision Switcher)", manufacturer: "Generic", ports: [POWER] },
      { id: "ecler", deviceType: "amplifier", label: "Generic Ecler AURA-4B300", manufacturer: "Generic", ports: [POWER] },
    ];
    const r = importTemplates(api.db.sqlite, source, { planDeleted: new Set(["ecler"]) });
    expect(r.skipped.genericPlan).toBe(1);
    expect(r).toMatchObject({ inserted: 0, skippedProtected: 1 });
    expect(row("ecler")).toBeUndefined();
    expect(row("melangeur")!.label).toBe("Generic Vision Switcher");
  });
});
