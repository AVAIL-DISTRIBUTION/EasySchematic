/**
 * Phase 1.5: vendor decisions (src/avail/vendorDecisions.ts, docs/avail/vendor-decisions.json),
 * two vendor tiers in avail-vendors.json, and the linter's bus-power rule.
 */
import { describe, expect, it } from "vitest";
import { lintBlock } from "../avail/blockLint";
import { findVendor, VENDORS } from "../avail/library";
import { completeness, deviceTypeTitle, genericTemplate, VENDOR_DECISIONS, VendorRules } from "../avail/vendorDecisions";

const rules = new VendorRules();

describe("avail-vendors.json: portfolio and supported vendors", () => {
  it("19 portfolio vendors + the 11 new supported ones (portfolio: false)", () => {
    expect(VENDORS.filter((v) => v.portfolio)).toHaveLength(19);
    expect(VENDORS.filter((v) => !v.portfolio).map((v) => v.name).sort()).toEqual([...VENDOR_DECISIONS.newSupportedVendors].sort());
  });

  it("rename map entries are aliases of the supported vendors", () => {
    for (const [from, to] of Object.entries(VENDOR_DECISIONS.rename)) expect(findVendor(from)?.name, from).toBe(to);
  });

  it("the linter accepts a manufacturer of either tier", () => {
    const block = (manufacturer: string) => ({ label: `${manufacturer} X`, manufacturer, modelNumber: "X", deviceType: "audio-mixer", category: "Audio Products / Mixers", ports: [] });
    for (const m of ["Extron", "Yamaha", "Allen & Heath", "Chauvet Professional"]) {
      expect(lintBlock(block(m)).warnings.some((w) => w.startsWith("manufacturer")), m).toBe(false);
    }
    expect(lintBlock(block("Behringer")).warnings).toContain('manufacturer "Behringer" is not in avail-vendors.json (outside the portfolio use Generic)');
  });
});

describe("VendorRules.classify", () => {
  it("keep (with canonical spelling), generic, drop, none", () => {
    expect(rules.classify({ manufacturer: "Extron" })).toEqual({ kind: "keep", manufacturer: "Extron", renamed: false });
    expect(rules.classify({ manufacturer: "Yamaha Pro Audio" })).toEqual({ kind: "keep", manufacturer: "Yamaha", renamed: true });
    expect(rules.classify({ manufacturer: "allen and heath" })).toMatchObject({ kind: "keep", manufacturer: "Allen & Heath" });
    expect(rules.classify({ manufacturer: "biamp" })).toMatchObject({ kind: "keep", manufacturer: "Biamp", renamed: true });
    expect(rules.classify({ manufacturer: "Samsung" })).toEqual({ kind: "generic", manufacturer: "Samsung" });
    expect(rules.classify({ manufacturer: "L-Acoustics" }).kind).toBe("generic");
    expect(rules.classify({ manufacturer: "Crestron" })).toEqual({ kind: "drop", manufacturer: "Crestron" });
    expect(rules.classify({ manufacturer: "  " })).toEqual({ kind: "none" });
    expect(rules.classify({})).toEqual({ kind: "none" });
  });

  it("portfolio vendors are kept even when the keep list omits them (tvONE, Xilica)", () => {
    expect(VENDOR_DECISIONS.keep).not.toContain("tvONE");
    expect(rules.classify({ manufacturer: "TV One" })).toMatchObject({ kind: "keep", manufacturer: "tvONE" });
    expect(rules.classify({ manufacturer: "Xilica" }).kind).toBe("keep");
  });

  it("scope: Sony device types, NETGEAR model pattern (model number, label, label without the brand)", () => {
    expect(rules.classify({ manufacturer: "Sony", deviceType: "ptz-camera" }).kind).toBe("keep");
    expect(rules.classify({ manufacturer: "Sony", deviceType: "tv" }).kind).toBe("scope");
    expect(rules.classify({ manufacturer: "Netgear", modelNumber: "GSM4230PX", label: "M4250-26G4XF-PoE+" })).toMatchObject({ kind: "keep", manufacturer: "NETGEAR" });
    expect(rules.classify({ manufacturer: "NETGEAR", modelNumber: "VSM4320C", label: "NETGEAR M4350-16V4C" }).kind).toBe("keep");
    expect(rules.classify({ manufacturer: "NETGEAR", modelNumber: "WAX610", label: "NETGEAR WAX610" }).kind).toBe("scope");
  });
});

