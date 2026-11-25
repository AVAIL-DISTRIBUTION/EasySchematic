/**
 * Extron Visio stencils (step 1.10): src/avail/extronVisio.ts reads a stencil master into ports,
 * src/avail/extronStencil.ts and fillCatalogPorts apply them to the catalog.
 */
import { describe, expect, it } from "vitest";
import { fillCatalogPorts, formatStencilReport, type CatalogFile, type CatalogTemplate, type PortDonor } from "../avail/catalogPorts";
import { lintBlock } from "../avail/blockLint";
import { chassisSlotsFromDescription, comparePorts, EXTRON_DC_NOTE, indexStencils, stencilPortsFor, withExtronDcPower } from "../avail/extronStencil";
import {
  canonLabel,
  connectorOf,
  mastersOfXml,
  parseXml,
  partNumbersOf,
  stencilPorts,
  type StencilBlock,
  type VisioMaster,
} from "../avail/extronVisio";

// ---------------------------------------------------------------------------- synthetic masters

interface T {
  /** Left edge, bottom edge, width, height (inches, master coordinates). */
  x: number;
  y: number;
  w?: number;
  h?: number;
  text: string;
}

const W = 2;

/** A label hugging the left edge (x 0.28) or the right edge (ends at 1.72), as Extron draws them. */
const L = (y: number, text: string, w = 0.6): T => ({ x: 0.28, y, w, text });
const R = (y: number, text: string, w = 0.6): T => ({ x: W - 0.28 - w, y, w, text });
/** The connector just below its label. */
const LC = (y: number, text: string) => L(y - 0.09, text);
const RC = (y: number, text: string) => R(y - 0.09, text);
/** Input number left of the label. */
const N = (y: number, n: string): T => ({ x: 0.1, y: y + 0.02, w: 0.15, text: n });
const RN = (y: number, n: string): T => ({ x: W - 0.25, y: y + 0.02, w: 0.15, text: n });

function masterXml(props: Record<string, string>, texts: T[], height = 3): string {
  const cell = (n: string, v: number | string) => `<Cell N='${n}' V='${v}'/>`;
  const shapes = texts
    .map((t, i) => {
      const w = t.w ?? 0.6;
      const h = t.h ?? 0.094;
      return (
        `<Shape ID='${i + 10}' Type='Shape'>${cell("PinX", t.x + w / 2)}${cell("PinY", t.y + h / 2)}${cell("Width", w)}${cell("Height", h)}` +
        `${cell("LocPinX", w / 2)}${cell("LocPinY", h / 2)}<Text><cp IX='0'/><pp IX='0'/>${t.text.replace(/&/g, "&amp;")}</Text></Shape>`
      );
    })
    .join("");
  const rows = Object.entries(props)
    .map(([k, v], i) => `<Row N='Row_${i}'><Cell N='Value' V='${v}' U='STR'/><Cell N='Label' V='${k}'/></Row>`)
    .join("");
  return (
    `<?xml version='1.0' encoding='utf-8' ?><MasterContents xmlns='http://schemas.microsoft.com/office/visio/2012/main' xml:space='preserve'>` +
    `<Shapes><Shape ID='5' NameU='${props.Model}, ${props["Part #"]}' Type='Group'>${cell("PinX", W / 2)}${cell("PinY", height / 2)}${cell("Width", W)}${cell("Height", height)}` +
    `${cell("LocPinX", W / 2)}${cell("LocPinY", height / 2)}<Section N='Property'>${rows}</Section><Shapes>` +
    // The header: model, part number, equipment ID — centred above the ports.
    `<Shape ID='6' Type='Shape'>${cell("PinX", 1)}${cell("PinY", height - 0.2)}${cell("Width", 1.5)}${cell("Height", 0.1)}${cell("LocPinX", 0.75)}${cell("LocPinY", 0.05)}<Text>${props.Model}</Text></Shape>` +
    `<Shape ID='7' Type='Shape'>${cell("PinX", 1)}${cell("PinY", height - 0.35)}${cell("Width", 1.2)}${cell("Height", 0.1)}${cell("LocPinX", 0.6)}${cell("LocPinY", 0.05)}<Text>${props["Part #"]}</Text></Shape>` +
    `${shapes}</Shapes></Shape></Shapes></MasterContents>`
  );
}

