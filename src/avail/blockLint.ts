/**
 * AVAIL Device Block Standard linter (docs/avail/device-block-standard.md).
 *
 * The only implementation of the standard's formal rules. It started as a port of
 * tools/avail/avail_block_lint.py (v0.2, kept there as an archive) and still follows
 * its semantics: truthiness (empty arrays/objects and 0 are "missing"), Unicode-aware
 * \b and \s, `$` that also matches before a trailing newline, length in code points.
 * Since v0.3 it also checks category (errors) and manufacturer (warnings) against the
 * AVAIL reference data (src/avail/library.ts).
 *
 * Pure functions with no browser or Node dependencies, so the editor and the API can
 * both call them. Errors (E) block level B, warnings (W) block level A:
 *   FIX — at least one error; B — no errors, some warnings; A — clean.
 * Since v0.8 (standard 8.1) errors are only what breaks the schematic or the specification:
 * no ports (a chassis with slots is fine), no connectorType, no or unknown category, no
 * modelNumber / manufacturer / deviceType, power that is not an input. Presentation (sections,
 * labels, header, order…) and data gaps are warnings.
 */
import { findCategory, findVendor, GENERIC_VENDOR } from "./library";
import { onlyAbbreviations } from "./labels";
import { BLOCK_SECTIONS, suggestSection, wrongBidirectional } from "./sections";
import { slotLibraryWarnings, type SlotLibraryContext } from "./slotFamilies";


export type BlockLevel = "A" | "B" | "FIX";

export interface BlockLintResult {
  level: BlockLevel;
  errors: string[];
  warnings: string[];
}

export { BLOCK_SECTIONS };

/** Signal types that must be direction "bidirectional". */
const BIDIR = new Set(["ethernet", "dante", "avb", "serial", "rs422", "gpio", "ebus", "extron-exp", "thunderbolt"]);

// Python's str.isspace() set (what \s and str.strip() use), which differs from JS \s.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// Python: `$` matches at the very end or before one final "\n"; `.` is anything but "\n".
const SKU_RE = /^\p{Nd}{2}-\p{Nd}{3,4}-\p{Nd}{2}(?=\n?$)/u;
const SECTION_SUFFIX_RE = new RegExp(`[${WS}]*\\([^\\n]*\\)(?=\\n?$)`, "u");
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");
const WORD_SPLIT_RE = new RegExp(`[${WS}/()-]+`, "u");
const HAS_LATIN_WORD_RE = /[A-Za-z]{2,}/;
const POWER_PASSTHROUGH_RE = /loop|thru|out/iu;
/** Power outputs that are what the device is for: 12 V supplies, tally and lamp outputs (v1.8). */
const POWER_OUTPUT_LABEL_RE = /\b(12\s?v|24\s?v|48\s?v|tally|lamp)\b/i;
/** Device types whose job is to deliver power: a power output is right there (v1.8). */
const POWER_SOURCE_TYPES = new Set(["power-distribution", "power-supply", "24vdc-power-supply", "pdu", "ups", "antenna-distribution"]);
// Python's \b is Unicode-aware: a letter or digit of any script before "dtp" is not a boundary.
const HDBASET_RE = /(?<![\p{L}\p{N}_])(dtp|xtp|hdbaset)/u;
const GENERIC_PREFIX = `${GENERIC_VENDOR} `;
/** Notes of the port that powers a bus-powered device: "bus-powered (USB)" or "PoE". */
const USB_BUS_POWER_RE = /bus-powered \(USB\)/i;
/**
 * Notes of the port that powers a device without its own power port (standard 3.1): USB or
 * PoE, a bus (eBUS, ACP, DCP, VCH), phantom power, a battery, a passive device, or power from
 * the host device over its link cable (expansion mics, HDBaseT PoH receivers, adapters) (v1.8).
 */
