/**
 * AVAIL block auto-normalizer: brings a template closer to the Device Block Standard
 * (docs/avail/device-block-standard.md) where the fix is mechanical and unambiguous.
 *
 *   normalizeBlock(template) → { template, changes }
 *
 * Pure function, the input is not modified. Rule of the game: nothing is invented.
 * When a field cannot be fixed unambiguously it is left as it is and a change with
 * `manual: true` ("needs a manual fix") explains why.
 *
 * What it does:
 *   - manufacturer → canonical vendor name; category from deviceTypeDefaults when the
 *     current one is not a schematic leaf of the taxonomy;
 *   - header (auxiliaryData) → the single row {{deviceType}}; color is removed (the
 *     header color will come from the category);
 *   - label starts with the canonical manufacturer; shortName = model (label without the
 *     manufacturer) when empty or a part number;
 *   - port labels in all caps → standard form (words capitalized, abbreviations upper),
 *     only when every word is known;
 *   - LAN / Dante / AVB / serial / GPIO / buses → direction bidirectional;
 *   - port sections → the standard's vocabulary (by section name, or by signal type and
 *     direction for "Back/Front of unit", "Inputs", empty and other ad-hoc sections),
 *     front-panel ports get "(Front)"; ports ordered by the standard's section order.
 */
import { BLOCK_SECTIONS } from "./blockLint";
import { defaultCategoryFor, findCategory, findVendor, normalizeManufacturer } from "./library";

export interface NormalizeChange {
  /** Field path: "manufacturer", "label", "ports[<id>].section", "ports.order", … */
  field: string;
  from?: unknown;
  to?: unknown;
  /** What was done, or why it needs a human. */
  note: string;
  /** true — not changed: no unambiguous fix ("needs a manual fix"). */
  manual?: boolean;
}

export interface NormalizeResult<T> {
  template: T;
  changes: NormalizeChange[];
}

type Section = (typeof BLOCK_SECTIONS)[number];
type Obj = Record<string, unknown>;
type PortLike = Obj & { id?: unknown; label?: unknown; signalType?: unknown; direction?: unknown; section?: unknown };

// Python-style part number (the linter's rule): 60-1885-52.
const SKU_RE = /^\p{Nd}{2}-\p{Nd}{3,4}-\p{Nd}{2}(?=\n?$)/u;

/** Signal types the standard (4.3) wants bidirectional; same set as the linter's. */
export const BIDIRECTIONAL_SIGNALS = new Set(["ethernet", "dante", "avb", "serial", "rs422", "gpio", "ebus", "extron-exp", "thunderbolt"]);

const VIDEO_SIGNALS = new Set(["sdi", "hdmi", "displayport", "hdbaset", "composite", "s-video", "vga", "dvi", "component-video", "dxlink"]);
const AUDIO_SIGNALS = new Set(["analog-audio", "aes", "spdif", "madi", "adat"]);
const NETWORK_SIGNALS = new Set(["ethernet", "ndi", "st2110", "srt", "rtmp", "rtsp", "mpeg-ts"]);
const POWER_SIGNALS = new Set(["power", "power-l1", "power-l2", "power-l3", "power-neutral", "power-ground"]);