function master(model: string, part: string, texts: T[], extra: Record<string, string> = {}, height = 3): VisioMaster {
  const props = { Make: "Extron", Model: model, "Part #": part, Description: `${model} test`, "Web Page": "https://www.extron.com/product/x", ...extra };
  return mastersOfXml(masterXml(props, texts, height), "DTP - Test Eng.vssx")[0];
}

const brief = (b: StencilBlock) => b.ports.map((p) => `${p.label} | ${p.signalType} ${p.direction} ${p.connectorType ?? "-"} | ${p.section}`);

// ---------------------------------------------------------------------------- parsing

describe("parseXml", () => {
  it("reads elements, attributes, entities and text around child elements", () => {
    const doc = parseXml(`<?xml version='1.0'?><a x='1 &amp; 2'><Text><cp IX='0'/>HDMI<fld IX='0'> &lt;IN&gt;</fld></Text><b/></a>`);
    const a = doc.children[0];
    expect(a.name).toBe("a");
    expect(a.attrs.x).toBe("1 & 2");
    expect(a.children.map((c) => c.name)).toEqual(["Text", "b"]);
  });

  it("a master: properties, size, texts in master coordinates", () => {
    const m = master("DTP3 T 101 D Black", "60-1902-52", [L(0.75, "HDMI"), LC(0.75, "[F TYPE A]")]);
    expect(m.props.Model).toBe("DTP3 T 101 D Black");
    expect(m.width).toBe(2);
    const hdmi = m.texts.find((t) => t.text === "HDMI")!;
    expect(hdmi.x0).toBeCloseTo(0.28);
    expect(hdmi.y0).toBeCloseTo(0.75);
    expect(partNumbersOf(m)).toEqual(["60-1902-52"]);
  });

  it("part number from Part #, not from a master name copied from another product", () => {
    const m = { ...master("DTP3 T 203", "60-1885-52", []), name: "IPCP Pro 250 xi, 60-1911-01" };
    expect(partNumbersOf(m)).toEqual(["60-1885-52"]);
    expect(partNumbersOf({ ...m, props: { ...m.props, "Part #": "" } })).toEqual(["60-1911-01"]);
  });
});

describe("connector and label tables", () => {
  it("connector texts", () => {
    expect(connectorOf("[F TYPE A]", "hdmi").connector).toBe("hdmi");
    expect(connectorOf("[TYPE A F]", "usb").connector).toBe("usb-a");
    expect(connectorOf("[F TYPE A]", "displayport").connector).toBeUndefined();
    expect(connectorOf("[RJ-45 F]", "ethernet").connector).toBe("rj45");
    expect(connectorOf("[USB-C F]", "usb").connector).toBe("usb-c");
    expect(connectorOf("[3 POLE  CS]", "serial")).toEqual({ connector: "phoenix", notes: "3-pole captive screw" });
    expect(connectorOf("[2POLE-CS]", "power")).toEqual({ connector: "phoenix", notes: "2-pole captive screw" });
    expect(connectorOf("[HD15-F]", "vga").connector).toBe("vga");
    expect(connectorOf("[USB 2.0/1.x type A​]", "usb").connector).toBe("usb-a");
    expect(connectorOf("[Locking mechanism]", "usb").connector).toBeUndefined();
  });

  it("label spellings", () => {
    expect(canonLabel("RS232 [TP]")).toBe("RS-232 [TP");
    expect(canonLabel("LAN/ PoE")).toBe("LAN/POE");
    expect(canonLabel("DIG I/0")).toBe("DIG I/O");
  });
});

