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
  if (!man) E.push("нет manufacturer");
  else if (!label.toLowerCase().startsWith(man.toLowerCase())) W.push(`label не начинается с производителя (${man})`);
  const vendor = findVendor(man);
  if (man && !vendor) W.push(`manufacturer «${man}» не из avail-vendors.json (вне портфеля — Generic)`);
  else if (vendor && vendor.name !== man) W.push(`manufacturer «${man}» — синоним, нужно «${vendor.name}»`);
  const generic = vendor?.name === GENERIC_VENDOR;
  if (generic) {
    const cls = label.startsWith(GENERIC_PREFIX) ? label.slice(GENERIC_PREFIX.length).trim() : "";
    if (!cls) W.push(`Generic: label должен быть «Generic <класс>»`);
    const mn = d.modelNumber;
    if (truthy(mn)) {
      const want = cls ? genericModelNumber(label) : null;
      if (want ? mn !== want : !(typeof mn === "string" && GENERIC_MODEL_RE.test(mn))) {
        W.push(`Generic: modelNumber должен быть «${want ?? "GEN-<КЛАСС>"}»`);
      }
    }
  }
  if (truthy(model) && model !== label) W.push("model отличается от label");
  if (!truthy(d.modelNumber)) E.push("нет modelNumber");
  const sn = d.shortName;
  if (!truthy(sn)) W.push("нет shortName");
  else if (typeof sn === "string" && SKU_RE.test(sn)) W.push(`shortName = артикул (${sn}), нужна модель`);
  if (!truthy(d.deviceType)) E.push("нет deviceType");
  // Every library template is a schematic block, so a schematic=false category is an error too.
  const category = d.category;
  if (!truthy(category)) E.push("нет category");
  else {
    const c = findCategory(typeof category === "string" ? category : undefined);
    if (!c || !c.leaf) E.push(`category «${String(category)}» — не листовая категория avail-taxonomy.json`);
    else if (!c.schematic) E.push(`category «${c.path}» не для блоков на схеме (schematic=false)`);
  }
  const aux = truthy(d.auxiliaryData) ? asArray(d.auxiliaryData) : [];
  if (!(aux.length === 1 && asObj(aux[0]).text === "{{deviceType}}")) W.push("шапка не {{deviceType}}");
  if (truthy(d.color)) W.push("задан color");

  // --- physical (not required for Generic blocks: there is no single product to measure)
  const poe = truthy(d.poeDrawW);
  const deviceType = d.deviceType;
  if (!generic) {
    for (const f of ["heightMm", "widthMm", "depthMm", "weightKg"]) {
      if (!truthy(d[f])) {
        W.push(`нет ${f}`);
        break;
      }
    }
    const passive = deviceType === "speaker" || deviceType === "antenna" || deviceType === "passive";
    if (!poe && !passive && !(truthy(d.powerDrawW) && truthy(d.voltage))) W.push("нет powerDrawW/voltage (или poeDrawW)");
    if (!truthy(d.referenceUrl)) W.push("нет referenceUrl");
  }
  if (!truthy(d.searchTerms)) W.push("нет searchTerms");

  // --- ports (ports of card slots are checked with the card, not here)
  const ports = asArray(d.ports)
    .map(asObj)
    .filter((p) => !(typeof p.section === "string" && p.section.startsWith("Slot")));
  if (!ports.some((p) => p.signalType === "power") && !poe && !truthy(d.slots)) {
    if (deviceType !== "speaker" && deviceType !== "antenna") E.push("нет порта питания");
  }
  const order: number[] = [];
  for (const p of ports) {
    const l = str(p.label);
    const sig = p.signalType;
    const sec = str(p.section);
    const tag = `«${l}»`;
    if (!truthy(p.connectorType)) E.push(`${tag}: нет connectorType`);
    const b = sectionBase(sec);
    const idx = (BLOCK_SECTIONS as readonly string[]).indexOf(b);
    if (!sec) E.push(`${tag}: нет секции`);
    else if (idx < 0) E.push(`${tag}: секция «${sec}» вне словаря`);
    else order.push(idx);
    const words = l.split(WORD_SPLIT_RE).filter((w) => HAS_LATIN_WORD_RE.test(w));
    if (words.length >= 2 && l === l.toUpperCase()) W.push(`${tag}: подпись капсом`);
    if (pyLen(l) > 28) W.push(`${tag}: подпись длиннее 28 символов`);
    if (typeof sig === "string" && BIDIR.has(sig) && p.direction !== "bidirectional") {
      W.push(`${tag}: ${sig} должен быть bidirectional` + (sig === "dante" ? " (каналы Dante — не порты)" : ""));
    }
    if (sig === "power" && p.direction !== "input" && !POWER_PASSTHROUGH_RE.test(l)) E.push(`${tag}: питание не input`);
    if (sig === "rs422" && l.includes("232")) E.push(`${tag}: RS-232 размечен как rs422`);
    const lower = l.toLowerCase();
    if (lower.includes("relay") && sig !== "contact-closure") W.push(`${tag}: реле должно быть contact-closure`);
    if (lower.includes("ebus") && sig !== "ebus") W.push(`${tag}: eBUS должен быть ebus`);
    if (HDBASET_RE.test(lower) && sig !== "hdbaset" && sig !== "power") W.push(`${tag}: HDBaseT/DTP/XTP должен быть hdbaset`);
  }
  if (order.some((v, i) => i > 0 && v < order[i - 1])) W.push("порядок секций не по стандарту");

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
  lines.push("", `Итого: {'A': ${count("A")}, 'B': ${count("B")}, 'FIX': ${count("FIX")}}`);
  return lines.join("\n") + "\n";
}