/** Section names seen in community templates (lower case) → the standard's section. */
const SECTION_ALIASES: Record<string, Section> = {
  "video in": "Video Inputs", "video input": "Video Inputs", "video inputs": "Video Inputs", "hdmi in": "Video Inputs", "hdmi inputs": "Video Inputs",
  "video out": "Video Outputs", "video output": "Video Outputs", "video outputs": "Video Outputs", "hdmi out": "Video Outputs", "hdmi outputs": "Video Outputs",
  "audio in": "Audio Inputs", "audio input": "Audio Inputs", "audio inputs": "Audio Inputs", "analog inputs": "Audio Inputs", "analog audio inputs": "Audio Inputs",
  "mic inputs": "Audio Inputs", "mic/line inputs": "Audio Inputs", "line inputs": "Audio Inputs", "mic/line in": "Audio Inputs",
  "audio out": "Audio Outputs", "audio output": "Audio Outputs", "audio outputs": "Audio Outputs", "analog outputs": "Audio Outputs",
  "analog audio outputs": "Audio Outputs", "line outputs": "Audio Outputs", "line out": "Audio Outputs",
  "speaker out": "Speaker Outputs", "speaker outputs": "Speaker Outputs", "amplifier outputs": "Speaker Outputs", "amp outputs": "Speaker Outputs",
  "rf": "RF", "antenna": "RF", "antennas": "RF",
  "network": "Network", "lan": "Network", "ethernet": "Network",
  "dante": "Dante", "dante network": "Dante", "dante/aes67": "Dante", "aes67": "Dante",
  "avb": "AVB", "avb/milan": "AVB", "milan": "AVB",
  "serial": "Serial", "serial control": "Serial", "rs-232": "Serial", "rs232": "Serial",
  "ir": "IR", "ir out": "IR", "ir outputs": "IR",
  "relays": "Relays", "relay": "Relays", "relay outputs": "Relays",
  "gpio": "Digital I/O", "digital i/o": "Digital I/O", "logic i/o": "Digital I/O",
  "control": "Control", "ctrl": "Control", "control i/o": "Control",
  "expansion": "Expansion",
  "usb": "USB",
  "configuration": "Configuration", "config": "Configuration",
  "power": "Power",
};

/** Sections that only say where the port is, or which way it points: placed by purpose. */
const LOCATION_SECTIONS = new Set(["", "back of unit", "rear", "back", "rear panel", "back panel", "connections", "ports"]);
const FRONT_SECTIONS = new Set(["front of unit", "front", "front panel"]);
const DIRECTION_SECTIONS: Record<string, "input" | "output"> = { inputs: "input", input: "input", in: "input", outputs: "output", output: "output", out: "output" };

/** Abbreviations kept in capitals (key: upper case → written form). */
const ABBREVIATIONS = new Map(
  [
    "HDMI", "USB", "LAN", "WAN", "DTP", "DTP2", "DTP3", "XTP", "IR", "DSP", "AEC", "SDI", "DP", "DVI", "VGA", "AV", "AVB", "SFP", "SFP+",
    "AES", "AES67", "XLR", "TRS", "RCA", "CEC", "EDID", "HDCP", "GPIO", "I/O", "DC", "AC", "PC", "TV", "RF", "HD", "ID", "IP", "LED",
    "OOB", "KVM", "DMX", "MIDI", "NDI", "MADI", "ADAT", "PTZ", "VC", "HDBT", "HDBASET", "RS-232", "RS-422", "RS-485", "RS232",
    "RS422", "RS485", "EXP", "ACP", "SPDIF", "S/PDIF", "OSD", "UHD", "4K", "8K", "BNC", "PSU", "PGM", "PVW", "AUX", "L", "R",
    "IPCP", "HID", "TX", "RX", "COM", "DMP", "VISCA", "RS", "RJ", "ARC", "TOSLINK", "GPU", "UTP", "SD", "CCU", "NHD", "IEC",
    "PAL", "NTSC", "TC", "PWR", "MGMT", "PA", "DHCP", "SNMP", "SIP", "VOIP", "POTS",
  ].map((a) => [a, a] as [string, string]).concat([["POE", "PoE"], ["POE+", "PoE+"], ["POE++", "PoE++"], ["EBUS", "eBUS"], ["EARC", "eARC"]]),
);
// "AUX", "PGM", "PVW" read as abbreviations on panels; everything else below is a plain word.
const WORDS = new Set(
  `in out input inputs output outputs line mic power audio video left right main program preview monitor loop thru through
   remote control network relay relays port ports host device service setup config reset ground phantom balanced unbalanced
   analog digital speaker speakers headphone headphones front rear primary secondary zone level record send return bus
   channel mix master sub subwoofer amp amplifier antenna display camera link data sync clock trigger alarm contact closure
   button tally expansion card slot mute volume mode status local external internal stereo mono console mouse keyboard touch
   panel sensor light fan port serial switch room table wall program aux dante lan optical coax coaxial fiber
   circuit key mirrored genlock patch ethernet automix screen matrix composite cascade hi low ceiling mains debug
   passthrough up down cable secure reference wireless wired receiver transmitter encoder decoder scaler`.split(/\s+/).filter(Boolean),
);