// ---------------------------------------------------------------------------- ports

describe("stencilPorts", () => {
  it("a wallplate transmitter: side gives the direction, brackets the connector", () => {
    const b = stencilPorts(
      master("DTP3 T 322 D", "60-2066-52", [
        L(1.27, "HDMI"), LC(1.27, "[F TYPE A]"), N(1.27, "1"),
        L(1.02, "USB-C"), LC(1.02, "[USB-C F]"), N(1.02, "2"),
        R(1.26, "DTP/HDBTOUT"), RC(1.26, "[RJ-45 F]"),
        R(1.05, "UPI 100 PWR insert"), RC(1.05, "[2 POLE CS]"),
        R(0.81, "RS232 [TP]"), RC(0.81, "[3  POLE CS]"),
        R(0.54, "RS-232 [REMOTE ]"), RC(0.54, "[3 POLE CS]"),
        R(0.25, "POWER"),
      ]),
    );
    expect(b.issues).toEqual([]);
    expect(brief(b)).toEqual([
      "HDMI In 1 | hdmi input hdmi | Video Inputs",
      "USB-C In 2 | usb input usb-c | Video Inputs",
      "DTP/HDBT Out | hdbaset output rj45 | Video Outputs",
      "RS-232 (Over TP) | serial bidirectional phoenix | Serial",
      "RS-232 (Remote) | serial bidirectional phoenix | Serial",
      "Power Out (UPI Insert) | power output phoenix | Power",
      "Power | power input - | Power",
    ]);
    expect(b.ports[3].notes).toBe("3-pole captive screw");
  });

  it("a port label equal to the equipment ID is a port when it hugs an edge", () => {
    const b = stencilPorts(master("ACP 100", "60-1643-03", [L(0.5, "ACP"), LC(0.5, "[4 POLE CS]")], { "Equipment ID": "ACP" }));
    expect(brief(b)).toEqual(["ACP Bus | ebus bidirectional phoenix | Expansion"]);
  });

  it("a row under a numbered port takes its number (audio of input 1, RS-232/IR of DTP In 7)", () => {
    const b = stencilPorts(
      master("DTP CrossPoint 82 4K", "60-1583-01", [
        L(2.5, "HDMI"), LC(2.5, "[F TYPE A]"), N(2.5, "001"),
        L(2.25, "AUDIO"), LC(2.25, "[5 POLE CS]"),
        L(2.0, "HDMI"), LC(2.0, "[F TYPE A]"), N(2.0, "002"),
        L(1.75, "AUDIO"), LC(1.75, "[5 POLE CS]"),
        L(1.5, "DTP IN"), LC(1.5, "[RJ-45 F]"), N(1.5, "007"),
        L(1.25, "RS-232/IR"), LC(1.25, "[5 POLE CS]"),
        R(2.5, "DTP OUT"), RC(2.5, "[RJ-45 F]"), RN(2.5, "001B"),
        R(2.25, "RS-232/IR"), RC(2.25, "[5 POLE CS]"),
        L(0.25, "POWER"),
      ]),
    );
    expect(b.ports.map((p) => p.label)).toEqual([
      "HDMI In 1", "HDMI In 2", "DTP In 7", "DTP Out 1B", "Audio In 1", "Audio In 2",
      "RS-232/IR (In 7)", "RS-232/IR (Out 1B)", "Power",
    ]);
  });

  it("stereo L/R rows and channel numbers around a shared connector make one port", () => {
    const b = stencilPorts(
      master("XPA U 358", "60-1759-12", [
        N(2.3, "001"), L(2.17, "AUDIO"), LC(2.17, "[5 POLE CS]"), N(2.05, "002"),
        R(2.3, "L"), R(2.17, "SA OUT 8Ω/4Ω"), RC(2.17, "[4 POLE CS]"), R(2.05, "R"),
        L(0.25, "POWER"),
      ]),
    );
    expect(b.issues).toEqual([]);
    expect(brief(b)).toEqual([
      "Audio In 1-2 | analog-audio input phoenix | Audio Inputs",
      "Speaker Out | speaker-level output phoenix | Speaker Outputs",
      "Power | power input - | Power",
    ]);
    expect(b.ports[0].notes).toContain("channels 1-2");
    expect(b.ports[1].notes).toContain("L/R");
  });

  it("functions of one connector share it; the connector's generic name is not a port", () => {
    const b = stencilPorts(
      master("FOX3 SR 302", "60-1959-21", [
        L(0.99, "RS-232"), L(0.89, "CONTROL"), LC(0.89, "[5 POLE CS]"), L(0.74, "IR"),
        L(0.25, "POWER"),
      ]),
    );
    expect(brief(b)).toEqual([
      "RS-232 | serial bidirectional phoenix | Serial",
      "IR In | ir input phoenix | IR",
      "Power | power input - | Power",
    ]);
    expect(b.ports[0].notes).toContain("one connector with CONTROL, IR");
  });

  it("number-only rows of a frame are slot positions, not ports", () => {
    const rows = [5, 4.25, 3.5, 2.75].map((y, i) => N(y, `00${i + 1}`));
    const b = stencilPorts(master("XTP II CrossPoint 1600", "60-1545-01", [...rows, R(0.55, "RS-232"), RC(0.55, "[3 POLE CS]"), L(0.25, "POWER")], {}, 6));
    expect(b.modularSlots).toBe(4);
    expect(b.ports.map((p) => p.label)).toEqual(["RS-232", "Power"]);
  });

  it("pin-level drawings and unknown labels are issues", () => {
    const b = stencilPorts(master("IN1804 DI", "60-1699-02", [R(1.0, "C"), R(0.75, "T"), R(0.5, "HPF"), RC(0.5, "[2 POLE CS]")]));
    expect(b.issues).toContain('pin-level drawing: "C"');
    expect(b.issues).toContain('unknown label "HPF"');
  });
});

