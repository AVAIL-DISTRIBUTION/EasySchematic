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
} as const;

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

/** The card's ports with the convention applied (the same array when nothing changes). */
export function withWyrestormPower<P>(card: Obj, ports: readonly P[]): P[] {
  if (str(card.manufacturer) !== "Wyrestorm") return ports as P[];
  const body = wyrestormBody(card);
  if (body === "other") return ports as P[];
  const list = ports as unknown as Obj[];
  const inputs = list.filter((p) => str(p.signalType) === "power" && str(p.direction) === "input" && !str(p.section).startsWith("Slot"));
  const connectorFor = (p: Obj): keyof typeof WYRESTORM_NOTES | null => {
    if (isAc(p, card)) return body === "rack" ? "iec" : null;
    return body === "wall" ? "phoenix" : body === "box" ? "barrel" : null;
  };
  if (inputs.length) {
    let changed = false;
    const next = list.map((p) => {
      if (!inputs.includes(p) || str(p.connectorType)) return p;
      const c = connectorFor(p);
      if (!c) return p;
      changed = true;
      return { ...p, connectorType: c, notes: appendNote(p.notes, WYRESTORM_NOTES[c]) };
    });
    return (changed ? next : ports) as P[];
  }
  if (!list.length || !linkPowered(card, list) || isAc({}, card)) return ports as P[];
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
  return [...ports, port as unknown as P];
}
