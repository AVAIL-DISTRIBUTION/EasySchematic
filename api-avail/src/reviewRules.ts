/**
 * Proposed rules for the review queue (step 2.3, item 3): mass reasons that a rule could close
 * without inventing data. Each is simulated on a copy of the queue's level-B templates and
 * reported with its effect (B → A) — none is applied: the standard changes by decision.
 */
import { lintBlock } from "../../src/avail/blockLint";
import type { QueueItem } from "../../src/avail/reviewQueue";

type Obj = Record<string, unknown>;
type Port = Obj & { label?: string; signalType?: string; direction?: string; notes?: string; section?: string };

export interface ProposedRule {
  id: string;
  title: string;
  /** What the rule does and why it invents nothing. */
  text: string;
  /**
   * The template (a copy) as the rule would leave it, and the lint warning it would no longer
   * raise (a linter rule rather than a data change); null when the rule does not apply.
   */
  apply: (t: Obj) => Applied | null;
}

interface Applied {
  t: Obj;
  drop?: RegExp;
}

/** Level after the rules: lint the changed template, without the warnings the rules close. */
function levelAfter(a: Applied, drops: RegExp[] = []): string {
  const l = lintBlock(a.t);
  if (l.errors.length) return "FIX";
  const all = [...drops, ...(a.drop ? [a.drop] : [])];
  return l.warnings.filter((w) => !all.some((d) => d.test(w))).length ? "B" : "A";
}

const powerInputs = (t: Obj) => ((t.ports as Port[] | undefined) ?? []).filter((p) => p.signalType === "power" && p.direction === "input");

/** One voltage stated in a text: "12 V DC", "12VDC", "100-240 V AC", "24 V". */
const VOLTAGE_RE = /\b(\d{1,3}(?:-\d{2,3})?)\s?V\s?(AC|DC)?\b|\b(\d{1,3}(?:-\d{2,3})?)\s?V(AC|DC)\b/gi;

function voltageOfNotes(notes: string): string | null {
  const found = new Set<string>();
  for (const m of notes.matchAll(VOLTAGE_RE)) {
    const v = m[1] ?? m[3];
    const kind = (m[2] ?? m[4] ?? "").toUpperCase();
    found.add(`${v}V${kind ? ` ${kind}` : ""}`);
  }
  // Only an unambiguous single statement (a PSU note naming mains and DC says two things).
  return found.size === 1 ? [...found][0] : null;
}

export const PROPOSED_RULES: ProposedRule[] = [
  {
    id: "R1",
    title: "Slots-only chassis without a power input need no power figures",
    text:
      "A chassis whose only connections are slots (Cable Cubby drawers CCD 220 / 320) and that has no power input is passive: " +
      "powerDrawW / voltage are not required, as for passive devices (3.1). Reads only the ports and slots the card has.",
    apply: (t) => {
      const slots = (t.slots as unknown[] | undefined) ?? [];
      if (!slots.length || ((t.ports as unknown[] | undefined) ?? []).length || powerInputs(t).length) return null;
      return { t, drop: /^no powerDrawW\/voltage/ };
    },
  },
  {
    id: "R2",
    title: "Voltage from the power input's notes",
    text:
      "When the card has powerDrawW but no voltage, and the notes of its single power input state exactly one voltage " +
      "(\"External 12VDC …\", \"12 V 2 A DC\"), that voltage is the card's voltage. The value is already in the card.",
    apply: (t) => {
      if (t.voltage || t.powerDrawW == null) return null;
      const inputs = powerInputs(t);
      if (inputs.length !== 1) return null;
      const v = voltageOfNotes(`${inputs[0].label ?? ""} ${inputs[0].notes ?? ""}`);
      return v ? { t: { ...t, voltage: v } } : null;
    },
  },
  {
    id: "R3",
    title: "Port label wording: Input / Output → In / Out, a long qualifier to notes",
    text:
      "Labels over 28 characters (\"HDMI Output 1 (Buffered Mirror)\", \"DTP3/XTP/HDBT Scaled Output 2\", \"USB 2.0 (Rear, " +
      "Communication)\"): the standard's form In / Out (4.2), and when still too long the bracket moves to notes. " +
      "Words change, the facts stay — a normalizer rule.",
    apply: (t) => {
      let changed = false;
      const ports = ((t.ports as Port[] | undefined) ?? []).map((p) => {
        const label = p.label ?? "";
        if ([...label].length <= 28) return p;
        let l = label.replace(/\bInput\b/g, "In").replace(/\bOutput\b/g, "Out");
        let notes = p.notes ?? "";
        if ([...l].length > 28) {
          const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(l);
          if (m) {
            l = m[1];
            notes = notes ? `${m[2]}; ${notes}` : m[2];
          }
        }
        if ([...l].length > 28 || l === label) return p;
        changed = true;
        return { ...p, label: l, ...(notes ? { notes } : {}) };
      });
      return changed ? { t: { ...t, ports } } : null;
    },
  },
];

