/**
 * Extron Visio stencils (Engineering Drawings, logical view; tools/avail/incoming/extron-visio,
 * step 1.10): ports of a product from its stencil master.
 *
 * A master is a group shape. Its Property section has Make, Model, Part #, Description,
 * Web Page. Inside, small text shapes name the ports: a label ("HDMI", "DTP/HDBTOUT",
 * "RS-232 [REMOTE ]") hugging the left or right edge, just below it a connector in square
 * brackets ("[F TYPE A]", "[RJ-45 F]", "[3 POLE CS]"), and on the left the input number ("1",
 * "001", "5A"). Left is the input side, right the output side. Connection points are not used
 * to find ports: some masters miss one (DMP 128 Plus output 5), touch panels and cable cubbies
 * have them in the middle of the shape. Rows are built from the texts instead.
 *
 *   parseXml → mastersOfXml (geometry and properties) → stencilRows (label/connector/number per
 *   row, top to bottom) → stencilPorts (ports in the AVAIL standard form, with issues).
 *
 * Nothing is guessed: a label or connector the tables do not know, or a pin-level drawing,
 * becomes an issue, and a master with issues is not applied (see extronStencil.ts).
 * Pure functions, no Node or browser dependencies.
 */

import { BLOCK_SECTIONS } from "./sections";

// ---------------------------------------------------------------------------- XML

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text content directly inside this element, in order with children (for itertext). */
  parts: (string | XmlNode)[];
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Minimal XML parser for Visio parts: elements, attributes, text; no DTD, no namespaces resolved. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], parts: [] };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.parts.push(m[1]);
    } else if (m[3] !== undefined) {
      const name = m[3].replace(/^.*:/, "");
      if (m[2] === "/") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[4] ?? ""))) attrs[a[1].replace(/^.*:/, "")] = unescapeXml(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name, attrs, children: [], parts: [] };
      top.children.push(node);
      top.parts.push(node);
      if (m[5] !== "/") stack.push(node);
    } else if (m[6] !== undefined) {
      top.parts.push(unescapeXml(m[6]));
    }
  }
  return root;
}

function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

function childrenNamed(n: XmlNode | undefined, name: string): XmlNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

function itertext(n: XmlNode): string {
  return n.parts.map((p) => (typeof p === "string" ? p : itertext(p))).join("");
}

// ---------------------------------------------------------------------------- masters

export interface VisioText {
  /** Bottom-left corner and size in inches, in the master's coordinates (origin bottom-left). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  text: string;
}

export interface VisioMaster {
  /** Stencil file (path inside the stencil folder). */
  stencil: string;
  /** Master name ("DTP3 T 101 D Black, 60-1902-52"). */
  name: string;
  /** Shape data by label: Make, Model, Part #, Description, Web Page… */
  props: Record<string, string>;
  width: number;
  height: number;
  texts: VisioText[];
}

function cellsOf(n: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of childrenNamed(n, "Cell")) if (c.attrs.N) out[c.attrs.N] = c.attrs.V ?? "";
  return out;
}

