/**
 * Wyrestorm power connector convention (AVAIL decision 2026-11-27): where the manufacturer's document
 * does not name the power connector, it follows from the body of the device, as on the WyreStorm spec
 * sheets that do name it (EX-100-H2, RXV-35-4K, NHD-400, NHD-500-IW-TX):
 *
 *   desktop / shelf box with a DC supply → barrel (locking DC, threaded bushing); the voltage is the
 *                                          supply's (the card's voltage);
 *   in-wall (-IW, -UK, -US part numbers; in-wall, wall plate, gang in the name or description)
 *                                        → phoenix, 2-pin;
 *   rack-mounted with a mains input      → iec.
 *
 *   AC power cord in the box (MX / MXV matrices, kit matrices, IDB-300 / IDB-400 with mains)
 *                                        → iec;
 *   cameras, video and audio bars on an external adapter → barrel (not locking);
 *   PoE-only devices (keypads, touch panels: SYN-KEY10, SYN-TOUCH10) → no power port, "PoE" on the LAN.
 *
 * Signal ports (step 2, same sources plus RXV-35-4K, NHD-500 / 600, EX-35-H2 and MX KIT full range spec
 * sheets): RS-232 → phoenix 3-pin; balanced analog audio → phoenix 5-pin, unbalanced stereo → 3.5 mm;
 * IR → 3.5 mm (TS for an emitter, TRS for a receiver). What the port's own notes already name (3.5mm,
 * 8-pin Mini DIN, N-pin) is taken as named.
 *
 * A box or in-wall device powered over the link (PoH / PoC) also gets its power input: the local supply
 * is the alternative. Every such port says "Wyrestorm convention … — verify" in its notes. Nothing else is
 * changed: a connector the document names stays, other bodies (cameras, bars, panels, mains devices off
 * the rack) are left for a document. Pure, used by fill:catalog-ports (catalogPorts.ts).
 */
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

export const WYRESTORM_NOTES = {
  barrel: "Wyrestorm convention: locking DC barrel (threaded bushing) — verify",
  phoenix: "2-pin; Wyrestorm convention: 2-pin phoenix (in-wall) — verify",
  iec: "Wyrestorm convention: IEC — verify",
  adapter: "Wyrestorm convention: DC barrel, external adapter (not locking) — verify",
  serial: "3-pin; Wyrestorm convention: 3-pin phoenix — verify",
  balanced: "5-pin; Wyrestorm convention: 5-pin phoenix (balanced) — verify",
  unbalanced: "Wyrestorm convention: 3.5 mm (unbalanced stereo) — verify",
  irOut: "TS; Wyrestorm convention: 3.5 mm TS (emitter) — verify",
  irIn: "TRS; Wyrestorm convention: 3.5 mm TRS (receiver) — verify",
  poe: "PoE (powered over the LAN only); Wyrestorm convention — verify",
} as const;

/** Matrices and table boxes that ship with an AC power cord (MX / MXV, IDB-300 / IDB-400). */
const AC_CORD_RE = /^(MXV?-|IDB-[34]00)/i;
/** Cameras and bars on an external adapter. */
const ADAPTER_TYPES = new Set(["ptz-camera", "camera", "video-bar", "audio-bar"]);
/** Powered over PoE only (no supply of their own). */
const POE_ONLY_TYPES = new Set(["keypad", "touch-screen"]);

export type WyrestormBody = "wall" | "rack" | "box" | "other";

const WALL_RE = /\bin-wall\b|\bwall ?plate\b|\bwallplate\b|\b\d-gang\b|\bgang\b/i;

/** The body the convention reads: in-wall, rack-mounted, desktop / shelf box, or anything else. */
export function wyrestormBody(card: Obj): WyrestormBody {
  const pn = str(card.modelNumber);
  const avail = (card._avail ?? {}) as Obj;
  if (/-IW\b|-IW-|-(UK|US)$/i.test(pn) || WALL_RE.test(`${str(card.label)} ${str(avail.description)}`)) return "wall";
  if (card.rackForm === "full" || card.rackForm === "half") return "rack";
  if (card.rackForm === "shelf-only" && card.deviceType !== "expansion-card") return "box";
  return "other";
}

const isAc = (p: Obj, card: Obj) => /\bAC\b|mains/i.test(`${str(p.label)} ${str(p.notes)}`) || (!/\bDC\b/i.test(str(p.label)) && /\bAC\b/i.test(str(card.voltage)) && !/\bDC\b/i.test(str(card.voltage)));
const linkPowered = (card: Obj, ports: Obj[]) =>
  /\bPo[HC]\b|power over hdbaset/i.test([str(card.voltage), str(((card._avail ?? {}) as Obj).description), ...ports.map((p) => str(p.notes))].join(" "));

