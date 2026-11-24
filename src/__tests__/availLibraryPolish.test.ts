/**
 * Phase 1.6: bulk selection state, normalizer change descriptions for the editor's
 * Normalize preview, the linter's section hint, new deviceTypeDefaults.
 */
import { describe, expect, it } from "vitest";
import { defaultCategoryFor, findCategory } from "../avail/library";
import * as mode from "../avail/libraryMode";
import { describeChange, portLabelMap } from "../avail/libraryView";
import { normalizeBlock } from "../avail/normalize";
import { suggestSection } from "../avail/sections";

describe("bulk selection", () => {
  it("select mode, toggling, clearing; leaving select mode drops the selection", () => {
    mode.resetForTests();
    let n = 0;
    const off = mode.subscribe(() => n++);
    expect(mode.isSelectMode()).toBe(false);
    mode.setSelectMode(true);
    mode.toggleSelected("a");
    mode.toggleSelected("b", true);
    mode.toggleSelected("b", true); // no-op
    expect(mode.getSelected()).toEqual(["a", "b"]);
    expect(mode.isSelected("a")).toBe(true);
    mode.toggleSelected("a");
    expect(mode.getSelected()).toEqual(["b"]);
    mode.clearSelection();
    expect(mode.getSelected()).toEqual([]);
    mode.toggleSelected("c");
    mode.setSelectMode(false);
    expect(mode.getSelected()).toEqual([]);
    expect(n).toBe(7);
    off();
  });
});

describe("Normalize preview", () => {
  it("describes applied and manual changes", () => {
    const { changes } = normalizeBlock({
      label: "Extron X", manufacturer: "Extron", modelNumber: "1", deviceType: "switcher", category: "AV distribution / Switchers",
      ports: [
        { id: "p1", label: "HDMI Out", signalType: "hdmi", direction: "bidirectional", section: "Rear", connectorType: "hdmi" },
        { id: "p2", label: "Ref", signalType: "genlock", direction: "input", section: "Rear", connectorType: "bnc" },
      ],
    });
    const lines = changes.map((c) => describeChange(c));
    expect(lines).toContain('ports[p1].direction: "bidirectional" → "output" (hdmi direction from the label)');
    expect(lines).toContain('ports[p1].section: "Rear" → "Video Outputs" (section from the standard\'s vocabulary)');
    expect(lines.some((l) => l.startsWith("ports[p2].section: section \"Rear\": signal type"))).toBe(true);
    expect(describeChange({ field: "x", from: "a".repeat(80), to: "b", note: "n" })).toMatch(/^x: "a{56}… → "b" \(n\)$/);
    const labels = portLabelMap([{ id: "p1", label: "HDMI Out" }]);
    expect(changes.map((c) => describeChange(c, labels))).toContain('"HDMI Out" › section: "Rear" → "Video Outputs" (section from the standard\'s vocabulary)');
  });
});

describe("section hint", () => {
  it("what the normalizer would choose, including an inferred direction", () => {
    expect(suggestSection({ label: "HDMI Out 2", signalType: "hdmi", direction: "bidirectional", section: "Back" })).toBe("Video Outputs");
    expect(suggestSection({ label: "Mic In", signalType: "analog-audio", direction: "input", section: "" })).toBe("Audio Inputs");
    expect(suggestSection({ label: "Ref", signalType: "genlock", direction: "input", section: "Rear" })).toBeNull();
    expect(suggestSection({ label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs" })).toBeNull();
  });
});

describe("deviceTypeDefaults (phase 1.6)", () => {
  it("new defaults are leaves of the taxonomy; disputed types stay null", () => {
    const expected: Record<string, string> = {
      "power-distribution": "Integration Tools / PSU",
      "expansion-chassis": "Audio Products / Interfaces",
      "antenna-combination": "Microphones / Wireless microphones",
      "personal-monitor": "Audio Products / Mixers",
      "floor-box": "Connectivity / Architectural",
      "camera-ccu": "Videocameras / Camera controls",
      "cable-accessory": "Connectivity / Cables & Adapters",
      "storage-media": "Integration Tools / Tools",
    };
    for (const [type, path] of Object.entries(expected)) {
      expect(defaultCategoryFor(type), type).toBe(path);
      expect(findCategory(path)?.leaf, path).toBe(true);
    }
    expect(findCategory("Connectivity / Cables & Adapters")?.schematic).toBe(false);
    for (const t of ["expansion-card", "controller", "dmx-node", "dmx-splitter", "battery", "frame", "camera", "control-expansion"]) {
      expect(defaultCategoryFor(t), t).toBeNull();
    }
  });
});