function num(v: string | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function cleanText(s: string): string {
  return s.replace(/[\u200b\u00a0\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

function propsOf(shape: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sec of childrenNamed(shape, "Section")) {
    if (sec.attrs.N !== "Property") continue;
    for (const row of childrenNamed(sec, "Row")) {
      const c = cellsOf(row);
      const key = (c.Label || row.attrs.N || "").trim();
      if (key) out[key] = cleanText(c.Value ?? "");
    }
  }
  return out;
}

function collectTexts(shape: XmlNode, ox: number, oy: number, out: VisioText[]): void {
  const c = cellsOf(shape);
  const x0 = ox + num(c.PinX) - num(c.LocPinX);
  const y0 = oy + num(c.PinY) - num(c.LocPinY);
  const t = child(shape, "Text");
  const text = t ? cleanText(itertext(t)) : "";
  if (text) out.push({ x0, y0, w: num(c.Width), h: num(c.Height), text });
  for (const s of childrenNamed(child(shape, "Shapes"), "Shape")) collectTexts(s, x0, y0, out);
}

/** Masters of one master part (visio/masters/masterN.xml): usually one top-level group. */
export function mastersOfXml(xml: string, stencil: string): VisioMaster[] {
  const doc = parseXml(xml);
  const contents = child(doc, "MasterContents");
  const out: VisioMaster[] = [];
  for (const top of childrenNamed(child(contents, "Shapes"), "Shape")) {
    const c = cellsOf(top);
    const texts: VisioText[] = [];
    for (const s of childrenNamed(child(top, "Shapes"), "Shape")) collectTexts(s, 0, 0, texts);
    out.push({
      stencil,
      name: cleanText(top.attrs.NameU ?? top.attrs.Name ?? ""),
      props: propsOf(top),
      width: num(c.Width),
      height: num(c.Height),
      texts,
    });
  }
  return out;
}

const PART_RE = /\b\d{2}-\d{3,4}-\d{2,3}\b/g;

/** Part numbers of a master: Part # and the one in the master name (they differ on some). */
export function partNumbersOf(m: VisioMaster): string[] {
  // Part # only: master names are copied between products ("IPCP Pro 250 xi, 60-1911-01" on a
  // DTP3 T 203); the name is used only when Part # is empty.
  const own = [...(m.props["Part #"] ?? "").matchAll(PART_RE)].map((x) => x[0]);
  return [...new Set(own.length ? own : [...m.name.matchAll(PART_RE)].map((x) => x[0]))];
}

// ---------------------------------------------------------------------------- rows

export type Side = "left" | "right";

/** One drawn port: its texts, top to bottom on a side. */
export interface StencilRow {
  side: Side;
  /** y of the row's anchor (label centre, or of the number/connector that started it). */
  y: number;
  labels: string[];
  connectors: string[];
  numbers: string[];
  /** A stereo pair drawn as L and R rows, merged into this row. */
  stereo?: boolean;
  /** Functions sharing one connector drawn as a tight cluster of rows: their labels. */
  shared?: string[];
}

const CONNECTOR_TEXT_RE = /^\[[^\]]*\]?$/;
const NUMBER_TEXT_RE = /^\d{1,3}[A-Z]?$/;
/** Header texts and decorations that are not ports. */
const DECORATION_RE = /^(ip\b.*:|.*:$|white|black|custom)$/i;

function isConnectorText(t: string): boolean {
  return CONNECTOR_TEXT_RE.test(t);
}

/**
 * Rows of a master. Header texts (model, part number, equipment ID) and texts outside the
 * port area are left out and returned as `stray`.
 */
export function stencilRows(m: VisioMaster): { rows: StencilRow[]; stray: string[] } {
  const header = new Set(
    ["Model", "Part #", "Equipment ID", "Shape Name", "Version", "Description"]
      .map((k) => (m.props[k] ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const W = m.width;
  const stray: string[] = [];
  type T = VisioText & { side: Side; cy: number };
  const items: T[] = [];
  for (const t of m.texts) {
    const low = t.text.toLowerCase();
    const dl = t.x0;
    const dr = W - (t.x0 + t.w);
    // The header repeats model, part number and equipment ID centred; a port label hugs an edge
    // and may equal the equipment ID ("ACP" on an ACP 100).
    const centred = Math.abs(dl - dr) < W * 0.15;
    if ((header.has(low) && centred) || DECORATION_RE.test(t.text) || new RegExp(PART_RE.source).test(t.text)) continue;
    // Outside the body (title above, notes below).
    if (t.y0 + t.h / 2 > m.height || t.y0 + t.h / 2 < 0) {
      stray.push(t.text);
      continue;
    }
    // A wide centred text is a title, not a port.
    if (t.w > W * 0.7 && Math.abs(dl - dr) < W * 0.1) {
      stray.push(t.text);
      continue;
    }
    items.push({ ...t, side: dl <= dr ? "left" : "right", cy: t.y0 + t.h / 2 });
  }
  const rows: StencilRow[] = [];
  const near = (side: Side, y: number, tol: number, pred: (r: StencilRow) => boolean = () => true) =>
    rows
      .filter((r) => r.side === side && Math.abs(r.y - y) <= tol && pred(r))
      .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];

  // Labels make rows; labels on one line (within 0.05") share a row ("Fiber [LC]" + "IN").
  const labels = items.filter((t) => !isConnectorText(t.text) && !NUMBER_TEXT_RE.test(t.text)).sort((a, b) => b.cy - a.cy);
  for (const t of labels) {
    const r = near(t.side, t.cy, 0.05);
    if (r) r.labels.push(t.text);
    else rows.push({ side: t.side, y: t.cy, labels: [t.text], connectors: [], numbers: [] });
  }
  // Numbers sit level with the label (a little higher or lower).
  for (const t of items.filter((x) => NUMBER_TEXT_RE.test(x.text))) {
    const r = near(t.side, t.cy, 0.11, (row) => row.numbers.length === 0);
    if (r) r.numbers.push(t.text);
    else rows.push({ side: t.side, y: t.cy, labels: [], connectors: [], numbers: [t.text] });
  }
  // A connector sits just below its label: the nearest row above it, else the nearest row.
  for (const t of items.filter((x) => isConnectorText(x.text)).sort((a, b) => b.cy - a.cy)) {
    const above = rows
      .filter((r) => r.side === t.side && r.y - t.cy > 0 && r.y - t.cy <= 0.2 && r.connectors.length === 0)
      .sort((a, b) => a.y - b.y)[0];
    const r = above ?? near(t.side, t.cy, 0.12, (row) => row.connectors.length === 0);
    if (r) r.connectors.push(t.text);
    else rows.push({ side: t.side, y: t.cy + 0.08, labels: [], connectors: [t.text], numbers: [] });
  }
  rows.sort((a, b) => (a.side === b.side ? b.y - a.y : a.side === "left" ? -1 : 1));
  return { rows, stray };
}

// ---------------------------------------------------------------------------- tables

type Dir = "input" | "output" | "bidirectional";

/** Connector text (without brackets, upper case, spaces collapsed) → connector, per signal. */
export function connectorOf(raw: string, signal: string): { connector?: string; notes?: string } {
  const k = raw
    .replace(/[[\]]/g, "")
    .replace(/[\u200b]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const pole = /^(\d+)(?:\/(\d+))?\s*-?\s*(?:POLE|P)\s*-?\s*CS$/.exec(k) ?? /^(\d+)POLE[- ]?CS$/.exec(k);
  if (pole) return { connector: "phoenix", notes: `${pole[2] ? `${pole[1]}/${pole[2]}` : pole[1]}-pole captive screw` };
  if (/^(F TYPE A|F TYPE|TYPE A F|TYP A F|TYPE A SS F|USB TYPE A|USB [0-9.X/]+ ?(TYPE )?A|USB 3\.2 A)$/.test(k)) {
    // "F TYPE A" is a female type A: HDMI on video ports, USB-A on USB ports.
    if (signal === "usb") return { connector: "usb-a" };
    if (signal === "hdmi") return { connector: "hdmi" };
    // Type A on another signal (a "DisplayPort" drawn with [F TYPE A]): the drawing contradicts
    // itself, the port goes to the report.
    if (signal) return {};
    return k.startsWith("F TYPE") ? { connector: "hdmi" } : { connector: "usb-a" };
  }
  if (/^RJ[- ]?45( ?F)?$/.test(k)) return { connector: "rj45" };
  if (/^(USB[- ]?C( F)?|TYPE C F|TYPE USB[- ]?C( [FM])?|USB TYPE C|USB 3\.X TYPE C)$/.test(k)) return { connector: "usb-c" };
  if (/^(TYPE B( F)?|TYP B F|USB TYPE B|TYPE B SS F|USB 3\.2 TYPE B|TYPE USB B)$/.test(k)) return { connector: "usb-b" };
  if (/^MICRO-?B( & A)?$/.test(k)) return { connector: "usb-micro" };
  if (/^(USB MINI F|MINI USB B|USBMINI TYPE B)$/.test(k)) return { connector: "usb-mini" };
  if (/^(2X )?LC$/.test(k)) return { connector: "lc" };
  if (/^SFP\+?( F)?$/.test(k)) return { connector: "sfp" };
  if (/^MTP\/MPO$/.test(k)) return { connector: "mpo" };
  if (/^(RCA F|L\/R RCA|L\/R CINCH)$/.test(k)) return { connector: "rca", ...(k.startsWith("L/R") ? { notes: "L/R RCA pair" } : {}) };
  if (/^HD15[- ]F$/.test(k)) return { connector: signal === "vga" ? "vga" : "db15" };
  if (/^(DISP[- ]PORT[- ]F|DISPLAYPORT F|DP TYPE F)$/.test(k)) return { connector: "displayport" };
  if (/^(3[.,]5 (MM )?JACK( F)?|3\.5 MM S)$/.test(k)) return { connector: "trs-eighth" };
  if (/^(\d )?BNC([- ]F)?$/.test(k)) {
    const n = /^(\d) /.exec(k)?.[1];
    return { connector: "bnc", ...(n && n !== "1" ? { notes: `${n} BNC` } : {}) };
  }
  if (/^DVI-I F$/.test(k)) return { connector: "dvi", notes: "DVI-I" };
  if (/^IEC(-[FM])?$/.test(k)) return { connector: "iec" };
  if (/^3 PIN XLR F$/.test(k)) return { connector: "xlr-3" };
  if (/^RJ-11 F$/.test(k)) return { connector: "rj11" };
  if (/^TOSLINK( F)?$/.test(k)) return { connector: "toslink" };
  return {};
}

interface LabelRule {
  re: RegExp;
  signal: string;
  /** Port name without direction and number ("HDMI", "Audio", "DTP"). */
  name: string | ((m: RegExpExecArray) => string);
  /** Forced direction; otherwise from the label words, then from the side (video, audio). */
  dir?: Dir;
  /** Suffix in brackets: "Loop", "Remote", "PoE"… */
  suffix?: string;
  section?: string;
  notes?: string;
  /** Direction follows the side (left input, right output) unless the label says In/Out. */
  sided?: boolean;
}

const LOOP = /\bLOOP\b/;

/**
 * Label (upper case, without a trailing connector in brackets) → signal and name. First match
 * wins; order matters (LAN + PWR OUT before LAN, RS-232/IR before RS-232).
 */
const LABEL_RULES: LabelRule[] = [
  // --- video
  { re: /^HDMI( ?\/ ?CEC)?( -)? LOOP( OUT)?$/, signal: "hdmi", name: "HDMI", dir: "output", suffix: "Loop" },
  { re: /^HDMI( ?\/? ?CEC)?( IN| OUT| INPUT| OUTPUT)?$/, signal: "hdmi", name: "HDMI", sided: true },
  { re: /^DISABLED SELECTABLE I\/O$/, signal: "hdbaset", name: "DTP3/XTP I/O", dir: "bidirectional", notes: "configurable input/output" },
  { re: /^(DTP ?\d?|XTP|HDBT|HC|DTP\d?\/XTP|DTP\d?\/XTP\/HDBT|DTP\d?\/HDBT)( ?IN| ?OUT| ?INPUT| ?OUTPUT)?$/, signal: "hdbaset", name: (m) => m[1].replace(/\s+/g, "").replace(/^HC$/, "HC Link"), sided: true },
  { re: /^(XTP|DTP\d?) PWR$/, signal: "power", name: (m) => `${m[1]} Power`, dir: "output" },
  { re: /^(DP|DISPLAY ?PORT)( IN| OUT)?$/, signal: "displayport", name: "DisplayPort", sided: true },
  { re: /^DVI( IN| OUT)?$/, signal: "dvi", name: "DVI", sided: true },
  { re: /^(VGA|RGBHV)( IN| OUT)?$/, signal: "vga", name: (m) => m[1], sided: true },
  { re: /^((3G|12G|HD)[- /]*(HD-)?SDI|SDI|\d+G HD-SDI|\d+G\/HD-SDI)( LOOP)?( IN| OUT)?$/, signal: "sdi", name: (m) => m[1].replace(/\s+/g, " "), sided: true },
  { re: /^B-Y, ?R-Y, ?VID\/Y$/, signal: "component-video", name: "Component", sided: true },
  { re: /^(FIBER|FIBRE)( \[LC\])?( IN OUT| OUT IN| I\/O)$/, signal: "fiber", name: "Fiber I/O", dir: "bidirectional" },
  { re: /^(FIBER|FIBRE)( \[LC\])?( IN| OUT| TX| RX)?( [AB])?$/, signal: "fiber", name: "Fiber", sided: true },
  // --- audio
  { re: /^(MIC\/LINE|LINE\/ ?MIC)$/, signal: "analog-audio", name: "Mic/Line", dir: "input" },
  { re: /^MIC$/, signal: "analog-audio", name: "Mic", dir: "input" },
  { re: /^(AUX AUDIO|PROG AUDIO|FIXED AUDIO|AUDIO RET(URN)?|AUDIO( -)? LOOP|AUDIO( L\+R| L| R)?|AUDIO IN|AUDIO OUT|LINE( IN| OUT)?|LOOP OUT)$/, signal: "analog-audio", name: (m) => audioName(m[0]), sided: true },
  { re: /^S\/PDIF( IN| OUT)?$/, signal: "spdif", name: "S/PDIF", sided: true },
  { re: /^DANTE( PRI| SEC| POE)?$/, signal: "dante", name: "Dante", dir: "bidirectional" },
  { re: /^AT ?(\d)? ?(PRI|SEC)?$/, signal: "dante", name: "Dante", dir: "bidirectional", notes: "Extron AT (Dante)" },
  { re: /^(SA OUT|MA OUT|AMP OUT|AMP OUTPUT|LS OUT|SPEAKER|OUT \d+ ?Ω)\b.*$|^\d+(Ω|\/\d+ OHM)|^(70|100) ?V OUT(PUT)?$/, signal: "speaker-level", name: "Speaker Out", dir: "output" },
  { re: /^USB AUDIO$/, signal: "usb", name: "USB Audio", dir: "bidirectional", section: "USB" },
  // --- network
  { re: /^LAN \+ PWR OUT$/, signal: "ethernet", name: "LAN", dir: "bidirectional", suffix: "PoE Out" },
  { re: /^(AV LAN|LAN|ETHERNET|NETWORK|STREAMING LAN|VOIP|EXT \d+G|NAV \d+G)( [AB0-9])?( ?\/? ?(POE\+?|AT( \(POE\))?|XTP))?$/, signal: "ethernet", name: (m) => lanName(m), dir: "bidirectional" },
  // --- control
  { re: /^(RS-?232|COM) ?\/ ?IR( XTP| DTP\d?)?$/, signal: "serial", name: "RS-232/IR", dir: "bidirectional", notes: "RS-232 and IR on one connector" },
  { re: /^IR ?\/ ?(SERIAL|S)( \d+)?$/, signal: "ir", name: "IR/S", dir: "output", notes: "IR or one-way RS-232" },
  { re: /^(RS[- ]?232|COM)( ?\d+)?( REMOTE| REM\.| DISPLAY| - PASS| ?\/ ?AUTO)?$/, signal: "serial", name: (m) => (m[1] === "COM" ? "COM" : "RS-232"), dir: "bidirectional" },
  { re: /^IR( OUT| IN| DTP\d?)?$/, signal: "ir", name: "IR", sided: true },
  { re: /^RELAY( \d+)?$/, signal: "contact-closure", name: "Relay", dir: "output" },
  { re: /^(DIGITAL I\/O|DIG I\/O|FLEX I\/O)$/, signal: "gpio", name: (m) => (m[1].startsWith("FLEX") ? "Flex I/O" : "Digital I/O"), dir: "bidirectional" },
  { re: /^(DIGITAL IN|D IN)$/, signal: "gpio", name: "Digital In", dir: "bidirectional" },
  { re: /^(CONTACT IN|CONT CLOS(URE)?|CONTACT|CONT)$/, signal: "contact-closure", name: "Contact In", dir: "input" },
  { re: /^TALLY( OUT)?$/, signal: "tally", name: "Tally Out", dir: "output" },
  { re: /^VOL$/, signal: "control-voltage", name: "Volume Control", dir: "output" },
  { re: /^(\d+ )?VOL ?\/ ?MUTE$/, signal: "control-voltage", name: "Volume/Mute Control", dir: "input" },
  { re: /^(REMOTE|CONTROL)$/, signal: "gpio", name: (m) => (m[1] === "REMOTE" ? "Remote" : "Control"), dir: "bidirectional" },
  { re: /^STANDBY$/, signal: "contact-closure", name: "Standby", dir: "input" },
  { re: /^IR ?\/ ?C IN$/, signal: "ir", name: "IR/Contact", dir: "input" },
  { re: /^3D SYNC$/, signal: "custom", name: "3D Sync", dir: "output", section: "Sync", notes: "3D sync for stereo emitters" },
  { re: /^EBUS$/, signal: "ebus", name: "eBUS", dir: "bidirectional" },
  { re: /^ACP$/, signal: "ebus", name: "ACP Bus", dir: "bidirectional" },
  { re: /^(DMP EXP|EXP BUS|EXP)$/, signal: "extron-exp", name: "EXP", dir: "bidirectional" },
  { re: /^GENLOCK$/, signal: "genlock", name: "Genlock", dir: "input" },
  // --- USB
  { re: /^(USB(-C)?)( HOST)$/, signal: "usb", name: (m) => `${m[1]} Host`, dir: "bidirectional", section: "USB" },
  { re: /^(USB HID|USB K\/B|USB MOUSE|DEVICE USB|USB STORAGE|CONTROL USB|USB TLP|NETWORK USB|USB MINI)$/, signal: "usb", name: (m) => titleWords(m[1]), dir: "bidirectional", section: "USB" },
  { re: /^USB-C( \d+W)?$/, signal: "usb", name: "USB-C", dir: "bidirectional" },
  { re: /^LINK TO RX$/, signal: "usb", name: "USB Link to Rx", dir: "bidirectional", section: "USB" },
  { re: /^(USB|SS \d+G)( ?\d(\.\d|\.X)?)?( ?\/ ?\d\.X)?( DEV)?$/, signal: "usb", name: "USB", dir: "bidirectional", section: "USB" },
  // --- more spellings seen in the stencils
  { re: /^HDMI (PREVIEW|PROGRAM)$/, signal: "hdmi", name: (m) => `HDMI ${titleWords(m[1])}`, dir: "output" },
  { re: /^DP LOOP( THR(U)?)?$/, signal: "displayport", name: "DisplayPort", dir: "output", suffix: "Loop" },
  { re: /^(RGB|RGBHV)( LOOP| LOOP OUT)$/, signal: "vga", name: (m) => m[1], dir: "output", suffix: "Loop" },
  { re: /^RGB$/, signal: "vga", name: "RGB", sided: true },
  { re: /^VIDEO$/, signal: "composite", name: "Video", sided: true },
  { re: /^DTP\d?( OUT)?\/HDBT( OUT)?$/, signal: "hdbaset", name: "DTP/HDBT", dir: "output" },
  { re: /^(DTP|XTP)? ?(RS-232|RS-232\/IR|IR) ?(OVER|\/OVER)? ?(DTP|XTP|TP)$|^DTP (RS-232\/IR)$/, signal: "serial", name: (m) => (m[2] === "IR" ? "IR" : m[2] ?? m[5] ?? "RS-232"), dir: "bidirectional", suffix: "Over TP" },
  { re: /^(RS-232\/REMOTE|DISP RS-232|COM RS-232|MLC\/RS-232|RS-232\/MUTE|RS-232\/DIG IN)$/, signal: "serial", name: (m) => (m[1].startsWith("DISP") ? "RS-232 (Display)" : m[1].startsWith("COM") ? "COM" : "RS-232"), dir: "bidirectional" },
  { re: /^IR TX$/, signal: "ir", name: "IR", dir: "output" },
  { re: /^(CONTACT IN\/TALLY OUT|CONTACT TALLY|CC\/TALLY|CON\/TALLY|BUTTON \d CC AND TALLY|\d\/\d CONTACT TALLY)$/, signal: "contact-closure", name: "Contact/Tally", dir: "input", notes: "contact inputs and tally outputs" },
  { re: /^MUTE( \d)?$/, signal: "contact-closure", name: "Mute", dir: "input" },
  { re: /^(VOL CTL|VOLUME|CONTROL 10V\/VOL\/GND|10 VOLT\/MUTE|VOL\/MUTE\/STANDBY)$/, signal: "control-voltage", name: "Volume Control", dir: "input" },
  { re: /^STANDBY CTL$/, signal: "contact-closure", name: "Standby", dir: "input" },
  { re: /^(OCCUPANCY( PHOTOCELL)? CTRL|PAGING SENSOR|TEMP)$/, signal: "sensor", name: (m) => titleWords(m[1].replace(/ CTRL$/, "")), dir: "input" },
  { re: /^(LAN\/VOIP|CONTROL LAN( \d)?|OOB|NAV)$/, signal: "ethernet", name: (m) => (m[1] === "OOB" ? "LAN (OOB)" : m[1] === "NAV" ? "NAV" : m[1].startsWith("CONTROL") ? `Control LAN${m[2] ?? ""}` : "LAN"), dir: "bidirectional" },
  { re: /^(USB 10GBPS|USB 3\.1 STORAGE|USB-3\.2|USB 2\.0 HID \d+MA|USB 2\.0 HOST|USB EXT PLUS|USB MINI F|USB-C IN)$/, signal: "usb", name: (m) => (/HOST/.test(m[1]) ? "USB Host" : /HID/.test(m[1]) ? "USB HID" : /^USB-C/.test(m[1]) ? "USB-C" : "USB"), dir: "bidirectional", section: "USB" },
  { re: /^EXP (INPUT|THRU)$/, signal: "extron-exp", name: (m) => (m[1] === "THRU" ? "EXP Thru" : "EXP In"), dir: "bidirectional" },
  { re: /^(REF|GENLOCK LOOP OUT)$/, signal: "genlock", name: (m) => (m[1] === "REF" ? "Reference" : "Genlock Loop") },
  { re: /^AUDIO 70V$/, signal: "speaker-level", name: "Speaker Out (70V)", dir: "output" },
  { re: /^(AUDIO (C|LF|LS|RF|RS|SUB|MIX|PREVIEW|PROGRAM)|VARIABLE AUDIO|RETURN AUDIO|LINEOUT|LINE OUTPUT|MIC INPUT|MIC\/LINE IN \d|PREAMP|AUX|AUX\/MIX)$/, signal: "analog-audio", name: (m) => moreAudioName(m[0]), sided: true },
  // --- power
  { re: /^(USB|USB-C) POWER$/, signal: "power", name: (m) => `${m[1]} Power`, sided: true },
  { re: /^(\+V OUT|\+V OUT \d+V|V\+ OUT|\d+ ?V OUTPUT|\d+ ?V OUT|\d+V LOOP OUT|AC OUT|SWITCHED (AC|\d+ ?VDC)( \d+)?|UPI \d+ PWR INSERT|POWER INSERT|PWR INSERT)$/, signal: "power", name: (m) => powerOutName(m[1]), dir: "output" },
  { re: /^(POWER|POWER \d+ ?V|POWER \d+ ?VDC|\d+ ?VDC|\d+-\d+ ?V|\d+V IN|AC IN|AC POWER IN|V\+ IN|USB POWER IN)$/, signal: "power", name: (m) => (/USB/.test(m[1]) ? (/USB-C/.test(m[1]) ? "USB-C Power" : "USB Power") : /^AC/.test(m[1]) ? "AC Power" : "Power"), dir: "input" },
];

function titleWords(s: string): string {
  const keep = new Set(["USB", "HID", "TLP", "K/B", "LAN", "AV", "IR", "DTP", "XTP", "HDMI", "SS"]);
  return s
    .split(" ")
    .map((w) => (keep.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ")
    .replace("K/B", "Keyboard");
}

function audioName(raw: string): string {
  if (/^AUX AUDIO/.test(raw)) return "Aux Audio";
  if (/^PROG AUDIO/.test(raw)) return "Program Audio";
  if (/^FIXED AUDIO/.test(raw)) return "Audio (Fixed)";
  if (/^AUDIO RET/.test(raw)) return "Audio Return";
  if (/^LINE/.test(raw)) return "Line";
  if (LOOP.test(raw)) return "Audio Loop";
  return "Audio";
}

function lanName(m: RegExpExecArray): string {
  const base = m[1].startsWith("STREAMING") ? "Streaming LAN" : m[1] === "AV LAN" ? "AV LAN" : m[1] === "VOIP" ? "VoIP LAN" : /^(EXT|NAV)/.test(m[1]) ? m[1].replace(/G$/, "G").replace(/^NAV/, "NAV") : "LAN";
  const tag = m[2]?.trim();
  return tag ? `${base} ${tag}` : base;
}

function moreAudioName(raw: string): string {
  const k = raw.replace(/^AUDIO /, "");
  const named: Record<string, string> = {
    C: "Audio (Center)", LF: "Audio (Left Front)", RF: "Audio (Right Front)", LS: "Audio (Left Surround)", RS: "Audio (Right Surround)",
    SUB: "Audio (Sub)", MIX: "Audio (Mix)", PREVIEW: "Audio (Preview)", PROGRAM: "Audio (Program)",
    "VARIABLE AUDIO": "Audio (Variable)", "RETURN AUDIO": "Audio Return", LINEOUT: "Line", "LINE OUTPUT": "Line", "MIC INPUT": "Mic",
    PREAMP: "Preamp", AUX: "Aux Audio", "AUX/MIX": "Aux/Mix Audio",
  };
  if (/^MIC\/LINE IN/.test(raw)) return "Mic/Line";
  return named[k] ?? named[raw] ?? "Audio";
}

function powerOutName(raw: string): string {
  if (/INSERT/.test(raw) && !/^UPI/.test(raw)) return "Power Out (Insert)";
  if (/^AC OUT/.test(raw)) return "AC Out";
  if (/LOOP OUT/.test(raw)) return "Power Out (Loop)";
  if (/^\+V OUT \d+V/.test(raw)) return `+${raw.replace(/^\+V OUT /, "")} Out`;
  if (/^\d+ ?V OUT$/.test(raw)) return `${raw.replace(/ ?V OUT$/, "")} V Out`;
  if (/^UPI/.test(raw)) return "Power Out (UPI Insert)";
  if (/^SWITCHED AC/.test(raw)) return "Switched AC Out";
  if (/^SWITCHED/.test(raw)) return "Switched 12 VDC Out";
  if (/OUTPUT/.test(raw)) return `${raw.replace(/\s*OUTPUT/, "").replace(/\s+/g, " ")} Out`;
  return "+V Out";
}

/** Signals whose direction follows the drawing side when the label does not say it. */
const SIDED = new Set(["hdmi", "hdbaset", "displayport", "dvi", "vga", "sdi", "component-video", "fiber", "analog-audio", "spdif", "ir"]);

const SECTION_OF: Record<string, (dir: Dir) => string> = {
  hdmi: (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  hdbaset: (d) => (d === "input" ? "Video Inputs" : d === "output" ? "Video Outputs" : "Video Inputs (Configurable)"),
  displayport: (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  dvi: (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  vga: (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  sdi: (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  "component-video": (d) => (d === "input" ? "Video Inputs" : "Video Outputs"),
  fiber: (d) => (d === "input" ? "Video Inputs" : d === "output" ? "Video Outputs" : "Network"),
  "analog-audio": (d) => (d === "input" ? "Audio Inputs" : "Audio Outputs"),
  spdif: (d) => (d === "input" ? "Audio Inputs" : "Audio Outputs"),
  "speaker-level": () => "Speaker Outputs",
  dante: () => "Dante",
  ethernet: () => "Network",
  serial: () => "Serial",
  ir: () => "IR",
  "contact-closure": (d) => (d === "output" ? "Relays" : "Control"),
  tally: () => "Control",
  "control-voltage": () => "Control",
  gpio: () => "Digital I/O",
  ebus: () => "Expansion",
  "extron-exp": () => "Expansion",
  genlock: () => "Sync",
  usb: () => "USB",
  power: () => "Power",
};

/** Connector that follows from the signal when the stencil draws none (standard 4.5). */
const IMPLIED_CONNECTOR: Record<string, string> = {
  hdmi: "hdmi",
  hdbaset: "rj45",
  ethernet: "rj45",
  dante: "rj45",
  "extron-exp": "rj45",
  displayport: "displayport",
  dvi: "dvi",
  vga: "vga",
  sdi: "bnc",
  genlock: "bnc",
  fiber: "lc",
};

/** Pin names drawn as rows of their own: part of a connector, not a port. */
const GROUND_RE = /^(GND|G|GROUND)$/i;
const PIN_RE = /^(C|T|\+V|V\+|L|R|A|B|NO|NC|S|TX|RX|[IO]\d|\+|-|C\/G\/T\/\+V)$/i;

const DIR_WORDS_IN = /\b(IN|INPUT|RX)\b/;
const DIR_WORDS_OUT = /\b(OUT|OUTPUT|TX|LOOP)\b/;

export interface StencilPort {
  id: string;
  label: string;
  signalType: string;
  direction: Dir;
  connectorType?: string;
  section: string;
  notes?: string;
}

export interface StencilBlock {
  partNumbers: string[];
  model: string;
  make: string;
  description: string;
  webPage: string;
  stencil: string;
  master: string;
  /** Stencil in a "Retired …" folder or file. */
  retired: boolean;
  /** Frame with slot positions drawn as numbers only (cards are separate products). */
  modularSlots?: number;
  ports: StencilPort[];
  /** Why the ports cannot be trusted as they are: unknown label/connector, pin-level drawing… */
  issues: string[];
}

interface Draft {
  side: Side;
  name: string;
  signal: string;
  dir: Dir;
  suffix?: string;
  section: string;
  connector?: string;
  notes: string[];
  number?: string;
  /** Label read as is; the row had no label of its own (took the neighbour's). */
  inherited?: boolean;
  /** Direction from the drawing side (rule `sided`). */
  sided?: boolean;
}

/** "RS-232 [REMOTE ]" → label "RS-232", qualifier "Remote"; "HDMI [F TYPE A]" → connector. */
function splitLabel(raw: string): { label: string; connector?: string; qualifier?: string } {
  const paren = /^(.*?)\s*\(([^)]*)\)?\s*$/.exec(raw);
  if (paren && paren[1] && !/\[/.test(raw)) return { label: paren[1].trim(), qualifier: paren[2].trim() };
  const m = /^(.*?)\s*\[([^\]]*)\]?\s*$/.exec(raw);
  if (!m || !m[1]) return { label: raw.trim() };
  const inner = m[2].trim();
  if (connectorOf(inner, "").connector) return { label: m[1].trim(), connector: `[${inner}]` };
  return { label: m[1].trim(), qualifier: inner };
}

function qualifierWord(q: string): string | undefined {
  const k = q.toUpperCase().replace(/\s+/g, " ").trim();
  if (!k) return undefined;
  if (k === "REMOTE") return "Remote";
  if (/^(DTP\d?|XTP|TP)$/.test(k)) return "Over TP";
  if (k === "LC") return undefined;
  return q.trim();
}

const SUFFIX_FROM_RAW: [RegExp, string][] = [
  [/\bREM(OTE|\.)/, "Remote"],
  [/\bDISPLAY\b/, "Display"],
  [/- PASS\b/, "Pass-Through"],
  [/\/ ?AUTO\b/, "Auto"],
  [/\bPRI\b/, "Primary"],
  [/\bSEC\b/, "Secondary"],
  [/\bPOE\+/, "PoE+"],
  [/\bPOE\b/, "PoE"],
  [/\bXTP\b(?!.*\bIR\b)/, ""],
  [/\b(DTP\d?|XTP)$/, "Over TP"],
  [/\bCEC\b/, ""],
];

/** Spelling variants of the stencils → one form: "RS232" → "RS-232", "LAN/ PoE" → "LAN/POE". */
export function canonLabel(label: string): string {
  return label
    .toUpperCase()
    .replace(/[\][]+$/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .replace(/\bRS2?-?232\b/g, "RS-232")
    .replace(/\bUSBC?[- ]C\b/g, "USB-C")
    .replace(/\bI\/0\b/g, "I/O")
    .replace(/\bTALY\b/g, "TALLY")
    .replace(/\bRGBHBV\b/g, "RGBHV")
    .trim();
}

function ruleFor(label: string): { rule: LabelRule; m: RegExpExecArray } | undefined {
  const k = canonLabel(label);
  for (const rule of LABEL_RULES) {
    const m = rule.re.exec(k);
    if (m) return { rule, m };
  }
  return undefined;
}

/** Number embedded in a label: "RELAY 2" → "2", "COM1" → "1", "AV LAN 3" → "3". */
function labelNumber(label: string): string | undefined {
  const m = /(?:^|[^\d.])(\d{1,2})$/.exec(label.trim());
  return m?.[1];
}

/** "RELAY 1& 2", "DIGITAL I/O 1-4" → base and the numbers it stands for. */
function expandRange(label: string): { base: string; numbers: string[] } | undefined {
  const m = /^(.*?)\s*(\d+)\s*(?:&|-|–)\s*(\d+)$/.exec(label.trim());
  if (!m) return undefined;
  const a = Number(m[2]);
  const b = Number(m[3]);
  if (!(b > a && b - a < 16)) return undefined;
  return { base: m[1].trim(), numbers: Array.from({ length: b - a + 1 }, (_, i) => String(a + i)) };
}

function stripLeadingZeros(n: string): string {
  return n.replace(/^0+(?=\d)/, "");
}

function draftOf(row: StencilRow, label: string, extraLabels: string[], issues: string[]): Draft | undefined {
  const split = splitLabel(label);
  const connectors = [...row.connectors];
  if (split.connector) connectors.unshift(split.connector);
  const words = [split.label, ...extraLabels].join(" ").replace(/\s+/g, " ").trim();
  const upper = words.toUpperCase();
  // "Fiber [LC]" + "IN": the second text is the direction; "FIBER IN" + "A": a link letter.
  let hit = ruleFor(words) ?? ruleFor(split.label) ?? ruleFor([split.label, ...extraLabels.filter((x) => !/^([AB]|BKG)$/i.test(x.trim()))].join(" "));
  if (!hit) {
    const num = labelNumber(split.label);
    if (num) hit = ruleFor(split.label.replace(/\s*\d+$/, ""));
  }
  if (!hit) {
    issues.push(`unknown label "${[label, ...extraLabels].join(" | ")}"`);
    return undefined;
  }
  const { rule, m } = hit;
  const name = typeof rule.name === "function" ? rule.name(m) : rule.name;
  let dir: Dir;
  if (rule.dir) dir = rule.dir;
  else if (DIR_WORDS_OUT.test(upper) && !DIR_WORDS_IN.test(upper)) dir = "output";
  else if (DIR_WORDS_IN.test(upper) && !DIR_WORDS_OUT.test(upper)) dir = "input";
  else dir = row.side === "left" ? "input" : "output";
  const notes: string[] = [];
  if (rule.notes) notes.push(rule.notes);
  let connector: string | undefined;
  for (const c of connectors) {
    const got = connectorOf(c, rule.signal);
    if (!got.connector) {
      issues.push(`unknown connector "${c}" (${words})`);
      continue;
    }
    if (connector && connector !== got.connector) {
      issues.push(`two connectors for "${words}": ${connector}, ${got.connector}`);
      continue;
    }
    connector = got.connector;
    if (got.notes && !notes.includes(got.notes)) notes.push(got.notes);
  }
  if (connectors.length > 1 && connector) notes.push(`${connectors.length} connectors drawn`);
  if (!connector) connector = IMPLIED_CONNECTOR[rule.signal];
  let suffix = rule.suffix;
  if (!suffix) {
    for (const [re, s] of SUFFIX_FROM_RAW) {
      if (re.test(upper)) {
        if (s) suffix = s;
        break;
      }
    }
  }
  const q = split.qualifier ? qualifierWord(split.qualifier) : undefined;
  if (q && !suffix) suffix = q;
  // Link letter of a fiber pair ("FIBER IN" + "A"), and "PRI"/"SEC" already handled.
  const letter = extraLabels.find((x) => /^[AB]$/.test(x.trim()));
  if (letter && rule.signal === "fiber") suffix = `Link ${letter.trim()}`;
  if (extraLabels.some((x) => /^BKG$/i.test(x.trim()))) suffix = "Background";
  const section = rule.section ?? SECTION_OF[rule.signal]?.(dir) ?? "";
  return {
    sided: !!rule.sided,
    side: row.side,
    name,
    signal: rule.signal,
    dir,
    suffix,
    section,
    connector,
    notes,
    number: labelNumber(split.label) ?? (letter && rule.signal !== "fiber" ? letter.trim() : undefined),
  };
}

function dirWord(d: Draft): string {
  if (d.signal === "power" && d.sided) return d.dir === "output" ? "Out" : "In";
  if (!SIDED.has(d.signal) && d.signal !== "hdmi") return "";
  if (d.signal === "ir") return d.dir === "input" ? "In" : "Out";
  return d.dir === "input" ? "In" : d.dir === "output" ? "Out" : "";
}

function portLabel(d: Draft, number: string | undefined): string {
  let base = d.name;
  const w = dirWord(d);
  // "Audio Return", "Audio (Fixed)": the direction goes before the bracket.
  if (w) {
    const br = /^(.*?)(\s*\(.*\))$/.exec(base);
    base = br ? `${br[1]} ${w}${br[2]}` : `${base} ${w}`;
  }
  if (number) {
    const br = /^(.*?)(\s*\(.*\))$/.exec(base);
    base = br ? `${br[1]} ${number}${br[2]}` : `${base} ${number}`;
  }
  if (d.suffix && !base.includes(`(${d.suffix})`) && d.suffix.toLowerCase() !== d.name.toLowerCase()) base = `${base} (${d.suffix})`;
  return base;
}

const isPin = (l: string) => PIN_RE.test(l.trim());
const isGround = (l: string) => GROUND_RE.test(l.trim());
const realLabels = (r: StencilRow) => r.labels.filter((l) => !isGround(l) && !isPin(l));

/**
 * Stereo pairs drawn as two rows: "AUDIO L" … "AUDIO R" (DA 6A), or pin rows "L" and "R" next
 * to the port label (amplifier outputs "L | SA OUT 8Ω/4Ω"). Merged into one row, rows without a
 * label between them (the connector, the number) included.
 */
function mergeStereo(list: StencilRow[]): StencilRow[] {
  const out: StencilRow[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const lName = r.labels.map((l) => /^(.*?)\s*\bL$/i.exec(l.trim())).find((x) => x)?.[1] ?? null;
    if (lName === null) {
      out.push(r);
      continue;
    }
    let j = i + 1;
    while (j < list.length && list[i].y - list[j].y <= 0.6 && !list[j].labels.some((l) => /\bR$/i.test(l.trim()))) {
      if (realLabels(list[j]).length) break;
      j++;
    }
    const rr = list[j];
    const rName = rr?.labels.map((l) => /^(.*?)\s*\bR$/i.exec(l.trim())).find((x) => x)?.[1] ?? null;
    if (!rr || rName === null || (lName && rName && lName.toUpperCase() !== rName.toUpperCase()) || r.y - rr.y > 0.6) {
      out.push(r);
      continue;
    }
    const span = list.slice(i, j + 1);
    const base = lName || rName;
    const others = span.flatMap((x) => x.labels.filter((l) => !/\b[LR]$/i.test(l.trim()) && !isGround(l)));
    out.push({
      side: r.side,
      y: r.y,
      labels: [...new Set([...(base ? [base] : []), ...others])],
      stereo: true,
      connectors: span.flatMap((x) => x.connectors),
      numbers: span.flatMap((x) => x.numbers).slice(0, 1),
    });
    i = j;
  }
  return out;
}

const ONLY = (r: StencilRow, re: RegExp) => !r.connectors.length && !r.numbers.length && r.labels.length > 0 && r.labels.every((l) => re.test(l.trim()));

/**
 * Rows that annotate a neighbour rather than being ports: "Selectable I/O" under a DTP3/XTP
 * port, "IN" / "OUT" around a "Fiber [LC]" (FOX3 boards), link letters "A" / "B"; channel
 * numbers above and below a shared connector ("1", AUDIO [5 POLE CS], "2" on an amplifier).
 */
function foldAnnotations(list: StencilRow[], other: StencilRow[]): StencilRow[] {
  let rows = list.map((r) => ({ ...r, labels: [...r.labels], connectors: [...r.connectors], numbers: [...r.numbers] }));
  const nearest = (r: StencilRow, pred: (x: StencilRow) => boolean, tol: number) =>
    rows.filter((x) => x !== r && pred(x) && Math.abs(x.y - r.y) <= tol).sort((a, b) => Math.abs(a.y - r.y) - Math.abs(b.y - r.y))[0];
  const drop = new Set<StencilRow>();
  // L and R pin rows around a port label: one stereo port (the connector may sit on the L row).
  for (const r of rows) {
    if (!(r.labels.length === 1 && /^[LR]$/i.test(r.labels[0].trim()))) continue;
    const t = nearest(r, (x) => realLabels(x).length > 0 && !drop.has(x), 0.15);
    if (!t) continue;
    if (!t.connectors.length) t.connectors.push(...r.connectors);
    t.stereo = true;
    drop.add(r);
  }
  // The R channel drawn as a second row with the same label and no connector (DA 6A).
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows.slice(0, i).reverse().find((x) => !drop.has(x));
    if (!prev || drop.has(r) || r.connectors.length || prev.y - r.y > 0.26) continue;
    const same = r.labels.length && r.labels.join("|").toUpperCase() === prev.labels.join("|").toUpperCase();
    const stereoCs = prev.connectors.some((c) => /^\[\s*[5-9]\s*(pole|p)/i.test(c));
    if (same && stereoCs) {
      prev.stereo = true;
      drop.add(r);
    }
  }
  for (const r of rows) {
    if (drop.has(r)) continue;
    if (ONLY(r, /^selectable i\/o$/i)) {
      const t = nearest(r, (x) => x.labels.some((l) => /^disabled$/i.test(l.trim())), 0.15);
      if (t) t.labels.push(...r.labels);
      drop.add(r);
    } else if (ONLY(r, /^selectable$/i) || ONLY(r, /^[AB]$/i)) {
      drop.add(r);
    } else if (ONLY(r, /^(in|out)$/i)) {
      const t = nearest(r, (x) => x.labels.some((l) => /fiber|fibre/i.test(l)), 0.15);
      if (t) {
        t.labels.push(...r.labels);
        drop.add(r);
      }
    } else if (!r.labels.length && !r.connectors.length && r.numbers.length === 1) {
      const t = nearest(r, (x) => x.labels.length > 0 && x.connectors.length > 0 && !drop.has(x), 0.16);
      if (t) {
        t.numbers.push(r.numbers[0]);
        drop.add(r);
      }
    }
  }
  rows = rows.filter((r) => !drop.has(r));
  // Functions of one connector: a tight cluster (rows closer than 0.16") where only one row has
  // the connector — "RS-232" / "CONTROL [5 POLE CS]" / "IR" on a FOX3 receiver. Every function
  // gets the connector; a generic name of the connector itself (CONTROL, REMOTE) is not a port.
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j + 1 < rows.length && rows[j].y - rows[j + 1].y < 0.16) j++;
    const cluster = rows.slice(i, j + 1);
    const withConn = cluster.filter((r) => r.connectors.length);
    if (cluster.length > 1 && withConn.length === 1 && cluster.every((r) => r.labels.length && !r.numbers.length && !r.stereo)) {
      const host = withConn[0];
      const names = cluster.map((r) => r.labels.join(" "));
      const generic = /^(control|remote)$/i.test(host.labels.join(" ").trim());
      for (const r of cluster) {
        if (r === host && generic) continue;
        r.connectors = [...host.connectors];
        r.shared = names;
      }
      if (generic) rows = rows.filter((r) => r !== host);
      i = rows.indexOf(cluster[cluster.length - 1]) + 1 || j + 1;
      continue;
    }
    i = j + 1;
  }
  // A configurable port is drawn on both sides: the right "DISABLED" repeats the left one.
  const leftDisabled = new Set(other.filter((r) => r.labels.some((l) => /^disabled$/i.test(l.trim()))).flatMap((r) => r.numbers));
  if (leftDisabled.size) rows = rows.filter((r) => !(r.side === "right" && r.labels.some((l) => /^disabled$/i.test(l.trim())) && r.numbers.every((n) => leftDisabled.has(n))));
  return rows;
}

/** "001", "002" → "1-2"; "1", "3" → "1/3". */
function numberSpan(numbers: string[]): string {
  const ns = [...new Set(numbers.map(stripLeadingZeros))];
  if (ns.length === 1) return ns[0];
  if (ns.every((n) => /^\d+$/.test(n))) {
    const v = ns.map(Number).sort((a, b) => a - b);
    if (v.every((x, i) => i === 0 || x === v[i - 1] + 1)) return `${v[0]}-${v[v.length - 1]}`;
    return v.join("/");
  }
  return ns.join("/");
}

/** Text that only repeats the model ("XTPII CrossPoint 1600 Frame" on an XTP II CrossPoint 1600). */
function repeatsModel(text: string, model: string): boolean {
  const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = k(text);
  const mm = k(model);
  return mm.length >= 4 && t.length >= 4 && (t.includes(mm) || (t.length >= 8 && mm.includes(t)) || (/\d/.test(t) && mm.endsWith(t)));
}

/**
 * Ports of a master in the AVAIL standard form.
 *
 * - Rows are grouped per side (neighbours 0.26" apart or less).
 * - A group of number-only rows is a frame's slot positions (XTP II CrossPoint, FOX3 Matrix):
 *   no ports, counted in `modularSlots`.
 * - A row without a label takes the label of the nearest labelled row of its group, above first.
 * - Ground-pin rows (GND, G) are dropped; stereo L/R rows are merged; other pin rows (C, T, +V…)
 *   are an issue.
 * - Repeated names are numbered: the drawn number; else the number of the numbered row just
 *   above (the AUDIO under HDMI 001 is audio of input 1); else 1, 2, 3 top to bottom.
 */
export function stencilPorts(m: VisioMaster): StencilBlock {
  const { rows: allRows } = stencilRows(m);
  const model = m.props.Model ?? "";
  const rows = allRows
    .map((r) => ({ ...r, labels: r.labels.filter((l) => !repeatsModel(l, model) && !repeatsModel(l, m.props["Equipment ID"] ?? "")) }))
    .filter((r) => r.labels.length || r.connectors.length || r.numbers.length);
  const issues: string[] = [];
  const drafts: (Draft & { companion?: Draft })[] = [];
  let modularSlots = 0;
  for (const side of ["left", "right"] as Side[]) {
    const list = mergeStereo(foldAnnotations(rows.filter((r) => r.side === side), rows.filter((r) => r.side === "left")));
    // Number-only rows away from any label: a frame's slot positions when there are several.
    const numberOnly = list.filter((r) => !r.labels.length && !r.connectors.length && !list.some((x) => x.labels.length && Math.abs(x.y - r.y) <= 0.3)).length;
    const groups: StencilRow[][] = [];
    for (const r of list) {
      const g = groups[groups.length - 1];
      if (g && g[g.length - 1].y - r.y <= 0.3) g.push(r);
      else groups.push([r]);
    }
    for (const group of groups) {
      if (group.every((r) => !r.labels.length && !r.connectors.length) && numberOnly >= 4) {
        if (side === "left") modularSlots += group.length;
        continue;
      }
      // The numbered port drawn on the row just above (a companion: AUDIO under HDMI 001).
      let prev: Draft | undefined;
      for (let i = 0; i < group.length; i++) {
        const row = group[i];
        const above = prev;
        prev = undefined;
        const stereo = !!row.stereo;
        const labels = row.labels.filter((l) => !isGround(l));
        const pins = labels.filter(isPin);
        const real = labels.filter((l) => !isPin(l));
        if (!labels.length && row.labels.length && !row.connectors.length && !row.numbers.length) continue; // ground only
        if (pins.length && !(real.length && pins.every((p) => /^[AB]$/i.test(p.trim())))) {
          issues.push(`pin-level drawing: "${row.labels.join(" | ")}"`);
          continue;
        }
        let label = real[0];
        let extra = real.slice(1);
        let inherited = false;
        if (!label) {
          const above = group.slice(0, i).reverse().find((r) => realLabels(r).length);
          const below = group.slice(i + 1).find((r) => realLabels(r).length);
          const src = above ?? below;
          if (!src) {
            issues.push(`row without a label: ${[...row.numbers, ...row.connectors].join(" ")}`.trim());
            continue;
          }
          const ls = realLabels(src);
          label = ls[0];
          extra = ls.slice(1);
          inherited = true;
        }
        const range = expandRange(splitLabel(label).label);
        if (range && !row.numbers.length) {
          for (const n of range.numbers) {
            const d = draftOf(row, range.base, extra, issues);
            if (d) drafts.push({ ...d, number: n, inherited });
          }
          continue;
        }
        const d = draftOf(row, label, extra, issues);
        if (!d) continue;
        if (stereo) d.notes.unshift("L/R");
        if (row.shared) d.notes.push(`one connector with ${row.shared.filter((x) => x !== row.labels.join(" ")).join(", ")}`);
        if (row.numbers.length > 1) d.notes.push(`channels ${numberSpan(row.numbers)}`);
        if (row.numbers.length) d.number = numberSpan(row.numbers);
        // USB-C drawn as a numbered input of a switcher or transmitter: a video input (DP Alt Mode).
        if (d.signal === "usb" && d.name === "USB-C" && row.side === "left" && row.numbers.length) {
          d.section = "Video Inputs";
          d.dir = "input";
          d.name = "USB-C In";
          d.notes.push("video input");
        }
        d.inherited = inherited;
        if (!d.number && above?.number && above.signal !== d.signal && !inherited) drafts.push({ ...d, companion: above });
        else drafts.push(d);
        prev = d;
      }
    }
  }
  // Repeated names are numbered. Signals without a side in the label (RS-232/IR, LAN) count
  // over both sides, so a left and a right "RS-232/IR" do not clash.
  const key = (d: Draft) => `${dirWord(d) ? d.side : "*"}|${portLabel(d, undefined)}|${d.signal}`;
  const counts = new Map<string, number>();
  for (const d of drafts) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
  const seq = new Map<string, number>();
  const ports: StencilPort[] = [];
  const used = new Set<string>();
  for (const d of drafts) {
    const k = key(d);
    const n = (seq.get(k) ?? 0) + 1;
    seq.set(k, n);
    const repeated = (counts.get(k) ?? 0) > 1;
    let number = repeated ? (d.number ?? String(n)) : d.number;
    let label = portLabel(d, number);
    // A companion names the port it belongs to: "Audio In 1" (in/out tells the side), else
    // "RS-232/IR (DTP In 7)".
    if (repeated && !d.number && d.companion) {
      const cw = dirWord(d.companion);
      label = dirWord(d) ? portLabel(d, d.companion.number) : `${portLabel(d, undefined)} (${cw ? `${cw} ` : ""}${d.companion.number})`;
    }
    if (used.has(label) && repeated) {
      number = String(n);
      label = portLabel(d, number);
    }
    if (used.has(label)) {
      issues.push(`duplicate port "${label}"`);
      label = `${label} (${n})`;
    }
    used.add(label);
    ports.push({
      id: "",
      label,
      signalType: d.signal,
      direction: d.dir,
      ...(d.connector ? { connectorType: d.connector } : {}),
      section: d.section,
      ...(d.notes.length ? { notes: d.notes.join("; ") } : {}),
    });
  }
  // Section order of the standard, drawing order inside a section.
  const order = (s: string) => {
    const i = (BLOCK_SECTIONS as readonly string[]).indexOf(s.replace(/\s*\(.*\)$/, ""));
    return i < 0 ? 99 : i;
  };
  const sorted = ports.map((p, i) => ({ p, i })).sort((a, b) => order(a.p.section) - order(b.p.section) || a.i - b.i).map((x) => x.p);
  const pn = partNumbersOf(m);
  const base = slugPart(pn[0] ?? m.name);
  sorted.forEach((p, i) => (p.id = `vx-${base}-${i + 1}`));
  if (!sorted.length) issues.push("no ports drawn");
  return {
    partNumbers: pn,
    model,
    make: m.props.Make ?? "",
    description: m.props.Description ?? "",
    webPage: m.props["Web Page"] ?? "",
    stencil: m.stencil,
    master: m.name,
    retired: /retired/i.test(m.stencil),
    ...(modularSlots ? { modularSlots } : {}),
    ports: sorted,
    issues: [...new Set(issues)],
  };
}

function slugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