const BUS_POWER_RE = /bus-powered \((?:USB|eBUS|ACP|DCP|VCH)\)|(?<!\bno )\bPoE\b|\bphantom\b|\bbattery\b|\bpassive\b|\bpowered by host\b/i;
/** Powered from elsewhere with no figure of its own to publish: bus, phantom, battery, passive, host. */
const NO_POWER_FIGURE_RE = /bus-powered \((?:eBUS|ACP|DCP|VCH)\)|\bphantom\b|\bbattery\b|\bpassive\b|\bpowered by host\b/i;
const GENERIC_MODEL_RE = /^GEN-[\p{Lu}\p{N}]+(?:-[\p{Lu}\p{N}]+)*$/u;

/**
 * Mounted in the room, never in a rack (standard 3, step 1.9): dimensions and weight are not required.
 * Categories match as a group ("Displays") or a full leaf path; device types match exactly.
 */
export const ROOM_MOUNTED_CATEGORIES = [
  "Audio Products / Speakers",
  "Microphones",
  "Connectivity / Architectural",
  "Control Systems / Touch panels",
  "Control Systems / Button Panel",
  "Videocameras",
  "Displays",
  "Projection",
  "Mounts",
  "UC / Video conference systems",
  "UC / Speakerphones",
] as const;
export const ROOM_MOUNTED_TYPES = new Set([
  "speaker", "subwoofer", "wired-mic", "wall-plate", "table-box", "touch-screen", "button-panel",
  "camera", "ptz-camera", "display", "monitor", "projector", "screen", "video-bar", "antenna",
]);
/** rackForm values that put a device in a rack or on a rack shelf. */
const RACK_FORMS = new Set(["full", "half", "shelf-only"]);

/**
 * True when the block is mounted in the room (ceiling, wall, table, screen) and cannot stand
 * in a rack: by category or device type. A block with a rack form (full, half, shelf-only)
 * stands in a rack whatever its category.
 */
export function isRoomMounted(block: RoomMountedInput): boolean {
  if (typeof block.rackForm === "string" && RACK_FORMS.has(block.rackForm)) return false;
  if (typeof block.deviceType === "string" && ROOM_MOUNTED_TYPES.has(block.deviceType)) return true;
  const c = typeof block.category === "string" ? block.category.trim() : "";
  if (ROOM_MOUNTED_CATEGORIES.some((m) => c === m || c.startsWith(`${m} /`))) return true;
  return mountedByName(block);
}

export interface RoomMountedInput {
  category?: unknown;
  deviceType?: unknown;
  rackForm?: unknown;
  label?: unknown;
  shortName?: unknown;
  manufacturer?: unknown;
  /** The catalog card's description (library/catalog _avail, or the database's catalog meta). */
  _avail?: { description?: unknown } | null;
}

/**
 * Mounting words in the name or the catalog description (standard 3.2, v0.9): a wallplate, a
 * decorator-style or in-wall / in-ceiling unit, an AAP / MAAP plate, a Cable Cubby, a table or
 * under-table box.
 */
export const ROOM_MOUNTED_WORDS_RE = /\b(wall ?plates?|decorator(?:-style)?|in-wall|in-ceiling|ceiling|m?aap|cable cubby|under-table|table)\b/i;
/** Extron's Decorator-Style models end in " D": "DTP3 T 322 D", "NBP 106 D (White)", "DTP3 R 201 D, White". */
const EXTRON_DECORATOR_RE = /\sD(?=$|[\s,(])/;

export function mountedByName(block: RoomMountedInput): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const name = `${str(block.label)} ${str(block.shortName)}`;
  if (ROOM_MOUNTED_WORDS_RE.test(name) || ROOM_MOUNTED_WORDS_RE.test(str(block._avail?.description))) return true;
  return /^extron$/i.test(str(block.manufacturer).trim()) && EXTRON_DECORATOR_RE.test(str(block.label).replace(/^Extron\s+/i, "").trim());
}

