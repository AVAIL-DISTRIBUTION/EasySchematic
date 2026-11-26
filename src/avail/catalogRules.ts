/**
 * Rules that fix a block's presentation from what the block already says (standard v0.10,
 * decided on the review queue, step 2.3): no data is invented.
 *
 *   R2 — voltage: a block with powerDrawW but no voltage takes the voltage its single power input
 *        states in its label or notes ("External 12VDC …", "12 V 2 A DC"), when it states exactly one;
 *   R3 — port labels over 28 characters: Input / Output → In / Out (4.2); still too long, the
 *        trailing bracket moves to the notes;
 *   R4 — signal type from the label: "Relay N" (also "IPCP Relay N") → contact-closure, an output
 *        unless it says input, section Relays; "eBUS" → ebus, bidirectional, section Expansion;
 *   R5 — power notes by group, where the device type or the manufacturer's document says so:
 *        Extron passive subwoofers (only speaker-level inputs, no power port; a speaker is passive to
 *        the linter already) → "passive" in the notes of the first input; Extron devices powered by
 *        their host (HOST_POWERED) → "powered by host" (on an eBUS port "bus-powered (eBUS)") in the notes
 *        of the port that powers them;
 *   R6 — overrides (docs/avail/overrides.json, src/avail/overrides.ts): accepted proposals and the port
 *        decisions of AVAIL engineers; applied before R2–R5 (the rules see the decided ports) and again
 *        after them (a rule never undoes a decision).
 *
 * (R1 — a slots-only chassis without a power input needs no power figures — is a linter rule,
 * blockLint.ts.) Used by the normalizer (Edit → Normalize, normalize:library) and by
 * fill:catalog-ports, so catalog cards keep them whatever source their ports come from.
 * Pure, no Node or browser dependencies.
 */
import overridesJson from "../../docs/avail/overrides.json";
import { applyOverrides, inSectionOrder, type Override, type OverridesFile } from "./overrides";

type Obj = Record<string, unknown>;
type Port = Obj & { label?: unknown; signalType?: unknown; direction?: unknown; notes?: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const len = (s: string) => [...s].length;
export const MAX_LABEL = 28;

/** Voltages a text states: "12V DC", "100-240V AC", "24V". */
function voltagesIn(text: string): Set<string> {
  const re = /(?<![\d.])(\d{1,3}(?:-\d{2,3})?)\s?V\s?(AC|DC)?\b|(?<![\d.])(\d{1,3}(?:-\d{2,3})?)\s?V(AC|DC)\b/gi;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const v = m[1] ?? m[3];
    const kind = (m[2] ?? m[4] ?? "").toUpperCase();
    out.add(`${v}V${kind ? ` ${kind}` : ""}`);
  }
  return out;
}

/** R2: the voltage to set, or null when the rule does not apply. */
export function voltageFromPowerNotes(block: Obj): string | null {
  if (str(block.voltage).trim() || block.powerDrawW == null || block.powerDrawW === "") return null;
  const inputs = (Array.isArray(block.ports) ? (block.ports as Port[]) : []).filter(
    (p) => p && p.signalType === "power" && p.direction === "input",
  );
  if (inputs.length !== 1) return null;
  const text = `${str(inputs[0].label)} ${str(inputs[0].notes)}`;
  const found = voltagesIn(text);
  if (found.size !== 1) return null;
  const v = [...found][0];
  if (/ (AC|DC)$/.test(v)) return v;
  // "12 V 2 A DC": the kind further on in the same note, when the note names only one.
  const kinds = new Set([...text.matchAll(/\b(AC|DC)\b/gi)].map((m) => m[1].toUpperCase()));
  return kinds.size === 1 ? `${v} ${[...kinds][0]}` : v;
}

/** R3 for one label: the new label and the qualifier moved to notes; null when nothing changes. */
export function shortenLabel(label: string): { label: string; moved?: string } | null {
  if (len(label) <= MAX_LABEL) return null;
  let l = label.replace(/\bInput\b/g, "In").replace(/\bOutput\b/g, "Out");
  let moved: string | undefined;
  if (len(l) > MAX_LABEL) {
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(l);
    if (m && m[1]) {
      l = m[1];
      moved = m[2].trim();
    }
  }
  if (l === label || len(l) > MAX_LABEL) return null;
  return { label: l, ...(moved ? { moved } : {}) };
}