// ---------------------------------------------------------------------------- catalog

const STENCIL: StencilBlock = {
  partNumbers: ["60-1885-52"],
  model: "DTP3 T 203",
  make: "Extron",
  description: "",
  webPage: "",
  stencil: "DTP - DTP3 Transmitters Eng.vssx",
  master: "DTP3 T 203, 60-1885-52",
  retired: false,
  ports: [
    { id: "vx-1", label: "HDMI In 1", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" },
    { id: "vx-2", label: "HDMI In 2", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" },
    { id: "vx-3", label: "DTP Out", signalType: "hdbaset", direction: "output", connectorType: "rj45", section: "Video Outputs" },
    { id: "vx-4", label: "Power", signalType: "power", direction: "input", section: "Power" },
  ],
  issues: [],
};

const COMMUNITY = [
  { id: "c1", label: "HDMI Input", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs", notes: "HDCP 2.3" },
  { id: "c2", label: "DTP Output", signalType: "hdbaset", direction: "output", connectorType: "rj45", section: "Video Outputs" },
  { id: "c3", label: "USB Config", signalType: "usb", direction: "bidirectional", connectorType: "usb-c", section: "Configuration" },
  { id: "c4", label: "12V DC", signalType: "power", direction: "input", connectorType: "phoenix", section: "Power", notes: "12 VDC, 2-pole" },
];

function card(label: string, modelNumber: string, extra: Partial<CatalogTemplate> = {}): CatalogFile {
  const t: CatalogTemplate = {
    id: `avail-extron-${modelNumber}`,
    label,
    shortName: label.replace(/^Extron /, ""),
    manufacturer: "Extron",
    modelNumber,
    deviceType: "hdbaset-extender",
    category: "AV distribution / Extenders",
    auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
    referenceUrl: "https://www.extron.com/product/x",
    searchTerms: [modelNumber],
    heightMm: 25, widthMm: 100, depthMm: 100, weightKg: 0.5,
    powerDrawW: 6,
    voltage: "12V DC",
    _avail: { status: "awaiting-ports" },
    ports: [],
    ...extra,
  };
  return { file: `extron/${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`, template: t };
}

const donor = (ports: unknown[], extra: Partial<PortDonor> = {}): PortDonor => ({
  id: "db-1", label: "Extron DTP3 T 203", manufacturer: "Extron", modelNumber: "60-1885-52", ports, status: "raw", level: "A", ...extra,
});

describe("stencil against the catalog", () => {
  it("comparePorts: counts and connectors by signal and direction; service ports ignored", () => {
    expect(comparePorts(COMMUNITY, STENCIL.ports)).toEqual(["hdmi input: 1 → 2"]);
    expect(comparePorts([{ ...COMMUNITY[3], connectorType: "barrel" }], [{ ...COMMUNITY[3], connectorType: "phoenix" }])).toEqual(["power input: barrel → phoenix"]);
  });

  it("stencilPortsFor borrows notes and the connector the drawing leaves out, keeps the config port", () => {
    const { ports, borrowed } = stencilPortsFor({ voltage: "12V DC", ports: COMMUNITY }, STENCIL);
    expect(ports.map((p) => `${p.label} ${p.connectorType ?? "-"} ${p.notes ?? ""}`.trim())).toEqual([
      "HDMI In 1 hdmi HDCP 2.3",
      "HDMI In 2 hdmi",
      "DTP Out rj45",
      "USB Config usb-c",
      "Power phoenix 12 VDC, 2-pole",
    ]);
    expect(borrowed).toBe(4);
    // An AC card without a community port: the IEC inlet of an internal supply.
    expect(stencilPortsFor({ voltage: "100-240V AC", ports: [] }, STENCIL).ports[3].connectorType).toBe("iec");
  });

  it("indexStencils prefers a clean current master", () => {
    const retired = { ...STENCIL, retired: true, ports: [...STENCIL.ports, STENCIL.ports[0]] };
    const broken = { ...STENCIL, issues: ["unknown label"] };
    expect(indexStencils([broken, retired, STENCIL]).get("60-1885-52")).toBe(STENCIL);
  });

  it("fills, replaces community ports, keeps what the stencil would lower, compares curated ones", () => {
    const files = [
      card("Extron DTP3 T 203", "60-1885-52"),
      card("Extron DTP3 R 203", "60-1886-52"),
      card("Extron DTP3 T 201", "60-1884-52"),
      card("Extron DTP3 T 210", "60-1887-52", { ports: COMMUNITY, _avail: { status: "ports-filled", portsSource: { kind: "datasheet", from: "https://x" } } }),
    ];
    const stencils: StencilBlock[] = [
      STENCIL,
      // The R 203 stencil draws no power connector; the community power port lends it.
      { ...STENCIL, partNumbers: ["60-1886-52"], model: "DTP3 R 203" },
      // T 201: no community ports — filled, even though the power connector is missing.
      { ...STENCIL, partNumbers: ["60-1884-52"], model: "DTP3 T 201" },
      { ...STENCIL, partNumbers: ["60-1887-52"], model: "DTP3 T 210" },
    ];
    const db = [donor(COMMUNITY), donor([COMMUNITY[0], COMMUNITY[1], COMMUNITY[3], STENCIL.ports[1]], { id: "db-2", modelNumber: "60-1886-52" })];
    const r = fillCatalogPorts(files, { library: [], db, stencils });
    const by = (f: string) => r.stencil.find((x) => x.file === f)!;
    expect(by("extron/extron-dtp3-t-203.json")).toMatchObject({ action: "replaced", differences: ["hdmi input: 1 → 2"], levelAfter: "A" });
    // The drawing has no power connector; the Extron 12 V DC rule gives the captive screw.
    expect(by("extron/extron-dtp3-t-201.json")).toMatchObject({ action: "filled", levelBefore: "none", levelAfter: "A" });
    expect(by("extron/extron-dtp3-t-210.json")).toMatchObject({ action: "compared" });
    const t203 = r.changed.find((c) => c.file === "extron/extron-dtp3-t-203.json")!.template;
    expect(t203._avail.portsSource).toMatchObject({ kind: "stencil", match: "part-number", level: "A" });
    expect(t203.ports.map((p) => (p as { label: string }).label)).toEqual(["HDMI In 1", "HDMI In 2", "DTP Out", "USB Config", "Power"]);

    // Second run over the written files: nothing changes.
    const again = fillCatalogPorts(files.map((f) => r.changed.find((c) => c.file === f.file) ?? f), { library: [], db, stencils });
    expect(again.changed).toEqual([]);

    const md = formatStencilReport(r, true);
    expect(by("extron/extron-dtp3-r-203.json")).toMatchObject({ action: "replaced", levelBefore: "B", levelAfter: "A" });
    expect(md).toContain("| replaced | 2 |");
    expect(md).toContain("## Compared: curated or datasheet ports kept (1)");
  });

  it("a stencil that would lower the level leaves the community ports and is listed as kept", () => {
    const files = [card("Extron DTP3 T 203", "60-1885-52")];
    // The drawing has a Digital I/O without a connector; no community port can lend one.
    const gpio = { id: "vx-5", label: "Digital I/O", signalType: "gpio", direction: "bidirectional" as const, section: "Digital I/O" };
    const stencil = { ...STENCIL, ports: [...STENCIL.ports.slice(0, 3), gpio, STENCIL.ports[3]] };
    const r = fillCatalogPorts(files, { library: [], db: [donor(COMMUNITY)], stencils: [stencil] });
    expect(r.stencil[0]).toMatchObject({ action: "kept", differences: ["gpio bidirectional: 0 → 1", "hdmi input: 1 → 2"], levelAfter: "A" });
    expect(r.changed[0].template._avail.portsSource).toMatchObject({ kind: "db" });
    expect(formatStencilReport(r, false)).toContain("## Kept: the stencil would lower the level — merge by hand (1)");
  });

  it("Extron cards without a stencil are listed; other vendors are not", () => {
    const files = [card("Extron DTP3 T 999", "60-0000-00"), { ...card("Biamp Parlé", "911.0000"), template: { ...card("Biamp Parlé", "911.0000").template, manufacturer: "Biamp" } }];
    const r = fillCatalogPorts(files, { library: [], db: [], stencils: [STENCIL] });
    expect(r.stencilMissing.map((x) => x.file)).toEqual(["extron/extron-dtp3-t-999.json"]);
  });
});

describe("Extron 12 V DC rule and chassis slots", () => {
  it("a 12 V DC card without a power input gets 12V DC In; a power input without a connector gets the captive screw", () => {
    const hdmi = { id: "1", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi", section: "Video Inputs" };
    expect(withExtronDcPower({ id: "x", voltage: "12V DC" }, [hdmi])).toEqual([
      hdmi,
      { id: "x-dc12", label: "12V DC In", signalType: "power", direction: "input", connectorType: "phoenix", section: "Power", notes: EXTRON_DC_NOTE },
    ]);
    const bare = { id: "2", label: "Power", signalType: "power", direction: "input", section: "Power" };
    expect(withExtronDcPower({ voltage: "12 VDC / PoE 802.3af" }, [bare])[0]).toMatchObject({ connectorType: "phoenix", notes: EXTRON_DC_NOTE });
    const ports = [hdmi, { ...bare, connectorType: "barrel" }];
    expect(withExtronDcPower({ voltage: "12V DC" }, ports)).toBe(ports);
    expect(withExtronDcPower({ voltage: "100-240V AC" }, [hdmi])).toEqual([hdmi]);
  });

  it("the rule applies to community ports of Extron cards, not to datasheet ports", () => {
    const noPower = COMMUNITY.filter((p) => p.signalType !== "power");
    const files = [card("Extron DTP3 R 203", "60-1886-52"), card("Extron DTP3 R 210", "60-1888-52", { ports: noPower, _avail: { status: "ports-filled", portsSource: { kind: "datasheet" } } })];
    const r = fillCatalogPorts(files, { library: [], db: [donor(noPower, { modelNumber: "60-1886-52" })], stencils: [] });
    const t = r.changed.find((c) => c.file === "extron/extron-dtp3-r-203.json")!.template;
    expect(t.ports.map((p) => (p as { label: string }).label)).toContain("12V DC In");
    expect(r.changed.find((c) => c.file === "extron/extron-dtp3-r-210.json")).toBeUndefined();
  });

  it("chassis slots: the count from the description, else the reason", () => {
    expect(chassisSlotsFromDescription({ _avail: { slotFamilies: ["extron-cubby-aap"], description: "Cable Cubby Under-table Drawer for 4 AAP Modules" } }).slots).toHaveLength(4);
    expect(chassisSlotsFromDescription({ _avail: { slotFamilies: ["extron-cubby-aap"], description: "Cable Cubby 202 EU AC, Black" } }).missing).toMatch(/openings/);
  });

  it("a chassis without slots takes its regional variants' slots, or records portsMissing", () => {
    const slots = [{ id: "slot-1", label: "Slot 1", slotFamily: "extron-cubby-maap" }];
    const chassis = (label: string, pn: string, extra: Partial<CatalogTemplate> = {}) =>
      card(label, pn, { deviceType: "table-box", voltage: "100-240V AC", _avail: { status: "awaiting-ports", slotFamilies: ["extron-cubby-maap"] }, ...extra });
    const files = [
      chassis("Extron Cable Cubby 100 EU AC", "60-1592-03", { slots, ports: [COMMUNITY[3]], _avail: { status: "ports-filled", slotFamilies: ["extron-cubby-maap"], portsSource: { kind: "db", from: "x" } } }),
      chassis("Extron Cable Cubby 100 AUS AC", "60-1592-04"),
      chassis("Extron Cable Cubby 202 EU", "60-1400-02"),
    ];
    const eu = donor([COMMUNITY[3]], { id: "db-eu", label: "Extron Cable Cubby 100 EU AC", modelNumber: "60-1592-03", slots });
    const r = fillCatalogPorts(files, { library: [], db: [eu], stencils: [STENCIL] });
    const get = (f: string) => r.changed.find((c) => c.file === f)!.template;
    expect(get("extron/extron-cable-cubby-100-aus-ac.json").slots).toEqual(slots);
    expect(get("extron/extron-cable-cubby-100-aus-ac.json")._avail.slotsSource).toBe("variant: extron/extron-cable-cubby-100-eu-ac.json");
    expect(get("extron/extron-cable-cubby-202-eu.json")._avail.portsMissing).toMatch(/openings/);
    expect(r.chassis.map((c) => c.label)).toEqual(["Extron Cable Cubby 100 AUS AC", "Extron Cable Cubby 202 EU"]);
  });

  it("linter: a chassis with slots only is not 'no ports', but every slot needs a family", () => {
    const base = card("Extron CCD 220", "70-1277-02", { deviceType: "table-box", category: "Connectivity / Architectural", voltage: undefined, powerDrawW: undefined }).template;
    const ok = lintBlock({ ...base, slots: [{ id: "s1", label: "Slot 1", slotFamily: "extron-cubby-aap" }] });
    expect(ok.errors).toEqual([]);
    const bad = lintBlock({ ...base, slots: [{ id: "s1", label: "Slot 1" }] });
    expect(bad.warnings).toContain('slot "Slot 1": no slotFamily');
    expect(lintBlock(base).errors).toContain("no ports");
  });
});