/** modelNumber of a Generic block: "Generic Room PC" → "GEN-ROOM-PC". */
export function genericModelNumber(label: string): string {
  const cls = label.startsWith(GENERIC_PREFIX) ? label.slice(GENERIC_PREFIX.length) : label;
  return "GEN-" + cls.trim().toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("-");
}

type Obj = Record<string, unknown>;

/** Python truthiness: None, False, 0, "", [] and {} are all falsy. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Length in code points, like Python's len(str). */
function pyLen(s: string): number {
  return [...s].length;
}

function sectionBase(s: string): string {
  return s.replace(SECTION_SUFFIX_RE, "").replace(STRIP_RE, "");
}

/**
 * Lints one device block: a library template (DeviceTemplate) or the data of a
 * device node on a schematic (DeviceData). Never throws on malformed input. With `library`
 * (slotLibraryContext of the whole library) it also warns about slots no card fits and
 * cards no chassis takes.
 */
export function lintBlock(block: object, library?: SlotLibraryContext): BlockLintResult {
  const d = asObj(block);
  const E: string[] = [];
  const W: string[] = [];
  const label = str(d.label);
  const model = d.model;
  const man = str(d.manufacturer);

  // --- card
  if (!man) E.push("no manufacturer");
  else if (!label.toLowerCase().startsWith(man.toLowerCase())) W.push(`label does not start with the manufacturer (${man})`);
  const vendor = findVendor(man);
  if (man && !vendor) W.push(`manufacturer "${man}" is not in avail-vendors.json (outside the portfolio use Generic)`);
  else if (vendor && vendor.name !== man) W.push(`manufacturer "${man}" is an alias, use "${vendor.name}"`);
  const generic = vendor?.name === GENERIC_VENDOR;
  if (generic) {
    const cls = label.startsWith(GENERIC_PREFIX) ? label.slice(GENERIC_PREFIX.length).trim() : "";
    if (!cls) W.push(`Generic: label must be "Generic <class>"`);
    const mn = d.modelNumber;
    if (truthy(mn)) {
      const want = cls ? genericModelNumber(label) : null;
      if (want ? mn !== want : !(typeof mn === "string" && GENERIC_MODEL_RE.test(mn))) {
        W.push(`Generic: modelNumber must be "${want ?? "GEN-<CLASS>"}"`);
      }
    }
  }
  if (truthy(model) && model !== label) W.push("model differs from label");
  if (!truthy(d.modelNumber)) E.push("no modelNumber");
  const sn = d.shortName;
  if (!truthy(sn)) W.push("no shortName");
  else if (typeof sn === "string" && SKU_RE.test(sn)) W.push(`shortName is a part number (${sn}), use the model`);
  if (!truthy(d.deviceType)) E.push("no deviceType");
  // A category outside the taxonomy breaks the specification (E); a BoQ-only category
  // (schematic=false) on a schematic block is a matter of grouping in the library (W, v0.8).
  const category = d.category;
  if (!truthy(category)) E.push("no category");
  else {
    const c = findCategory(typeof category === "string" ? category : undefined);
    if (!c || !c.leaf) E.push(`category "${String(category)}" is not a leaf category of avail-taxonomy.json`);
    else if (!c.schematic) W.push(`category "${c.path}" is not for schematic blocks (schematic=false)`);
  }
  const aux = truthy(d.auxiliaryData) ? asArray(d.auxiliaryData) : [];
  if (!(aux.length === 1 && asObj(aux[0]).text === "{{deviceType}}")) W.push("header is not {{deviceType}}");
  if (truthy(d.color)) W.push("color is set");

  // --- physical (not required for Generic blocks: there is no single product to measure)
  const poe = truthy(d.poeDrawW);
  const deviceType = d.deviceType;
  if (!generic) {
    // Dimensions and weight plan the rack: required for whatever can stand in a rack or on a
    // shelf. A card in a slot has none of its own (v1.8); a room-mounted device needs none (v1.9).
    const rackless = truthy(d.slotFamily) || isRoomMounted(d);
    for (const f of rackless ? [] : ["heightMm", "widthMm", "depthMm", "weightKg"]) {
      if (!truthy(d[f])) {
        W.push(`no ${f}`);
        break;
      }
    }
    // A card in a slot is powered by its chassis (standard "Slots and cards"). A chassis whose
    // only connections are slots and that has no power input is passive (v0.10, R1: CCD drawers).
    const slotsOnly = truthy(d.slots) && !truthy(d.ports);
    const passive = deviceType === "speaker" || deviceType === "antenna" || deviceType === "passive" || truthy(d.slotFamily) || slotsOnly;
    // A USB bus-powered device draws a published wattage at the bus voltage: powerDrawW is enough.
    const usbPowered = asArray(d.ports).some((p) => typeof asObj(p).notes === "string" && USB_BUS_POWER_RE.test(asObj(p).notes as string));
    const otherPowered = asArray(d.ports).some((p) => typeof asObj(p).notes === "string" && NO_POWER_FIGURE_RE.test(asObj(p).notes as string));
    const powerKnown = (truthy(d.powerDrawW) && (truthy(d.voltage) || usbPowered)) || otherPowered;
    if (!poe && !passive && !powerKnown) W.push("no powerDrawW/voltage (or poeDrawW)");
    if (!truthy(d.referenceUrl)) W.push("no referenceUrl");
  }
  if (!truthy(d.searchTerms)) W.push("no searchTerms");

  // --- ports (ports of card slots are checked with the card, not here)
  // A block with neither ports nor slots has nothing to connect on a schematic (step 1.9).
  // A chassis (Cable Cubby, frame) may have slots only: its ports come with the cards it takes,
  // so every slot must name its family (standard 5.1) to be level A.
  if (!truthy(d.ports) && !truthy(d.slots)) E.push("no ports");
  asArray(d.slots).forEach((s, i) => {
    const slot = asObj(s);
    if (!truthy(slot.slotFamily)) W.push(`slot "${str(slot.label) || i + 1}": no slotFamily`);
  });
  const ports = asArray(d.ports)
    .map(asObj)
    .filter((p) => !(typeof p.section === "string" && p.section.startsWith("Slot")));
  // Bus power (standard 3.1): a device powered over USB or PoE has no power port when the
  // notes of the port that powers it say so ("bus-powered (USB)" or "PoE").
  // A PoE source (poeBudgetW) needs its own power input whatever its port notes say.
  // PoE comes in on an input (a PoE source needs its own power); phantom power arrives on a mic's
  // output, a battery or a bus can be noted on any port.
  const busPowered =
    !truthy(d.poeBudgetW) &&
    ports.some((p) => typeof p.notes === "string" && (NO_POWER_FIGURE_RE.test(p.notes) || (p.direction !== "output" && BUS_POWER_RE.test(p.notes))));
  if (!ports.some((p) => p.signalType === "power") && !poe && !truthy(d.slots) && !busPowered && !truthy(d.slotFamily)) {
    // v0.8: a missing power port is a gap in the data, not a broken schematic (W).
    if (deviceType !== "speaker" && deviceType !== "antenna") W.push("no power port");
  }
  const order: number[] = [];
  for (const p of ports) {
    const l = str(p.label);
    const sig = p.signalType;
    const sec = str(p.section);
    const tag = `"${l}"`;
    if (!truthy(p.connectorType)) E.push(`${tag}: no connectorType`);
    const b = sectionBase(sec);
    const idx = (BLOCK_SECTIONS as readonly string[]).indexOf(b);
    if (!sec || idx < 0) {
      // Hint: the section the normalizer would give it, when it can tell.
      const hint = suggestSection(p);
      const use = hint ? `; use "${hint}"` : "";
      // v0.8: sections are presentation (W); any vocabulary section is fine for any signal.
      W.push(sec ? `${tag}: section "${sec}" is not in the vocabulary${use}` : `${tag}: no section${use}`);
    } else order.push(idx);
    const words = l.split(WORD_SPLIT_RE).filter((w) => HAS_LATIN_WORD_RE.test(w));
    // Abbreviations and numbers only ("IPCP LAN", "COM 1", "RS-232/IR") are how the panel reads.
    if (words.length >= 2 && l === l.toUpperCase() && !onlyAbbreviations(l)) W.push(`${tag}: label in all caps`);
    if (pyLen(l) > 28) W.push(`${tag}: label longer than 28 characters`);
    if (typeof sig === "string" && BIDIR.has(sig) && p.direction !== "bidirectional") {
      W.push(`${tag}: ${sig} must be bidirectional` + (sig === "dante" ? " (Dante channels are not ports)" : ""));
    }
    if (wrongBidirectional(p)) W.push(`${tag}: ${String(sig)} must be input or output, not bidirectional`);
    if (sig === "power" && p.direction !== "input" && !POWER_PASSTHROUGH_RE.test(l) && !POWER_OUTPUT_LABEL_RE.test(l) &&
        !POWER_SOURCE_TYPES.has(String(deviceType))) {
      E.push(`${tag}: power is not an input`);
    }
    if (sig === "rs422" && l.includes("232")) W.push(`${tag}: RS-232 marked as rs422`);
    const lower = l.toLowerCase();
    if (lower.includes("relay") && sig !== "contact-closure") W.push(`${tag}: a relay must be contact-closure`);
    if (lower.includes("ebus") && sig !== "ebus") W.push(`${tag}: eBUS must be ebus`);
    if (HDBASET_RE.test(lower) && sig !== "hdbaset" && sig !== "power") W.push(`${tag}: HDBaseT/DTP/XTP must be hdbaset`);
  }
  if (order.some((v, i) => i > 0 && v < order[i - 1])) W.push("sections are not in the standard order");
  // Slots and cards against the library (only when the caller knows the library).
  if (library) W.push(...slotLibraryWarnings(d, library));

  const level: BlockLevel = E.length ? "FIX" : W.length ? "B" : "A";
  return { level, errors: E, warnings: W };
}