/** R4: "Relay 1", "IPCP Relay 4", "RELAY 2" — a relay output of the device. */
const RELAY_LABEL_RE = /^(?:ipcp\s+)?relay\s*\d+$/i;
const EBUS_LABEL_RE = /(?<![\p{L}\p{N}])ebus(?![\p{L}\p{N}])/iu;
/** Sections a mistyped relay or eBUS port usually sits in; a vocabulary section otherwise stays. */
const RELAY_FROM_SECTIONS = new Set(["", "Digital I/O", "Control", "Serial"]);
const EBUS_FROM_SECTIONS = new Set(["", "Serial", "Control", "Digital I/O"]);

/** R4 for one port: the fields to change, or null. */
export function signalFromLabel(p: Port): Partial<Port> | null {
  const label = str(p.label).trim();
  const sig = str(p.signalType);
  const section = str(p.section);
  if (sig === "power" || section.startsWith("Slot")) return null;
  if (RELAY_LABEL_RE.test(label) && sig !== "contact-closure") {
    const direction = p.direction === "input" ? "input" : "output";
    return {
      signalType: "contact-closure",
      ...(p.direction !== direction ? { direction } : {}),
      ...(direction === "output" && RELAY_FROM_SECTIONS.has(section) ? { section: "Relays" } : {}),
    };
  }
  if (EBUS_LABEL_RE.test(label) && sig !== "ebus") {
    return {
      signalType: "ebus",
      ...(p.direction !== "bidirectional" ? { direction: "bidirectional" } : {}),
      ...(EBUS_FROM_SECTIONS.has(section) ? { section: "Expansion" } : {}),
    };
  }
  return null;
}

/**
 * R5, host power: Extron devices that take their power from the host they plug into (Extron
 * product pages): the port that carries it gets "powered by host".
 */
export const HOST_POWERED: readonly { model: RegExp; port: RegExp; why: string }[] = [
  // Occupancy sensors: powered by the control processor they report to (eBUS port: +12V/+S/-S/G).
  { model: /\bOCS 100[CW]\b/i, port: /ebus|^power$/i, why: "occupancy sensor powered by the control processor" },
  // IP Link relay accessory: 12 V DC from the host on its control port.
  { model: /\bIPA T RLY4\b/i, port: /power in/i, why: "IP Link accessory powered by the host control port" },
];
export const HOST_NOTE = "powered by host";
/** On an eBUS port the standard's name for host power (3.1). */
export const EBUS_NOTE = "bus-powered (eBUS)";
export const PASSIVE_NOTE = "passive";

/**
 * Passive by the device type, but not passive to the linter (a "speaker" already is): subwoofers.
 * Noting speakers too would change approved cards for nothing.
 */
const PASSIVE_TYPES = new Set(["subwoofer"]);

const appendNote = (notes: string, add: string) => (notes ? `${notes}; ${add}` : add);

/** R5: index of the port to note and the note, or null. */
export function powerNote(block: Obj): { index: number; note: string } | null {
  if (str(block.manufacturer) !== "Extron" || !Array.isArray(block.ports)) return null;
  const ports = block.ports as Port[];
  const noted = (p: Port, re: RegExp) => re.test(str(p.notes));
  const host = HOST_POWERED.find((h) => h.model.test(`${str(block.label)} ${str(block.modelNumber)}`));
  if (host) {
    const index = ports.findIndex((p) => p && host.port.test(str(p.label)));
    if (index < 0 || noted(ports[index], /\bpowered by host\b|bus-powered \(eBUS\)/i)) return null;
    return { index, note: ports[index].signalType === "ebus" ? EBUS_NOTE : HOST_NOTE };
  }
  if (!PASSIVE_TYPES.has(str(block.deviceType)) || !ports.length) return null;
  if (!ports.every((p) => p && p.signalType === "speaker-level" && p.direction === "input")) return null;
  if (ports.some((p) => noted(p, /\bpassive\b/i))) return null;
  return { index: 0, note: PASSIVE_NOTE };
}

