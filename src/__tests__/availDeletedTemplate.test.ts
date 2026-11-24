/**
 * Phase 1.5: apply:vendor-decisions deletes templates. A saved schematic that has a block
 * made from a deleted template must still open: the block keeps its own data, the template
 * id is only a link. Loads such a schematic through the store (as File → Open does) and
 * runs what the editor computes for a block: template drift, Device Editor fields, the
 * AVAIL status badge and the reports notice.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../migrations";
import type { DeviceData, SchematicFile } from "../types";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}

let store: typeof import("../store")["useSchematicStore"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  ({ useSchematicStore: store } = await import("../store"));
});

const DELETED_ID = "deleted-jbl-control-25";

const blockData: DeviceData = {
  label: "JBL Control 25",
  deviceType: "speaker",
  manufacturer: "JBL",
  modelNumber: "Control 25",
  templateId: DELETED_ID,
  templateVersion: 3,
  ports: [{ id: "in", label: "Speaker In", signalType: "speaker-level", direction: "input", connectorType: "terminal-block" }],
};

const file: SchematicFile = {
  version: CURRENT_SCHEMA_VERSION,
  name: "Room 1",
  nodes: [{ id: "spk1", type: "device", position: { x: 0, y: 0 }, data: blockData }],
  edges: [],
} as unknown as SchematicFile;

describe("a schematic with a block from a deleted template", () => {
  it("opens: the block keeps its data", () => {
    expect(() => store.getState().importFromJSON(structuredClone(file))).not.toThrow();
    const node = store.getState().nodes.find((n) => n.id === "spk1");
    expect(node?.data).toMatchObject({ label: "JBL Control 25", templateId: DELETED_ID, manufacturer: "JBL" });
    expect((node?.data as DeviceData).ports.map((p) => p.id)).toEqual(["in"]);
  });

  it("no template drift, Device Editor fields build from the block itself", async () => {
    const { getTemplateDrift } = await import("../templateSync");
    const { getTemplateById } = await import("../templateApi");
    const { deviceEditorFields } = await import("../deviceEditorDirty");
    expect(getTemplateById(DELETED_ID)).toBeUndefined();
    expect(getTemplateDrift(blockData)).toBeNull();
    expect(deviceEditorFields(blockData, undefined)).toMatchObject({ label: "JBL Control 25", manufacturer: "JBL" });
  });

  it("in AVAIL mode the block shows as unverified and the reports notice lists it", async () => {
    const mode = await import("../avail/libraryMode");
    const { unverifiedBlocks } = await import("../avail/libraryView");
    mode.resetForTests();
    mode.noteLibraryResponse(new Response("[]", { headers: { [mode.AVAIL_LIBRARY_HEADER]: "1" } }), []);
    expect(mode.blockStatus(DELETED_ID)).toBe("raw");
    expect(unverifiedBlocks(file.nodes as never)).toEqual([{ nodeId: "spk1", label: "JBL Control 25", status: "raw" }]);
  });
});