/**
 * The device blocks of a JSON document, as the Python linter reads it: a device
 * archive ({ templates: [...] }) or a saved schematic (data of nodes of type "device").
 */
export function blocksOf(doc: unknown): object[] {
  const o = asObj(doc);
  if ("templates" in o) return asArray(o.templates).map(asObj);
  return asArray(o.nodes)
    .map(asObj)
    .filter((n) => n.type === "device")
    .map((n) => asObj(n.data));
}

export interface BlockReportRow extends BlockLintResult {
  label: string;
}

export function lintDocument(doc: unknown): BlockReportRow[] {
  return blocksOf(doc).map((d) => {
    const o = d as Obj;
    return { label: "label" in o ? String(o.label) : "?", ...lintBlock(d) };
  });
}

/** Left-justifies in code points, like Python's f"{s:<n}". */
function padEnd(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - pyLen(s)));
}

/** Text report: one line per block, messages with --verbose, totals (format of the v0.2 Python script). */
export function formatBlockReport(rows: BlockReportRow[], verbose = false): string {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`${padEnd(r.level, 4)} ${padEnd(r.label, 40)} E=${padEnd(String(r.errors.length), 3)} W=${r.warnings.length}`);
    if (verbose) {
      for (const m of r.errors) lines.push(`      E ${m}`);
      for (const m of r.warnings) lines.push(`      W ${m}`);
    }
  }
  const count = (lv: BlockLevel) => rows.filter((r) => r.level === lv).length;
  lines.push("", `Total: A ${count("A")} / B ${count("B")} / FIX ${count("FIX")}`);
  return lines.join("\n") + "\n";
}