/** The overrides of the repository (docs/avail/overrides.json): what fill:catalog-ports and the editor apply. */
export const FILE_OVERRIDES: readonly Override[] = (overridesJson as unknown as OverridesFile).overrides;

/** R6 on a copy of the block: its overrides (default: the repository's). */
export function applyOverrideRule<T extends Obj>(block: T, overrides: readonly Override[] = FILE_OVERRIDES): { block: T; changes: RuleChange[] } {
  const r = applyOverrides(block, overrides);
  return { block: r.block, changes: r.changes.map((c) => ({ rule: "R6" as const, field: c.field, from: c.from, to: c.to })) };
}

export interface RuleChange {
  rule: "R2" | "R3" | "R4" | "R5" | "R6";
  field: string;
  from: unknown;
  to: unknown;
}

/** R4 alone (signal type from the label), for templates whose other data stay as they are (verified). */
export function applySignalRule<T extends Obj>(block: T): { block: T; changes: RuleChange[] } {
  const changes: RuleChange[] = [];
  if (!Array.isArray(block.ports)) return { block, changes };
  let touched = false;
  const ports = (block.ports as Port[]).map((p) => {
    const fix = p && typeof p === "object" ? signalFromLabel(p) : null;
    if (!fix) return p;
    touched = true;
    for (const [k, v] of Object.entries(fix)) {
      changes.push({ rule: "R4", field: `ports[${str(p.id) || str(p.label)}].${k}`, from: p[k] ?? null, to: v });
    }
    return { ...p, ...fix };
  });
  if (!touched) return { block, changes };
  const moved = changes.some((c) => c.field.endsWith(".section"));
  return { block: { ...block, ports: moved ? inSectionOrder(ports) : ports } as T, changes };
}

/**
 * Applies R6, R2–R5 and R6 again to a copy of the block; returns it with the changes (same object
 * when none). `overrides` — R6's list (default docs/avail/overrides.json; the database's for CLIs).
 */
export function applyCatalogRules<T extends Obj>(block: T, overrides: readonly Override[] = FILE_OVERRIDES): { block: T; changes: RuleChange[] } {
  const r6 = applyOverrideRule(block, overrides);
  const changes: RuleChange[] = [...r6.changes];
  let out: Obj = r6.block;
  const v = voltageFromPowerNotes(out);
  if (v) {
    changes.push({ rule: "R2", field: "voltage", from: block.voltage ?? null, to: v });
    out = { ...out, voltage: v };
  }
  if (Array.isArray(out.ports)) {
    let touched = false;
    const ports = (out.ports as Port[]).map((p) => {
      const s = p && typeof p.label === "string" ? shortenLabel(p.label) : null;
      if (!s) return p;
      touched = true;
      changes.push({ rule: "R3", field: `ports[${str(p.id) || p.label}].label`, from: p.label, to: s.label });
      const notes = str(p.notes);
      return { ...p, label: s.label, ...(s.moved ? { notes: notes ? `${s.moved}; ${notes}` : s.moved } : {}) };
    });
    if (touched) out = { ...out, ports };
  }
  const r4 = applySignalRule(out);
  out = r4.block;
  changes.push(...r4.changes);
  const pn = powerNote(out);
  if (pn) {
    const ports = [...(out.ports as Port[])];
    const p = ports[pn.index];
    const next = appendNote(str(p.notes), pn.note);
    changes.push({ rule: "R5", field: `ports[${str(p.id) || str(p.label)}].notes`, from: p.notes ?? null, to: next });
    ports[pn.index] = { ...p, notes: next };
    out = { ...out, ports };
  }
  // A rule must not undo a decision: R6 again (no changes unless a rule touched an overridden value).
  const again = applyOverrideRule(out, overrides);
  out = again.block;
  changes.push(...again.changes);
  return { block: out as T, changes };
}