/** The supply voltage of the card ("12V DC / PoH" → "12V"), or "" when it names none or several. */
function dcVolts(card: Obj): string {
  const all = [...str(card.voltage).matchAll(/(\d+(?:\.\d+)?)\s?V\s?DC/gi)].map((m) => m[1]);
  return new Set(all).size === 1 ? `${all[0]}V` : "";
}

const appendNote = (notes: unknown, note: string) => (str(notes) ? `${str(notes)}; ${note}` : note);

/** A signal port's connector: what its notes name, else the convention; null when neither applies. */
function signalConnector(p: Obj): { connectorType: string; note?: string } | null {
  const notes = str(p.notes);
  const sig = str(p.signalType);
  if (!["serial", "analog-audio", "ir"].includes(sig)) return null;
  // Named in the port's own notes (from the page).
  if (/\b3\.5\s?mm\b/i.test(notes)) return { connectorType: "trs-eighth" };
  if (/\b8-pin mini[- ]?din\b/i.test(notes)) return { connectorType: "mini-din-8" };
  if (/\b\d+-pin\b/i.test(notes) && sig !== "ir") return { connectorType: "phoenix" };
  if (sig === "serial") return { connectorType: "phoenix", note: WYRESTORM_NOTES.serial };
  if (sig === "ir") return str(p.direction) === "output" ? { connectorType: "trs-eighth", note: WYRESTORM_NOTES.irOut } : str(p.direction) === "input" ? { connectorType: "trs-eighth", note: WYRESTORM_NOTES.irIn } : null;
  if (/\bunbalanced\b|\bstereo\b/i.test(notes)) return { connectorType: "trs-eighth", note: WYRESTORM_NOTES.unbalanced };
  if (/\bbalanced\b/i.test(notes)) return { connectorType: "phoenix", note: WYRESTORM_NOTES.balanced };
  return null;
}

/** The card's ports with the convention applied (the same array when nothing changes). */
export function withWyrestormPower<P>(card: Obj, ports: readonly P[]): P[] {
  if (str(card.manufacturer) !== "Wyrestorm") return ports as P[];
  let list = ports as unknown as Obj[];
  let changed = false;
  // Signal ports first (any body).
  list = list.map((p) => {
    if (str(p.connectorType)) return p;
    const c = signalConnector(p);
    if (!c) return p;
    changed = true;
    return { ...p, connectorType: c.connectorType, ...(c.note ? { notes: appendNote(p.notes, c.note) } : {}) };
  });
  // PoE-only devices: no power port of their own, PoE on the LAN.
  if (POE_ONLY_TYPES.has(str(card.deviceType))) {
    const lan = list.find((p) => ["ethernet", "dante"].includes(str(p.signalType)));
    const unnamed = list.filter((p) => str(p.signalType) === "power" && str(p.direction) === "input" && !str(p.connectorType));
    if (lan && unnamed.length) {
      changed = true;
      list = list.filter((p) => !unnamed.includes(p)).map((p) => (p === lan && !/\bPoE\b/.test(str(p.notes)) ? { ...p, notes: appendNote(p.notes, WYRESTORM_NOTES.poe) } : p));
    }
  }
  const out = powerConvention(card, list);
  return (out !== list ? out : changed ? list : ports) as P[];
}

/** The power input by body (step 1 and the AC cord / adapter additions). */
function powerConvention(card: Obj, list: Obj[]): Obj[] {
  const body = wyrestormBody(card);
  const pn = str(card.modelNumber);
  const inputs = list.filter((p) => str(p.signalType) === "power" && str(p.direction) === "input" && !str(p.section).startsWith("Slot"));
  const connectorFor = (p: Obj): keyof typeof WYRESTORM_NOTES | null => {
    if (isAc(p, card)) return body === "rack" || AC_CORD_RE.test(pn) ? "iec" : null;
    if (ADAPTER_TYPES.has(str(card.deviceType))) return "adapter";
    return body === "wall" ? "phoenix" : body === "box" ? "barrel" : null;
  };
  if (inputs.length) {
    let changed = false;
    const next = list.map((p) => {
      if (!inputs.includes(p) || str(p.connectorType)) return p;
      const c = connectorFor(p);
      if (!c) return p;
      changed = true;
      return { ...p, connectorType: c === "adapter" ? "barrel" : c, notes: appendNote(p.notes, WYRESTORM_NOTES[c]) };
    });
    return changed ? next : list;
  }
  if (body === "other" || !list.length || !linkPowered(card, list) || isAc({}, card)) return list;
  const c = body === "wall" ? "phoenix" : "barrel";
  const v = dcVolts(card);
  const port = {
    id: "port-dc",
    label: v ? `${v} DC In` : "DC In",
    signalType: "power",
    direction: "input",
    connectorType: c,
    section: "Power",
    notes: `local supply, alternative to power over the link${v ? "" : "; voltage not published"}; ${WYRESTORM_NOTES[c]}`,
  };
  return [...list, port];
}
