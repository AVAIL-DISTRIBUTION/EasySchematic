/**
 * Port sections of the AVAIL Device Block Standard (4.1) and how a port's section and
 * direction follow from what it carries. Shared by the linter (blockLint.ts, which uses
 * suggestSection() as a hint in its messages) and the normalizer (normalize.ts).
 * Pure functions, no browser or Node dependencies.
 */

/** Port sections in the order the standard requires; "(…)" suffixes are allowed, e.g. "Video Inputs (Front)". */
export const BLOCK_SECTIONS = [
  "Video Inputs", "Video Outputs", "Audio Inputs", "Audio Outputs", "Audio I/O", "Speaker Outputs", "RF",
  "Network", "Telephony", "Dante", "AVB", "Serial", "IR", "Relays", "Digital I/O", "Control", "Sync",
  "Expansion", "USB", "Configuration", "Power",
] as const;

export type Section = (typeof BLOCK_SECTIONS)[number];
type Obj = Record<string, unknown>;
export type PortLike = Obj & { id?: unknown; label?: unknown; signalType?: unknown; direction?: unknown; section?: unknown };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Signal types the standard (4.3) wants bidirectional. */
export const BIDIRECTIONAL_SIGNALS = new Set(["ethernet", "dante", "avb", "serial", "rs422", "gpio", "ebus", "extron-exp", "thunderbolt"]);

const VIDEO_SIGNALS = new Set(["sdi", "hdmi", "displayport", "hdbaset", "composite", "s-video", "vga", "dvi", "component-video"]);
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

/** Reference and time signals: the Sync section. */
const SYNC_SIGNALS = new Set(["genlock", "wordclock", "timecode"]);

/**
 * Connector that follows from the signal type without doubt (v3). Signals with several
 * usual connectors (analog audio, USB, GPIO, power, IR, RF, AES, serial…) are not here.
 */
export const SIGNAL_CONNECTORS: Readonly<Record<string, string>> = {
  hdmi: "hdmi",
  sdi: "bnc",
  ethernet: "rj45",
  dante: "rj45",
  avb: "rj45",
  hdbaset: "rj45",
  slink: "rj45",
  displayport: "displayport",
  dvi: "dvi",
  vga: "vga",
  genlock: "bnc",
  wordclock: "bnc",
};

/** Proprietary audio / console buses: Expansion (4.1). dxlink is Allen & Heath DX ("DX Link"), not AMX DXLink. */
const BUS_SIGNALS = new Set(["gigaace", "slink", "dx5", "dsnake", "dcp", "ydif", "dxlink", "fibreace"]);

/**
 * Signals whose direction is physical (4.3): video, analog audio, speaker level, IR. On
 * these "bidirectional" is a data error. A two-wire partyline intercom is not one of them.
 */
export const PHYSICAL_DIRECTION_SIGNALS = new Set([
  "hdmi", "displayport", "sdi", "dvi", "vga", "hdbaset", "composite", "component-video", "s-video",
  "analog-audio", "speaker-level", "ir",
]);

const OUT_WORDS = /\b(out|output|outputs|loop|thru|through|monitor|tx|send)\b/i;
const IN_WORDS = /\b(in|input|inputs|mic|rx|receive)\b/i;
const ARC_RE = /\be?arc\b/i;
const PARTYLINE_RE = /\b(partyline|party line|intercom)\b/i;
/** Ports that really carry both ways on one connector: a TRRS headset jack, a pass-through tunnel, "In/Out". */
const TWO_WAY_RE = /\b(trrs|headset|pass[- ]?thru|pass[- ]?through|in\/out|i\/o)\b/i;

/** The note a configurable HDBaseT input/output carries. */
export const CONFIGURABLE_NOTE = "configurable input/output";
const CONFIGURABLE_RE = /\bconfigurable\b/i;

/**
 * true when the standard wants this port input or output but it is marked bidirectional
 * (4.3). Partyline intercom, ports that carry both ways on one connector, and HDBaseT ports
 * configurable as input or output (v3: allowed, noted) are exempt.
 */
export function wrongBidirectional(port: PortLike): boolean {
  if (!PHYSICAL_DIRECTION_SIGNALS.has(str(port.signalType)) || port.direction !== "bidirectional") return false;
  if (str(port.signalType) === "hdbaset") return false;
  // An analog audio port configurable as input or output (v1.8), noted so.
  if (str(port.signalType) === "analog-audio" && CONFIGURABLE_RE.test(str((port as Obj).notes))) return false;
  const text = `${str(port.label)} ${str((port as Obj).notes)}`;
  return !PARTYLINE_RE.test(text) && !TWO_WAY_RE.test(text);
}

