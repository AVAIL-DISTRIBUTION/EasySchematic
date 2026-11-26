/**
 * Rules that fix a block's presentation from what the block already says (standard v0.10,
 * decided on the review queue, step 2.3): no data is invented.
 *
 *   R2 — voltage: a block with powerDrawW but no voltage takes the voltage its single power input
 *        states in its label or notes ("External 12VDC …", "12 V 2 A DC"), when it states exactly one;
 *   R3 — port labels over 28 characters: Input / Output → In / Out (4.2); still too long, the
 *        trailing bracket moves to the notes.
 *
 * (R1 — a slots-only chassis without a power input needs no power figures — is a linter rule,
 * blockLint.ts.) Used by the normalizer (Edit → Normalize, normalize:library) and by
 * fill:catalog-ports, so catalog cards keep them whatever source their ports come from.
 * Pure, no Node or browser dependencies.
 */
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

export interface RuleChange {
  rule: "R2" | "R3";
  field: string;
  from: unknown;
  to: unknown;
}

/** Applies R2 and R3 to a copy of the block; returns it with the changes (same object when none). */
export function applyCatalogRules<T extends Obj>(block: T): { block: T; changes: RuleChange[] } {
  const changes: RuleChange[] = [];
  let out: Obj = block;
  const v = voltageFromPowerNotes(block);
  if (v) {
    changes.push({ rule: "R2", field: "voltage", from: block.voltage ?? null, to: v });
    out = { ...out, voltage: v };
  }
  if (Array.isArray(block.ports)) {
    let touched = false;
    const ports = (block.ports as Port[]).map((p) => {
      const s = p && typeof p.label === "string" ? shortenLabel(p.label) : null;
      if (!s) return p;
      touched = true;
      changes.push({ rule: "R3", field: `ports[${str(p.id) || p.label}].label`, from: p.label, to: s.label });
      const notes = str(p.notes);
      return { ...p, label: s.label, ...(s.moved ? { notes: notes ? `${s.moved}; ${notes}` : s.moved } : {}) };
    });
    if (touched) out = { ...out, ports };
  }
  return { block: out as T, changes };
}