describe("Generic templates", () => {
  it("type titles", () => {
    expect(deviceTypeTitle("led-processor")).toBe("LED Processor");
    expect(deviceTypeTitle("tv")).toBe("TV");
    expect(deviceTypeTitle("video-bar")).toBe("Video Bar");
    expect(deviceTypeTitle("ptz-camera")).toBe("PTZ Camera");
  });

  it("Generic <type>: GEN code, category, no links, physics or brand search terms; ports kept", () => {
    const g = genericTemplate({
      id: "x", deviceType: "led-cabinet", label: "Absen CL0.7", manufacturer: "Absen", modelNumber: "CL0.7", color: "#000",
      referenceUrl: "https://absen.com", heightMm: 338, powerDrawW: 140, searchTerms: ["absen", "cl0.7"], ports: [{ id: "p" }],
    });
    expect(g).toEqual({
      id: "x", deviceType: "led-cabinet", label: "Generic LED Cabinet", shortName: "LED Cabinet", manufacturer: "Generic",
      modelNumber: "GEN-LED-CABINET", category: "Displays / LED", searchTerms: ["led cabinet", "led-cabinet", "generic"],
      auxiliaryData: [{ text: "{{deviceType}}", position: "header" }], ports: [{ id: "p" }],
    });
    expect(genericTemplate<Record<string, unknown>>({ deviceType: "expansion-card", ports: [] }).category).toBe("Other / Generic");
  });

  it("completeness: level first, then ports with connectors, then physics", () => {
    const base = { label: "Generic Display", manufacturer: "Generic", modelNumber: "GEN-DISPLAY", shortName: "Display", deviceType: "display", category: "Displays / Standalone Displays", auxiliaryData: [{ text: "{{deviceType}}" }], searchTerms: ["display"] };
    const power = { id: "p", label: "Power", signalType: "power", direction: "input", section: "Power", connectorType: "iec" };
    const hdmi = { id: "h", label: "HDMI In", signalType: "hdmi", direction: "input", section: "Video Inputs", connectorType: "hdmi" };
    const a = completeness({ ...base, ports: [hdmi, power] });
    const b = completeness({ ...base, ports: [power] });
    const fix = completeness({ ...base, ports: [{ ...hdmi, connectorType: "" }, power, hdmi, hdmi] });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(fix);
    expect(completeness({ ...base, ports: [power], heightMm: 1 })).toBeGreaterThan(b);
  });
});

describe("linter: bus power (standard 3.1)", () => {
  const card = {
    label: "Biamp Vidi 250", shortName: "Vidi 250", manufacturer: "Biamp", modelNumber: "910-00130", deviceType: "camera",
    category: "Videocameras / USB cameras", auxiliaryData: [{ text: "{{deviceType}}" }], referenceUrl: "https://biamp.com",
    searchTerms: ["vidi"], heightMm: 50, widthMm: 50, depthMm: 70, weightKg: 0.16, powerDrawW: 10,
  };
  const usb = (notes?: string) => ({ id: "u", label: "USB-C", signalType: "usb", direction: "bidirectional", section: "USB", connectorType: "usb-c", ...(notes ? { notes } : {}) });

  it("USB bus-powered: no power port and no voltage needed when the port says bus-powered (USB)", () => {
    expect(lintBlock({ ...card, ports: [usb("USB 3.0; bus-powered (USB), < 10 W")] })).toEqual({ level: "A", errors: [], warnings: [] });
    const plain = lintBlock({ ...card, ports: [usb("USB 3.0")] });
    expect(plain.errors).toContain("no power port");
    expect(plain.warnings).toContain("no powerDrawW/voltage (or poeDrawW)");
  });

  it("PoE in the notes of the powering port; \"no PoE\", output ports and PoE sources do not count", () => {
    const lan = (notes: string, direction = "bidirectional") => ({ id: "l", label: "LAN", signalType: "ethernet", direction, section: "Network", connectorType: "rj45", notes });
    expect(lintBlock({ ...card, ports: [lan("PoE+ 802.3at")] }).errors).not.toContain("no power port");
    expect(lintBlock({ ...card, ports: [lan("Gigabit, no PoE")] }).errors).toContain("no power port");
    expect(lintBlock({ ...card, ports: [lan("PoE+ out", "output")] }).errors).toContain("no power port");
    expect(lintBlock({ ...card, poeBudgetW: 120, ports: [lan("PoE+ 802.3at")] }).errors).toContain("no power port");
  });
});
