/**
 * Proposed rules for the review queue (step 2.3, item 3): mass reasons that a rule could close
 * without inventing data. Each is simulated on a copy of the queue's level-B templates and
 * reported with its effect (B → A) — none is applied: the standard changes by decision.
 * The first three (R1–R3) were decided and applied in v0.10; the list is empty until the next.
 */
import { lintBlock } from "../../src/avail/blockLint";
import type { QueueItem } from "../../src/avail/reviewQueue";

type Obj = Record<string, unknown>;

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

/**
 * Rules under consideration. R1 (slots-only chassis), R2 (voltage from the power notes) and R3
 * (port label wording) were proposed here and applied in v0.10 (blockLint.ts, catalogRules.ts).
 * Add the next candidate here: the report simulates it before anyone decides.
 */
export const PROPOSED_RULES: ProposedRule[] = [];

/** Markdown section: each proposed rule with how many level-B templates it touches and moves to A. */
export function proposedRules(
  items: readonly QueueItem[],
  templates: ReadonlyMap<string, Obj>,
  rules: readonly ProposedRule[] = PROPOSED_RULES,
): string[] {
  if (!rules.length) {
    return [
      "## Proposed rules",
      "",
      "None at the moment. R1 (slots-only chassis need no power figures), R2 (voltage from the power input's notes) and " +
        "R3 (port labels: In / Out, a long qualifier to notes) were applied in standard v0.10.",
      "",
      "Not proposed as rules (they would invent data): power draw of devices whose card has none (Biamp Voltera amplifiers, " +
        "FOX3 endpoints — from the data sheet); passive subwoofers (SF 10C SUB, SF 8CT SUB — active ones exist, the data " +
        "sheet decides); dimensions of rack devices.",
    ];
  }
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
    for (const r of rules) {
      const a = r.apply(cur);
      if (!a) continue;
      cur = a.t;
      if (a.drop) drops.push(a.drop);
    }
    return levelAfter({ t: cur }, drops);
  };
  const withAll = new Set(bItems.filter((i) => templates.has(i.where) && all(templates.get(i.where)!) === "A").map((i) => i.where));
  const details: string[] = [];
  for (const r of rules) {
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