export type DirectionInference =
  | { direction: "input" | "output"; arc?: boolean }
  | { configurable: true }
  | { manual: string }
  | null;

/**
 * Direction of a port on a physical-direction signal that is marked bidirectional,
 * from its label: In / Input / Mic / Rx → input; Out / Output / Loop / Thru / Monitor /
 * Tx → output. HDMI with (e)ARC stays an input (audio return goes in notes). A label
 * that says both or neither is left for a person. null — the rule does not apply
 * (not such a signal, not bidirectional, partyline, or a real two-way port).
 */
export function directionFromLabel(port: PortLike): DirectionInference {
  const sig = str(port.signalType);
  const label = str(port.label);
  if (sig === "hdbaset" && port.direction === "bidirectional") {
    // An HDBaseT port that says In or Out is that; one that says neither is configurable (v3).
    const o = OUT_WORDS.test(label);
    const i = IN_WORDS.test(label);
    if (o !== i) return { direction: o ? "output" : "input" };
    return { configurable: true };
  }
  if (!wrongBidirectional(port)) return null;
  if (sig === "hdmi" && ARC_RE.test(label)) return { direction: "input", arc: true };
  const out = OUT_WORDS.test(label);
  const inn = IN_WORDS.test(label);
  if (out && !inn) return { direction: "output" };
  if (inn && !out) return { direction: "input" };
  return { manual: `${sig} cannot be bidirectional and the label "${label}" does not say In or Out: check against the panel` };
}

/**
 * The section the normalizer would give this port, or null when it cannot tell. Used by
 * the linter as a hint ("use Video Inputs"). Considers the direction a label implies.
 */
export function suggestSection(port: PortLike): string | null {
  const dir = directionFromLabel(port);
  const p = dir && "direction" in dir ? { ...port, direction: dir.direction } : port;
  const t = targetSection(p);
  return t && "section" in t ? t.section : null;
}

/** Standard section for a port by what it carries; null when that is not unambiguous. */
export function sectionByPurpose(port: PortLike, directionHint?: "input" | "output"): Section | `${Section} (${string})` | null {
  const sig = str(port.signalType);
  const dir = directionHint ?? (port.direction === "input" || port.direction === "output" ? port.direction : null);
  const label = str(port.label).toLowerCase();
  // HDBaseT / DTP / XTP port configurable as input or output (DTP3 I/O, XTP I/O).
  if (sig === "hdbaset" && port.direction === "bidirectional" && !directionHint) return "Video Inputs (Configurable)";
  if (VIDEO_SIGNALS.has(sig)) return dir === "input" ? "Video Inputs" : dir === "output" ? "Video Outputs" : null;
  // Analog audio port configurable as input or output (v1.8): Audio I/O.
  if (sig === "analog-audio" && port.direction === "bidirectional" && CONFIGURABLE_RE.test(str((port as Obj).notes))) return "Audio I/O";
  if (AUDIO_SIGNALS.has(sig)) return dir === "input" ? "Audio Inputs" : dir === "output" ? "Audio Outputs" : null;
  if (sig === "pots") return "Telephony";
  if (sig === "speaker-level") return dir === "output" ? "Speaker Outputs" : dir === "input" ? "Audio Inputs" : null;
  // Fiber: a duplex link is data (SFP uplink, AVoIP, NAV); a one-way link carries AV like HDBaseT (4.1).
  if (sig === "fiber") return dir === "input" ? "Video Inputs" : dir === "output" ? "Video Outputs" : port.direction === "bidirectional" ? "Network" : null;
  if (sig === "dmx" || sig === "midi" || sig === "sensor") return "Control";
  // Reference and time signals (genlock, word clock, timecode): Sync (v3).
  if (SYNC_SIGNALS.has(sig)) return "Sync";
  if (sig === "bluetooth") return "RF";
  if (BUS_SIGNALS.has(sig)) return "Expansion";
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

export function sectionBase(section: string): string {
  return section.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function sectionSuffix(section: string): string {
  const m = /\(([^)]*)\)\s*$/.exec(section);
  return m ? ` (${m[1].trim()})` : "";
}

/** The section a port should have, or a reason why it cannot be decided. */
export function targetSection(port: PortLike): { section: string; front: boolean } | { manual: string } | null {
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