/** Markdown section: each proposed rule with how many level-B templates it touches and moves to A. */
export function proposedRules(items: readonly QueueItem[], templates: ReadonlyMap<string, Obj>): string[] {
  const lines = [
    "## Proposed rules (not applied)",
    "",
    "Mass reasons a rule could close without inventing data, simulated on the queue's level-B templates. " +
      "**Alone** — B → A with this rule only; **with all** — B → A with every proposed rule (and the rules already in force).",
    "",
    "| Rule | Applies to | B → A alone | B → A with all | Of those, approvable (manufacturer ports) |",
    "|---|---:|---:|---:|---:|",
  ];
  const bItems = items.filter((i) => i.level === "B");
  const all = (t: Obj): string => {
    const drops: RegExp[] = [];
    let cur = t;
    for (const r of PROPOSED_RULES) {
      const a = r.apply(cur);
      if (!a) continue;
      cur = a.t;
      if (a.drop) drops.push(a.drop);
    }
    return levelAfter({ t: cur }, drops);
  };
  const withAll = new Set(bItems.filter((i) => templates.has(i.where) && all(templates.get(i.where)!) === "A").map((i) => i.where));
  const details: string[] = [];
  for (const r of PROPOSED_RULES) {
    const touched: QueueItem[] = [];
    const alone: QueueItem[] = [];
    for (const i of bItems) {
      const t = templates.get(i.where);
      const out = t && r.apply(t);
      if (!out) continue;
      touched.push(i);
      if (levelAfter(out) === "A") alone.push(i);
    }
    const joint = touched.filter((i) => withAll.has(i.where));
    const approvable = joint.filter((i) => i.origin.origin === "manufacturer");
    lines.push(`| ${r.id}. ${r.title} | ${touched.length} | ${alone.length} | ${joint.length} | ${approvable.length} |`);
    details.push(`### ${r.id}. ${r.title}`, "", r.text, "");
    details.push(`- Applies to: ${touched.length ? touched.map((i) => i.label).slice(0, 12).join("; ") + (touched.length > 12 ? "; …" : "") : "none"}`);
    details.push(`- B → A alone: ${alone.length ? alone.map((i) => i.label).join("; ") : "none"}`, "");
  }
  const approvableAll = bItems.filter((i) => withAll.has(i.where) && i.origin.origin === "manufacturer").length;
  lines.push(
    "",
    `With every proposed rule: **${withAll.size}** of ${bItems.length} level-B templates reach A; ${approvableAll} of them have ports from the manufacturer ` +
      "and would be approved by approve:catalog, the rest still need the ports review (source db).",
    "",
    ...details,
  );
  lines.push(
    "Not proposed as rules (they would invent data): power draw of devices whose card has none (Biamp Voltera amplifiers, " +
      "FOX3 endpoints — from the data sheet); passive subwoofers (SF 10C SUB, SF 8CT SUB — active ones exist, the data " +
      "sheet decides); dimensions of rack devices.",
  );
  return lines;
}
