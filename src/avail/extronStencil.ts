/**
 * Extron Visio stencils applied to the product catalog (step 1.10): the ports a stencil master
 * draws (src/avail/extronVisio.ts, parsed into tools/avail/extron-visio/extron-visio-blocks.json)
 * for the catalog card with the same part number.
 *
 * - A card without ports gets the stencil's ports.
 * - A card with ports from the community database gets the stencil's ports too (Extron's own
 *   drawing wins on a discrepancy); what the stencil does not say — notes, a connector it does
 *   not draw — is kept from the community port of the same signal and direction.
 * - A card with curated (library/avail) or datasheet ports keeps them; the stencil is only
 *   compared, discrepancies go to the report.
 * - A master with issues (unknown label or connector, pin-level drawing) is not applied.
 *
 * Then the normalizer and the linter: only the ports of the normalized card are taken, the card
 * itself stays as in the catalog. Pure functions, no Node or browser dependencies.
 */
import type { BlockLevel } from "./blockLint";
import { lintBlock } from "./blockLint";
import type { StencilBlock, StencilPort } from "./extronVisio";
import { normalizeBlock } from "./normalize";

type Obj = Record<string, unknown>;

export interface StencilFile {
  source?: string;
  blocks: StencilBlock[];
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** The best master per part number: clean first, then current over retired, then more ports. */
export function indexStencils(blocks: readonly StencilBlock[]): Map<string, StencilBlock> {
  const rank = (b: StencilBlock) => (b.issues.length ? 2 : 0) + (b.retired ? 1 : 0);
  const out = new Map<string, StencilBlock>();
  for (const b of blocks) {
    for (const pn of b.partNumbers) {
      const k = norm(pn);
      const cur = out.get(k);
      if (!cur || rank(b) < rank(cur) || (rank(b) === rank(cur) && b.ports.length > cur.ports.length)) out.set(k, b);
    }
  }
  return out;
}

/** Stencil master for a card: its part number, then the alternative part number. */
export function stencilFor(t: { modelNumber?: unknown; _avail?: { altPartNumber?: unknown } }, index: Map<string, StencilBlock>): StencilBlock | undefined {
  for (const pn of [t.modelNumber, t._avail?.altPartNumber]) {
    const b = index.get(norm(pn));
    if (b) return b;
  }
  return undefined;
}

// ---------------------------------------------------------------------------- comparison

interface PortLike {
  label?: unknown;
  signalType?: unknown;
  direction?: unknown;
  connectorType?: unknown;
  section?: unknown;
  notes?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Ports of a card slot belong to the card, not to the frame: left out of the comparison. */
function ownPorts(ports: readonly unknown[]): PortLike[] {
  return ports.map((p) => (p ?? {}) as PortLike).filter((p) => !str(p.section).startsWith("Slot"));
}

/**
 * Service ports: the logical drawing leaves out the front-panel configuration port (USB Config
 * (Front)); a card keeps the one it has, and the comparison ignores them.
 */
export function isServicePort(p: PortLike): boolean {
  return str(p.section).startsWith("Configuration") || /\(front\)/i.test(str(p.label));
}

/** "hdmi input" → count, connectors. */
function buckets(ports: readonly PortLike[]): Map<string, { n: number; connectors: Set<string> }> {
  const m = new Map<string, { n: number; connectors: Set<string> }>();
  for (const p of ports) {
    const k = `${str(p.signalType) || "?"} ${str(p.direction) || "?"}`;
    const b = m.get(k) ?? { n: 0, connectors: new Set<string>() };
    b.n++;
    if (str(p.connectorType)) b.connectors.add(str(p.connectorType));
    m.set(k, b);
  }
  return m;
}

/**
 * Differences between ports a card has and the ports the stencil draws, by signal and
 * direction: "hdmi input: 4 → 6", "analog-audio output: rca → phoenix". Empty when they agree.
 */
export function comparePorts(current: readonly unknown[], stencil: readonly unknown[]): string[] {
  const a = buckets(ownPorts(current).filter((p) => !isServicePort(p)));
  const b = buckets(ownPorts(stencil).filter((p) => !isServicePort(p)));
  const out: string[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(k);
    const y = b.get(k);
    if ((x?.n ?? 0) !== (y?.n ?? 0)) out.push(`${k}: ${x?.n ?? 0} → ${y?.n ?? 0}`);
    else if (x && y && x.connectors.size && y.connectors.size && [...y.connectors].some((c) => !x.connectors.has(c))) {
      out.push(`${k}: ${[...x.connectors].sort().join("/")} → ${[...y.connectors].sort().join("/")}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- ports for a card

/**
 * Stencil ports for a card. Ports keep the stencil's label, signal, direction and section;
 * from the card's current port of the same signal and direction (in order) they take the notes
 * when the connector agrees, and the connector when the stencil draws none. A power port
 * without a connector on a card that runs on AC gets the IEC inlet (Extron's internal supplies).
 */
export function stencilPortsFor(
  card: { voltage?: unknown; ports?: unknown },
  block: StencilBlock,
): { ports: StencilPort[]; borrowed: number } {
  const current = ownPorts(Array.isArray(card.ports) ? card.ports : []);
  const pool = new Map<string, PortLike[]>();
  for (const p of current) {
    const k = `${str(p.signalType)}|${str(p.direction)}`;
    pool.set(k, [...(pool.get(k) ?? []), p]);
  }
  let borrowed = 0;
  const ports = block.ports.map((sp) => {
    const p: StencilPort = { ...sp };
    // Same signal and direction in order; for the connector alone, any port of the signal.
    const match = pool.get(`${sp.signalType}|${sp.direction}`)?.shift();
    if (!match && !p.connectorType) {
      const any = current.find((c) => str(c.signalType) === sp.signalType && str(c.connectorType));
      if (any) {
        p.connectorType = str(any.connectorType);
        borrowed++;
      }
    }
    if (match) {
      const mc = str(match.connectorType);
      if (!p.connectorType && mc) {
        p.connectorType = mc;
        borrowed++;
      }
      const notes = str(match.notes).trim();
      if (notes && (!mc || mc === p.connectorType)) {
        p.notes = p.notes && !notes.toLowerCase().includes(p.notes.toLowerCase()) ? `${notes} (${p.notes})` : notes;
        borrowed++;
      }
    }
    if (!p.connectorType && sp.signalType === "power" && sp.direction === "input" && /\bAC\b|VAC|100-240/i.test(str(card.voltage))) {
      p.connectorType = "iec";
    }
    return p;
  });
  // Service ports the drawing leaves out stay as the card had them.
  const service = current.filter((c) => isServicePort(c) && !ports.some((p) => isServicePort(p) && p.signalType === str(c.signalType)));
  const firstPower = ports.findIndex((p) => p.section.startsWith("Power"));
  const at = firstPower < 0 ? ports.length : firstPower;
  ports.splice(at, 0, ...service.map((c, i) => ({ ...(c as unknown as StencilPort), id: `${block.ports[0]?.id.replace(/-\d+$/, "") ?? "vx"}-s${i + 1}` })));
  borrowed += service.length;
  return { ports, borrowed };
}

/** The card with new ports, normalized; only the normalized ports are kept. */
export function normalizedPorts<T extends Obj>(card: T, ports: readonly unknown[]): unknown[] {
  const { template } = normalizeBlock({ ...card, ports: ports.map((p) => ({ ...(p as Obj) })) });
  return ((template as Obj).ports as unknown[]) ?? [];
}

export function levelOf(t: object): BlockLevel {
  return lintBlock(t).level;
}

// ---------------------------------------------------------------------------- Extron DC power

/** Card voltage that is Extron's 12 V DC external supply ("12V DC", "12 VDC", "12V DC / PoE"). */
const DC12_RE = /\b12\s?V\s?DC\b|\b12\s?VDC\b/i;
export const EXTRON_DC_NOTE = "2-pole captive screw — Extron convention, verify";

/**
 * Extron's 12 V DC devices take their external supply on a 2-pole 3.5 mm captive screw: a card
 * whose voltage says 12 V DC gets a "12V DC In" port when it has no power input, and a power
 * input the drawing left without a connector gets the captive screw. Noted to verify.
 * Returns the same array when nothing applies.
 */
export function withExtronDcPower<P>(card: { id?: unknown; voltage?: unknown }, ports: readonly P[]): P[] {
  if (!DC12_RE.test(str(card.voltage))) return ports as P[];
  const list = ports as unknown as PortLike[];
  const inputs = list.filter((p) => str(p.signalType) === "power" && str(p.direction) === "input" && !str(p.section).startsWith("Slot"));
  if (inputs.length && inputs.every((p) => str(p.connectorType))) return ports as P[];
  if (inputs.length) {
    return list.map((p) =>
      inputs.includes(p) && !str(p.connectorType)
        ? { ...p, connectorType: "phoenix", notes: str(p.notes) ? `${str(p.notes)}; ${EXTRON_DC_NOTE}` : EXTRON_DC_NOTE }
        : p,
    ) as unknown as P[];
  }
  const port = { id: `${str(card.id) || "extron"}-dc12`, label: "12V DC In", signalType: "power", direction: "input", connectorType: "phoenix", section: "Power", notes: EXTRON_DC_NOTE };
  return [...ports, port as unknown as P];
}

// ---------------------------------------------------------------------------- chassis slots

export interface ChassisSlots {
  slots?: { id: string; label: string; slotFamily: string }[];
  /** How the slots were found ("description: for 4 AAP Modules", "variant: <file>"). */
  from?: string;
  /** Why no slots could be set (goes to _avail.portsMissing). */
  missing?: string;
}

const FAMILY_WORD: Record<string, RegExp> = {
  "extron-cubby-aap": /\bAAP\b/i,
  "extron-cubby-maap": /\bMAAP\b/i,
  "extron-cubby-flex55": /\bFlex ?55\b/i,
};

/**
 * Slots of a chassis that has none: from its description when it names the count ("Drawer for
 * 4 AAP Modules"), else nothing — the stencil draws no openings, so the reason is returned.
 */
export function chassisSlotsFromDescription(card: { _avail?: { slotFamilies?: unknown; description?: unknown } }): ChassisSlots {
  const fams = Array.isArray(card._avail?.slotFamilies) ? (card._avail!.slotFamilies as unknown[]).filter((f): f is string => typeof f === "string") : [];
  const fam = fams[0];
  if (!fam) return {};
  const desc = str(card._avail?.description);
  const word = FAMILY_WORD[fam];
  const m = word ? new RegExp(`\\b(\\d+)\\s+(?:${word.source.replace(/\\b/g, "")})\\b`, "i").exec(desc) : null;
  if (m) {
    const n = Number(m[1]);
    return {
      slots: Array.from({ length: n }, (_, i) => ({ id: `slot-${i + 1}`, label: `Slot ${i + 1}`, slotFamily: fam })),
      from: `description: ${m[0]}`,
    };
  }
  return { missing: `number of ${fam} openings: not drawn in the Extron stencil and not in the description` };
}
