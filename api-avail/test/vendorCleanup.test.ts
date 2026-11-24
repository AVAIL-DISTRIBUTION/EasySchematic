/**
 * apply:vendor-decisions (src/vendorCleanup.ts): rename, scope, Generic folding without
 * duplicates, deleting undecided manufacturers and templates without one, the curated
 * library is never touched, dry run, report. Plus: a repeated import:upstream does not
 * bring back what the cleanup removed, and a saved schematic whose template was deleted
 * still opens.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateToRow } from "../../api/src/db";
import { importTemplates, type UpstreamTemplate } from "../src/importUpstream";
import { AVAIL_LIBRARY_SOURCE } from "../src/importAvail";
import { configFromEnv, createApiServer, type ApiServer } from "../src/server";
import { applyVendorDecisions, formatVendorCleanupReport } from "../src/vendorCleanup";

let dataDir: string;
let api: ApiServer;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "api-avail-vendors-"));
  api = createApiServer({ ...configFromEnv({ DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin-token-0123456789", SEED_LIBRARY: "off" }), log: () => {} });
});

afterEach(() => {
  api.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const POWER = { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };
const HDMI = { id: "h", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" };

function insert(id: string, over: Record<string, unknown> = {}, status?: string, source?: string) {
  const row = templateToRow({ id, label: `X ${id}`, deviceType: "display", category: "", ports: [POWER], ...over } as never);
  const cols = Object.keys(row);
  api.db.sqlite.prepare(`INSERT INTO templates (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  if (status) api.db.sqlite.prepare("INSERT INTO avail_template_meta (template_id, status, source) VALUES (?, ?, ?)").run(id, status, source ?? null);
}

const row = (id: string) => api.db.sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const meta = (id: string) => api.db.sqlite.prepare("SELECT * FROM avail_template_meta WHERE template_id = ?").get(id);
const count = () => (api.db.sqlite.prepare("SELECT COUNT(*) AS n FROM templates").get() as { n: number }).n;

describe("applyVendorDecisions", () => {
  it("renames to the canonical spelling", () => {
    insert("y", { manufacturer: "Yamaha Pro Audio" });
    insert("b", { manufacturer: "Bose" });
    insert("n", { manufacturer: "Netgear", deviceType: "network-switch", modelNumber: "GSM4230PX" });
    insert("ng", { manufacturer: "NETGEAR", label: "NETGEAR M4350-16V4C", deviceType: "network-switch", modelNumber: "VSM4320C" });
    insert("ws", { manufacturer: "WyreStorm", label: "WyreStorm NHD-500-TX", deviceType: "av-over-ip" });
    insert("ws-bare", { manufacturer: "WyreStorm", label: "NHD-400-RX", deviceType: "av-over-ip" });
    const r = applyVendorDecisions(api.db.sqlite);
    expect(row("y")).toMatchObject({ manufacturer: "Yamaha", version: 2 });
    expect(row("b")!.manufacturer).toBe("Bose Professional");
    expect(row("n")!.manufacturer).toBe("Netgear-AV");
    // The label follows when it starts with the old spelling; a label without the brand is left as it is.
    expect(row("ng")).toMatchObject({ manufacturer: "Netgear-AV", label: "Netgear-AV M4350-16V4C" });
    expect(row("ws")).toMatchObject({ manufacturer: "Wyrestorm", label: "Wyrestorm NHD-500-TX" });
    expect(row("ws-bare")).toMatchObject({ manufacturer: "Wyrestorm", label: "NHD-400-RX" });
    expect(r.renamed).toEqual(
      expect.arrayContaining([{ from: "Yamaha Pro Audio", to: "Yamaha", count: 1 }, { from: "Netgear", to: "Netgear-AV", count: 1 }, { from: "NETGEAR", to: "Netgear-AV", count: 1 }, { from: "WyreStorm", to: "Wyrestorm", count: 2 }]),
    );
  });

  it("scope: deletes Sony outside system cameras and Netgear-AV outside AV Line", () => {
    insert("s-cam", { manufacturer: "Sony", deviceType: "ptz-camera" });
    insert("s-tv", { manufacturer: "Sony", deviceType: "tv" }, "raw");
    insert("n-av", { manufacturer: "NETGEAR", deviceType: "network-switch", label: "NETGEAR M4350-16V4C", modelNumber: "VSM4320C" });
    insert("n-wifi", { manufacturer: "NETGEAR", deviceType: "access-point", label: "NETGEAR WAX610", modelNumber: "WAX610" });
    const r = applyVendorDecisions(api.db.sqlite);
    expect(r.scopeDeleted).toEqual({ Sony: 1, "Netgear-AV": 1 });
    expect(row("s-cam")).toBeDefined();
    expect(row("s-tv")).toBeUndefined();
    expect(meta("s-tv")).toBeUndefined();
    expect(row("n-av")).toBeDefined();
    expect(row("n-wifi")).toBeUndefined();
  });

  it("deletes undecided manufacturers and templates without one, templates and meta", () => {
    insert("jbl", { manufacturer: "JBL" }, "raw");
    insert("none", { manufacturer: undefined }, "hidden");
    insert("ext", { manufacturer: "Extron" });
    const r = applyVendorDecisions(api.db.sqlite);
    expect(r).toMatchObject({ dropped: { JBL: 1 }, noManufacturer: 1, deletedTotal: 2, before: 3, after: 1 });
    expect(row("jbl")).toBeUndefined();
    expect(meta("jbl")).toBeUndefined();
    expect(row("none")).toBeUndefined();
    expect(r.remainingByVendor).toEqual({ Extron: 1 });
  });

  it("generic: the most complete template per type becomes Generic <type> (same id), the rest go", () => {
    insert("sm-poor", { manufacturer: "Samsung", label: "Samsung A", ports: [] });
    insert("sm-rich", { manufacturer: "Samsung", label: "Samsung QM55C", modelNumber: "QM55C", referenceUrl: "https://samsung.com/qm55c", ports: [HDMI, POWER], heightMm: 700, searchTerms: ["samsung"] });
    insert("lg", { manufacturer: "Logitech", deviceType: "video-bar", label: "Logitech Rally Bar" });
    const r = applyVendorDecisions(api.db.sqlite);
    expect(r.genericCreated.map((g) => [g.id, g.label])).toEqual([["sm-rich", "Generic Display"], ["lg", "Generic Video Bar"]]);
    expect(row("sm-rich")).toMatchObject({
      manufacturer: "Generic", label: "Generic Display", short_name: "Display", model_number: "GEN-DISPLAY",
      reference_url: null, height_mm: null, category: "Displays / Standalone Displays",
    });
    expect(JSON.parse(row("sm-rich")!.search_terms as string)).not.toContain("samsung");
    expect(row("sm-poor")).toBeUndefined();
    expect(r.genericMerged).toEqual({ Samsung: 2, Logitech: 1 });
  });

  it("generic: an existing Generic is never overwritten; types that have one get no new Generic", () => {
    // Existing Generic templates, even poorer ones and product templates filed under Generic.
    insert("gen-mic", { manufacturer: "Generic", label: "Generic Microphone", deviceType: "wired-mic", ports: [] });
    insert("trolley-tv", { manufacturer: "Generic", label: "Trolley TV", deviceType: "tv", ports: [] });
    insert("lg-mic", { manufacturer: "Logitech", label: "Logitech Mic Pod", deviceType: "wired-mic", ports: [HDMI, POWER], heightMm: 10 });
    insert("sm-tv", { manufacturer: "Samsung", label: "Samsung QM65R", deviceType: "tv", ports: [HDMI, POWER] });
    insert("sm-disp", { manufacturer: "Samsung", label: "Samsung QM55C", ports: [HDMI, POWER] });
    const before = { mic: row("gen-mic"), tv: row("trolley-tv") };
    const r = applyVendorDecisions(api.db.sqlite);
    expect(r.genericKeptExisting).toEqual(["tv", "wired-mic"]);
    expect(row("gen-mic")).toEqual(before.mic);
    expect(row("trolley-tv")).toEqual(before.tv);
    expect(row("lg-mic")).toBeUndefined();
    expect(row("sm-tv")).toBeUndefined();
    // Only the type without a Generic got one.
    expect(r.genericCreated).toEqual([{ id: "sm-disp", label: "Generic Display", deviceType: "display", from: "Samsung QM55C" }]);
    expect(r.genericFinal).toEqual([
      { id: "sm-disp", label: "Generic Display", deviceType: "display", from: "Samsung QM55C" },
      { id: "trolley-tv", label: "Trolley TV", deviceType: "tv" },
      { id: "gen-mic", label: "Generic Microphone", deviceType: "wired-mic" },
    ]);
  });

  it("never touches the curated library (by id or by meta source)", () => {
    insert("lib-by-id", { manufacturer: "Absen", deviceType: "led-cabinet" });
    insert("lib-by-source", { manufacturer: "Crestron" }, "draft", AVAIL_LIBRARY_SOURCE);
    insert("lib-generic", { manufacturer: "Generic", label: "Generic Display", ports: [] }, "draft", AVAIL_LIBRARY_SOURCE);
    insert("sm", { manufacturer: "Samsung", label: "Samsung QM55C", ports: [HDMI, POWER] });
    const r = applyVendorDecisions(api.db.sqlite, { libraryIds: ["lib-by-id"] });
    expect(r.protectedCount).toBe(3);
    expect(row("lib-by-id")!.manufacturer).toBe("Absen");
    expect(row("lib-by-source")!.manufacturer).toBe("Crestron");
    // The curated Generic Display counts as an existing Generic: no new one, the brand goes.
    expect(row("lib-generic")!.label).toBe("Generic Display");
    expect(r.genericCreated).toEqual([]);
    expect(row("sm")).toBeUndefined();
  });

  it("reports deleted templates that a person had reviewed", () => {
    insert("crestron", { manufacturer: "Crestron", label: "Crestron CP4" }, "verified");
    expect(applyVendorDecisions(api.db.sqlite).deletedReviewed).toEqual([{ id: "crestron", label: "Crestron CP4", status: "verified" }]);
  });

  it("dry run writes nothing; the report lists every section", () => {
    insert("jbl", { manufacturer: "JBL" });
    insert("y", { manufacturer: "Yamaha Pro Audio" });
    insert("sm", { manufacturer: "Samsung", modelNumber: "M-sm" });
    const r = applyVendorDecisions(api.db.sqlite, { dryRun: true });
    expect(r.deletedTotal).toBe(1);
    expect(count()).toBe(3);
    expect(row("y")!.manufacturer).toBe("Yamaha Pro Audio");
    const text = formatVendorCleanupReport(r);
    for (const s of ["dry run, nothing written", "Renamed: 1", "Deleted by scope: 0", "Generic templates created: 1", "Deleted, manufacturer not decided: 1", "Deleted, no manufacturer: 0", "Remaining by vendor:"]) {
      expect(text).toContain(s);
    }
    // The dry run already lists the resulting Generic templates, new ones with their source.
    expect(r.genericFinal).toEqual([{ id: "sm", label: "Generic Display", deviceType: "display", from: "X sm (M-sm)" }]);
    expect(text).toContain("Generic templates after the run: 1 (new 1, marked NEW with their source)");
    expect(text).toMatch(/NEW display\s+Generic Display \[sm\] ← X sm \(M-sm\)/);
  });

  it("is idempotent: a second run changes nothing", () => {
    insert("jbl", { manufacturer: "JBL" });
    insert("sm", { manufacturer: "Samsung" });
    insert("y", { manufacturer: "Yamaha Pro Audio" });
    applyVendorDecisions(api.db.sqlite);
    const snapshot = api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all();
    const r = applyVendorDecisions(api.db.sqlite);
    expect(r).toMatchObject({ deletedTotal: 0, renamed: [], genericCreated: [] });
    expect(api.db.sqlite.prepare("SELECT * FROM templates ORDER BY id").all()).toEqual(snapshot);
  });
});

describe("after the cleanup", () => {
  const up = (id: string, over: Partial<UpstreamTemplate> = {}): UpstreamTemplate => ({
    id, version: 1, deviceType: "display", label: `T ${id}`, manufacturer: "Extron", modelNumber: `M-${id}`, ports: [POWER], ...over,
  });
  const source = [
    up("ext"),
    up("jbl", { manufacturer: "JBL" }),
    up("none", { manufacturer: undefined }),
    up("sony-tv", { manufacturer: "Sony", deviceType: "tv" }),
    up("ng-wifi", { manufacturer: "NETGEAR", deviceType: "access-point", modelNumber: "WAX610" }),
    up("sm1", { manufacturer: "Samsung", label: "Samsung QM55C", ports: [HDMI, POWER] }),
    up("sm2", { manufacturer: "Samsung", label: "Samsung QM65C" }),
    up("gen-mic", { manufacturer: "Generic", label: "Generic Microphone", deviceType: "wired-mic", ports: [] }),
    up("lg-mic", { manufacturer: "Logitech", label: "Logitech Mic Pod", deviceType: "wired-mic", ports: [HDMI, POWER] }),
  ];

  it("a repeated import:upstream does not bring back what was deleted", () => {
    // Database imported before the decisions existed: everything came in as raw.
    for (const t of source) {
      insert(t.id, { ...t, version: undefined }, "raw", "easyschematic.live");
      api.db.sqlite.prepare("UPDATE avail_template_meta SET upstream_id = ? WHERE template_id = ?").run(t.id, t.id);
    }
    applyVendorDecisions(api.db.sqlite);
    const after = (api.db.sqlite.prepare("SELECT id, manufacturer, label FROM templates ORDER BY id").all() as { id: string }[]);
    expect(after.map((r) => r.id)).toEqual(["ext", "gen-mic", "sm1"]);

    const r = importTemplates(api.db.sqlite, source);
    // sm1 was made into Generic Display: the source's Samsung data must not come back over it.
    expect(r).toMatchObject({ inserted: 0, skippedProtected: 0 });
    expect(r.skipped).toEqual({ noManufacturer: 1, notDecided: 1, scope: 2, genericExists: 3, genericPlan: 0 });
    expect(api.db.sqlite.prepare("SELECT id, manufacturer, label FROM templates ORDER BY id").all()).toEqual(after);
    expect(row("sm1")).toMatchObject({ label: "Generic Display", manufacturer: "Generic" });
    expect(row("gen-mic")).toMatchObject({ label: "Generic Microphone" }); // existing Generic, never overwritten
    expect(row("lg-mic")).toBeUndefined();
    expect(meta("sm1")).toMatchObject({ source: "vendor-decisions", upstream_id: null });
  });

  it("a saved schematic whose template was deleted still opens, unchanged", async () => {
    insert("jbl-speaker", { manufacturer: "JBL", label: "JBL Control 25", deviceType: "speaker" });
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    api.db.sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'contributor')").run(userId, "eng@avail.test");
    api.db.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(sessionId, userId);
    const cookie = `session=${sessionId}`;
    const doc = {
      name: "Room 1",
      version: 1,
      nodes: [{ id: "n1", type: "device", position: { x: 0, y: 0 }, data: { label: "JBL Control 25", templateId: "jbl-speaker", templateVersion: 1, deviceType: "speaker", ports: [POWER] } }],
      edges: [],
    };
    const created = await api.fetch(new Request("http://localhost/schematics", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(doc) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    applyVendorDecisions(api.db.sqlite);
    expect(row("jbl-speaker")).toBeUndefined();

    const read = await api.fetch(new Request(`http://localhost/schematics/${id}`, { headers: { Cookie: cookie } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(doc);
    expect((await api.fetch(new Request("http://localhost/templates/jbl-speaker"))).status).toBe(404);
  });
});