/** The standard's header (section 2): a single aux row with the device type. */
export const STANDARD_HEADER: readonly { text: string; position: "header" }[] = [{ text: "{{deviceType}}", position: "header" }];

/** Same condition as the linter: exactly one aux row, {{deviceType}}. */
export function hasStandardHeader(aux: unknown): boolean {
  return Array.isArray(aux) && aux.length === 1 && !!aux[0] && typeof aux[0] === "object" && (aux[0] as Obj).text === "{{deviceType}}";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function startsWithWord(label: string, prefix: string): boolean {
  if (!prefix || label.length < prefix.length) return false;
  if (label.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
  const next = label.charAt(prefix.length);
  return next === "" || /\s/.test(next);
}

/** Lint condition for an all-caps label: ≥2 Latin words and no lower case. */
export function isCapsLabel(label: string): boolean {
  const words = label.split(/[\s/()-]+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 2 && label === label.toUpperCase();
}

/**
 * "HDMI INPUT 1" → "HDMI Input 1". Returns null when some word is neither a known word
 * nor a known abbreviation: guessing its case would be inventing.
 */
export function standardCaseLabel(label: string): string | null {
  let unknown = false;
  const word = (w: string): string => {
    if (w === "" || w === "/" || w === "-") return w;
    const abbr = ABBREVIATIONS.get(w.toUpperCase());
    if (abbr) return abbr;
    if (/\d/.test(w) || !/[A-Za-z]/.test(w) || w.length === 1) return w; // 12V, DTP3, 3G, L, R — as written
    if (WORDS.has(w.toLowerCase())) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    unknown = true;
    return w;
  };
  const out = label.replace(/[A-Za-z0-9+][A-Za-z0-9+/-]*/g, (token) => {
    const abbr = ABBREVIATIONS.get(token.toUpperCase());
    if (abbr) return abbr; // RS-232, I/O, S/PDIF as a whole
    // Compound tokens ("IN/OUT", "MIC-LINE"): every part must be known.
    return token.split(/([/-])/).map(word).join("");
  });
  return unknown ? null : out;
}

/** Standard section for a port by what it carries; null when that is not unambiguous. */
export function sectionByPurpose(port: PortLike, directionHint?: "input" | "output"): Section | null {
  const sig = str(port.signalType);
  const dir = directionHint ?? (port.direction === "input" || port.direction === "output" ? port.direction : null);
  const label = str(port.label).toLowerCase();
  if (VIDEO_SIGNALS.has(sig)) return dir === "input" ? "Video Inputs" : dir === "output" ? "Video Outputs" : null;
  if (AUDIO_SIGNALS.has(sig)) return dir === "input" ? "Audio Inputs" : dir === "output" ? "Audio Outputs" : null;
  if (sig === "speaker-level") return dir === "output" ? "Speaker Outputs" : null;
  if (sig === "rf") return "RF";
  if (sig === "dante" || sig === "aes67") return "Dante";
  if (sig === "avb") return "AVB";
  if (NETWORK_SIGNALS.has(sig)) return "Network";
  if (sig === "serial" || sig === "rs422" || sig === "rs485") return "Serial";
  if (sig === "ir") return "IR";
  if (sig === "contact-closure") return dir === "output" ? "Relays" : dir === "input" ? "Control" : null;
  if (sig === "gpio") return "Digital I/O";
  if (sig === "tally" || sig === "control-voltage") return "Control";
  if (sig === "ebus" || sig === "extron-exp" || sig === "cresnet") return "Expansion";
  if (sig === "usb") {
    if (/\b(dp|alt|video|display)\b/.test(label)) return null; // USB-C with video: Video Inputs or USB — datasheet
    if (/\b(config|service|setup|console)\b/.test(label)) return "Configuration";
    return "USB";
  }
  if (POWER_SIGNALS.has(sig)) return "Power";
  return null;
}

function sectionBase(section: string): string {
  return section.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function sectionSuffix(section: string): string {
  const m = /\(([^)]*)\)\s*$/.exec(section);
  return m ? ` (${m[1].trim()})` : "";
}

/** The section a port should have, or a reason why it cannot be decided. */
function targetSection(port: PortLike): { section: string; front: boolean } | { manual: string } | null {
  const raw = str(port.section).trim();
  if (raw.startsWith("Slot")) return null; // card slot ports belong to the card
  const base = sectionBase(raw);
  if ((BLOCK_SECTIONS as readonly string[]).includes(base)) return null; // already standard
  const key = base.toLowerCase();
  const suffix = sectionSuffix(raw);

  const alias = SECTION_ALIASES[key];
  if (alias) return { section: alias + suffix, front: false };

  const front = FRONT_SECTIONS.has(key);
  const directionHint = DIRECTION_SECTIONS[key];
  const bySignal = sectionByPurpose(port, directionHint);
  if (bySignal) return { section: bySignal + (LOCATION_SECTIONS.has(key) || front || directionHint ? "" : suffix), front };
  return { manual: `section "${raw}": signal type "${str(port.signalType)}" and direction do not determine the section` };
}

/**
 * Normalizes one block. Works on library templates (DeviceTemplate) and on the data of
 * device nodes; unknown fields are carried over untouched.
 */
export function normalizeBlock<T extends object>(input: T): NormalizeResult<T> {
  const t = structuredClone(input) as unknown as Obj;
  const changes: NormalizeChange[] = [];

  // --- manufacturer
  const manRaw = str(t.manufacturer);
  const man = normalizeManufacturer(manRaw);
  if (man && man !== manRaw) {
    changes.push({ field: "manufacturer", from: manRaw, to: man, note: "canonical name from avail-vendors.json" });
    t.manufacturer = man;
  }
  if (!man) changes.push({ field: "manufacturer", note: "no manufacturer: label and shortName are not normalized", manual: true });

  // --- category
  const cat = findCategory(str(t.category));
  if (!cat || !cat.leaf || !cat.schematic) {
    const def = defaultCategoryFor(str(t.deviceType));
    const defCat = findCategory(def);
    if (def && defCat?.leaf && defCat.schematic) {
      changes.push({ field: "category", from: t.category ?? null, to: def, note: `deviceTypeDefaults for "${str(t.deviceType)}"` });
      t.category = def;
    } else {
      changes.push({ field: "category", from: t.category ?? null, note: `no default category for type "${str(t.deviceType)}": pick one from the taxonomy`, manual: true });
    }
  }

  // --- header: one row, {{deviceType}}; no color (the standard, section 2)
  if (!hasStandardHeader(t.auxiliaryData)) {
    changes.push({ field: "auxiliaryData", from: t.auxiliaryData ?? null, to: [...STANDARD_HEADER], note: "header = {{deviceType}}" });
    t.auxiliaryData = STANDARD_HEADER.map((r) => ({ ...r }));
  }
  if ("color" in t) {
    if (t.color !== undefined && t.color !== null && t.color !== "") {
      changes.push({ field: "color", from: t.color, note: "color removed: the header color will come from the category" });
    }
    delete t.color;
  }

  // --- label: canonical manufacturer at the start
  const label = str(t.label);
  if (man && label) {
    // Longest name first: "Biamp Systems X" is the alias "Biamp Systems", not "Biamp" + "Systems X".
    const vendor = findVendor(man);
    const prefixes = [man, ...(vendor ? [vendor.name, ...vendor.aliases] : []), manRaw].filter(Boolean).sort((a, b) => b.length - a.length);
    const hit = prefixes.find((p) => startsWithWord(label, p));
    const next = hit ? `${man}${label.slice(hit.length)}` : `${man} ${label}`;
    if (next !== label) {
      changes.push({ field: "label", from: label, to: next, note: "label = manufacturer + model" });
      t.label = next;
    }
  }

  // --- shortName: the model, when empty or a part number
  const sn = str(t.shortName);
  if (!sn || SKU_RE.test(sn)) {
    const l = str(t.label);
    const model = man && startsWithWord(l, man) ? l.slice(man.length).trim() : "";
    if (model) {
      changes.push({ field: "shortName", from: sn || null, to: model, note: sn ? "was a part number: model taken from label" : "model taken from label" });
      t.shortName = model;
    } else {
      changes.push({ field: "shortName", from: sn || null, note: "cannot tell the model from the label", manual: true });
    }
  }

  // --- ports
  if (Array.isArray(t.ports)) {
    const ports = (t.ports as unknown[]).map((p) => (p && typeof p === "object" ? (p as PortLike) : p));
    for (const p of ports) {
      if (!p || typeof p !== "object") continue;
      const port = p as PortLike;
      const id = str(port.id) || str(port.label);
      const where = `ports[${id}]`;

      // label case
      const pl = str(port.label);
      if (isCapsLabel(pl)) {
        const fixed = standardCaseLabel(pl);
        if (!fixed) {
          changes.push({ field: `${where}.label`, from: pl, note: "all-caps label with unknown words: fix it from the panel silkscreen", manual: true });
        } else if (isCapsLabel(fixed)) {
          changes.push({ field: `${where}.label`, from: pl, note: "label made of abbreviations only: check it against the panel silkscreen", manual: true });
        } else {
          changes.push({ field: `${where}.label`, from: pl, to: fixed, note: "all-caps label → standard case" });
          port.label = fixed;
        }
      }

      // direction
      const sig = str(port.signalType);
      if (BIDIRECTIONAL_SIGNALS.has(sig) && port.direction !== "bidirectional" && port.direction !== "passthrough") {
        changes.push({ field: `${where}.direction`, from: port.direction, to: "bidirectional", note: `${sig} is bidirectional by the standard (4.3)` });
        port.direction = "bidirectional";
      }

      // section
      const target = targetSection(port);
      if (target && "manual" in target) {
        changes.push({ field: `${where}.section`, from: port.section ?? null, note: target.manual, manual: true });
      } else if (target) {
        changes.push({ field: `${where}.section`, from: port.section ?? null, to: target.section, note: "section from the standard's vocabulary" });
        port.section = target.section;
        const cur = str(port.label);
        if (target.front && !/front/i.test(cur)) {
          changes.push({ field: `${where}.label`, from: cur, to: `${cur} (Front)`, note: "front panel port: \"(Front)\" added to the label" });
          port.label = `${cur} (Front)`;
        }
      }
    }

    // order: standard sections in the standard's order; slot and unresolved ports keep their place after them
    const rank = (p: unknown): number => {
      const sec = p && typeof p === "object" ? str((p as PortLike).section) : "";
      const i = (BLOCK_SECTIONS as readonly string[]).indexOf(sectionBase(sec));
      return i < 0 ? BLOCK_SECTIONS.length : i;
    };
    const sorted = ports.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
    if (sorted.some((p, i) => p !== ports[i])) {
      changes.push({ field: "ports.order", note: "ports ordered by the standard's sections (4.1)" });
    }
    t.ports = sorted;
  }

  return { template: t as unknown as T, changes };
}

/** Changes that were applied (not the "manual" notes). */
export function appliedChanges(changes: NormalizeChange[]): NormalizeChange[] {
  return changes.filter((c) => !c.manual);
}
