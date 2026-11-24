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
 */
import { findCategory, findVendor, GENERIC_VENDOR } from "./library";


export type BlockLevel = "A" | "B" | "FIX";

export interface BlockLintResult {
  level: BlockLevel;
  errors: string[];
  warnings: string[];
}

/** Port sections in the order the standard requires; "(…)" suffixes are allowed, e.g. "Video Inputs (Front)". */
export const BLOCK_SECTIONS = [
  "Video Inputs", "Video Outputs", "Audio Inputs", "Audio Outputs", "Speaker Outputs", "RF",
  "Network", "Dante", "AVB", "Serial", "IR", "Relays", "Digital I/O", "Control",
  "Expansion", "USB", "Configuration", "Power",
] as const;

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
// Python's \b is Unicode-aware: a letter or digit of any script before "dtp" is not a boundary.
const HDBASET_RE = /(?<![\p{L}\p{N}_])(dtp|xtp|hdbaset)/u;
const GENERIC_PREFIX = `${GENERIC_VENDOR} `;
/** Notes of the port that powers a bus-powered device: "bus-powered (USB)" or "PoE". */
const USB_BUS_POWER_RE = /bus-powered \(USB\)/i;
const BUS_POWER_RE = /bus-powered \(USB\)|(?<!\bno )\bPoE\b/i;
const GENERIC_MODEL_RE = /^GEN-[\p{Lu}\p{N}]+(?:-[\p{Lu}\p{N}]+)*$/u;

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
 * device node on a schematic (DeviceData). Never throws on malformed input.
 */
export function lintBlock(block: object): BlockLintResult {
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
  // Every library template is a schematic block, so a schematic=false category is an error too.
  const category = d.category;
  if (!truthy(category)) E.push("no category");
  else {
    const c = findCategory(typeof category === "string" ? category : undefined);
    if (!c || !c.leaf) E.push(`category "${String(category)}" is not a leaf category of avail-taxonomy.json`);
    else if (!c.schematic) E.push(`category "${c.path}" is not for schematic blocks (schematic=false)`);
  }
  const aux = truthy(d.auxiliaryData) ? asArray(d.auxiliaryData) : [];
  if (!(aux.length === 1 && asObj(aux[0]).text === "{{deviceType}}")) W.push("header is not {{deviceType}}");
  if (truthy(d.color)) W.push("color is set");

  // --- physical (not required for Generic blocks: there is no single product to measure)
  const poe = truthy(d.poeDrawW);
  const deviceType = d.deviceType;
  if (!generic) {
    for (const f of ["heightMm", "widthMm", "depthMm", "weightKg"]) {
      if (!truthy(d[f])) {
        W.push(`no ${f}`);
        break;
      }
    }
    const passive = deviceType === "speaker" || deviceType === "antenna" || deviceType === "passive";
    // A USB bus-powered device draws a published wattage at the bus voltage: powerDrawW is enough.
    const usbPowered = asArray(d.ports).some((p) => typeof asObj(p).notes === "string" && USB_BUS_POWER_RE.test(asObj(p).notes as string));
    const powerKnown = truthy(d.powerDrawW) && (truthy(d.voltage) || usbPowered);
    if (!poe && !passive && !powerKnown) W.push("no powerDrawW/voltage (or poeDrawW)");
    if (!truthy(d.referenceUrl)) W.push("no referenceUrl");
  }
  if (!truthy(d.searchTerms)) W.push("no searchTerms");

  // --- ports (ports of card slots are checked with the card, not here)
  const ports = asArray(d.ports)
    .map(asObj)
    .filter((p) => !(typeof p.section === "string" && p.section.startsWith("Slot")));
  // Bus power (standard 3.1): a device powered over USB or PoE has no power port when the
  // notes of the port that powers it say so ("bus-powered (USB)" or "PoE").
  // A PoE source (poeBudgetW) needs its own power input whatever its port notes say.
  const busPowered = !truthy(d.poeBudgetW) && ports.some((p) => p.direction !== "output" && typeof p.notes === "string" && BUS_POWER_RE.test(p.notes));
  if (!ports.some((p) => p.signalType === "power") && !poe && !truthy(d.slots) && !busPowered) {
    if (deviceType !== "speaker" && deviceType !== "antenna") E.push("no power port");
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
    if (!sec) E.push(`${tag}: no section`);
    else if (idx < 0) E.push(`${tag}: section "${sec}" is not in the vocabulary`);
    else order.push(idx);
    const words = l.split(WORD_SPLIT_RE).filter((w) => HAS_LATIN_WORD_RE.test(w));
    if (words.length >= 2 && l === l.toUpperCase()) W.push(`${tag}: label in all caps`);
    if (pyLen(l) > 28) W.push(`${tag}: label longer than 28 characters`);
    if (typeof sig === "string" && BIDIR.has(sig) && p.direction !== "bidirectional") {
      W.push(`${tag}: ${sig} must be bidirectional` + (sig === "dante" ? " (Dante channels are not ports)" : ""));
    }
    if (sig === "power" && p.direction !== "input" && !POWER_PASSTHROUGH_RE.test(l)) E.push(`${tag}: power is not an input`);
    if (sig === "rs422" && l.includes("232")) E.push(`${tag}: RS-232 marked as rs422`);
    const lower = l.toLowerCase();
    if (lower.includes("relay") && sig !== "contact-closure") W.push(`${tag}: a relay must be contact-closure`);
    if (lower.includes("ebus") && sig !== "ebus") W.push(`${tag}: eBUS must be ebus`);
    if (HDBASET_RE.test(lower) && sig !== "hdbaset" && sig !== "power") W.push(`${tag}: HDBaseT/DTP/XTP must be hdbaset`);
  }
  if (order.some((v, i) => i > 0 && v < order[i - 1])) W.push("sections are not in the standard order");

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
