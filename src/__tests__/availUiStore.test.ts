/**
 * AVAIL interface through the real store: a blank schematic gets AVAIL defaults, the
 * first visit opens an empty sheet (no upstream demo), and a placed device takes its
 * category group's header color with the precedence preset > template > group > defaults.
 * Without VITE_AVAIL the store behaves as upstream.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceData, DeviceNode, DeviceTemplate } from "../types";
import { GROUP_HEADER_COLORS } from "../avail/headerColors";
import { setSignedInUser } from "../avail/session";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}

let useSchematicStore: typeof import("../store")["useSchematicStore"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = { randomUUID: () => "test-" + Math.random().toString(36).slice(2) };
  }
  ({ useSchematicStore } = await import("../store"));
});

beforeEach(() => {
  localStorage.clear();
  useSchematicStore.setState({ appDefaultDeviceHeaderColor: undefined, defaultDeviceHeaderColor: undefined, templatePresets: {} });
  setSignedInUser({ id: "u1", email: "jane.doe@avail-int.com", name: "Jane Doe" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setSignedInUser(null);
});

const DISPLAY: DeviceTemplate = {
  id: "avail-test-display",
  deviceType: "display",
  label: "Test Display",
  category: "Displays / Desktop Displays",
  ports: [{ id: "d-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" }],
};

function place(template: DeviceTemplate): DeviceData {
  useSchematicStore.getState().addDevice(template, { x: 0, y: 0 });
  const nodes = useSchematicStore.getState().nodes;
  return (nodes[nodes.length - 1] as DeviceNode).data;
}

describe("AVAIL build (VITE_AVAIL=1)", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AVAIL", "1");
  });

  it("New: palette, fiber dashed, title block, A3 landscape", () => {
    useSchematicStore.getState().newSchematic();
    const s = useSchematicStore.getState();
    expect(s.nodes).toEqual([]);
    expect(s.signalColors?.hdmi).toBe("#aa00aa");
    expect(s.signalColors?.ethernet).toBe("#0055cc");
    expect(s.signalColors?.dante).toBe("#007700");
    expect(s.signalColors?.fiber).toBe("#808080");
    expect(s.signalLineStyles).toEqual({ fiber: "dashed" });
    expect(s.titleBlock.company).toBe("AVAIL DISTRIBUTION, FZCO");
    expect(s.titleBlock.engineer).toBe("Jane Doe");
    expect(s.titleBlock.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.printPaperId).toBe("iso-a3");
    expect(s.printOrientation).toBe("landscape");
  });

  it("the defaults are ordinary settings the engineer can change", () => {
    useSchematicStore.getState().newSchematic();
    const s = useSchematicStore.getState();
    s.setSignalColors({ ...s.signalColors, hdmi: "#112233" });
    s.setTitleBlock({ ...s.titleBlock, engineer: "John Smith" });
    s.setPrintPaperId("iso-a2");
    const after = useSchematicStore.getState();
    expect(after.signalColors?.hdmi).toBe("#112233");
    expect(after.titleBlock.engineer).toBe("John Smith");
    expect(after.printPaperId).toBe("iso-a2");
  });

  it("first visit: an empty sheet with AVAIL defaults, not the Welcome demo", async () => {
    useSchematicStore.setState({ nodes: [], isDemo: false });
    useSchematicStore.getState().loadFromLocalStorage();
    // The demo is loaded by a dynamic import; give it the chance to arrive.
    await new Promise((r) => setTimeout(r, 50));
    const s = useSchematicStore.getState();
    expect(s.isDemo).toBe(false);
    expect(s.nodes).toEqual([]);
    expect(s.titleBlock.company).toBe("AVAIL DISTRIBUTION, FZCO");
  });

  it("a device takes its category group's header color", () => {
    useSchematicStore.getState().newSchematic();
    expect(place(DISPLAY).headerColor).toBe(GROUP_HEADER_COLORS.Displays);
  });

  it("template color beats the group color", () => {
    useSchematicStore.getState().newSchematic();
    expect(place({ ...DISPLAY, headerColor: "#123456" }).headerColor).toBe("#123456");
  });

  it("preset color beats the group color", () => {
    useSchematicStore.getState().newSchematic();
    useSchematicStore.setState({
      templatePresets: { [DISPLAY.id!]: { ports: DISPLAY.ports, hiddenPorts: [], headerColor: "#abcdef" } as never },
    });
    expect(place(DISPLAY).headerColor).toBe("#abcdef");
  });

  it("group color beats the project and app defaults; no group falls through to them", () => {
    useSchematicStore.getState().newSchematic();
    useSchematicStore.setState({ defaultDeviceHeaderColor: "#ff0000", appDefaultDeviceHeaderColor: "#00ff00" });
    expect(place(DISPLAY).headerColor).toBe(GROUP_HEADER_COLORS.Displays);
    expect(place({ ...DISPLAY, id: "generic-x", category: "Other / Generic" }).headerColor).toBe("#ff0000");
  });
});

describe("upstream build (no VITE_AVAIL)", () => {
  it("New keeps upstream defaults", () => {
    useSchematicStore.setState({ printPaperId: "arch-d" });
    useSchematicStore.getState().newSchematic();
    const s = useSchematicStore.getState();
    expect(s.titleBlock.company).toBe("");
    expect(s.titleBlock.engineer).toBe("");
    expect(s.printPaperId).toBe("arch-d");
  });

  it("no group header colors", () => {
    useSchematicStore.getState().newSchematic();
    expect(place(DISPLAY).headerColor).toBeUndefined();
  });
});
