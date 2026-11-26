/**
 * The review queue (step 2.3): draft catalog templates approve:catalog leaves for an engineer —
 * level B, or ports from the community database (db, a variant of db) or with no recorded source.
 * Grouped by reason (the linter rule behind level B; the ports source for level A) and by model
 * family, each with a proposal: a rule (closes the group without inventing data), data (from
 * the manufacturer's documents) or manual work. Pure: the CLI (api-avail/src/reviewQueueCli.ts)
 * reads the catalog files or a database snapshot.
 */
import type { BlockLevel } from "./blockLint";
import { seriesOf } from "./catalogPorts";
import type { PortsOriginInfo } from "./portsOrigin";

export interface QueueItem {
  id: string;
  label: string;
  manufacturer: string;
  deviceType: string;
  category: string;
  level: BlockLevel;
  warnings: string[];
  origin: PortsOriginInfo;
  /** Catalog file (files mode) or template id. */
  where: string;
}

export type ProposalKind = "rule" | "data" | "manual";

export interface Proposal {
  kind: ProposalKind;
  text: string;
}

export interface QueueGroup {
  /** "lint: no weightKg", "source: db"… */
  reason: string;
  kind: "lint" | "source";
  count: number;
  /** Templates for which this is the only reason (fixing it alone moves them on). */
  only: number;
  vendors: [string, number][];
  families: [string, number][];
  deviceTypes: [string, number][];
  examples: string[];
  proposal: Proposal;
}

export interface ReviewQueueReport {
  total: number;
  byLevel: Record<"A" | "B", number>;
  bySource: [string, number][];
  groups: QueueGroup[];
}

/** A lint message without the port name and quoted values: the rule. */
export function lintRule(message: string): string {
  return message.replace(/^"[^"]*": /, "").replace(/"[^"]*"/g, "…").replace(/\s*;\s*use .*$/, "").trim();
}

/** Ports source as a queue reason. */
export function sourceReason(o: PortsOriginInfo): string | null {
  if (o.origin === "community") return o.via ? "variant of db" : o.kind === "upstream" ? "easyschematic.live" : "db";
  if (o.origin === "none") return "no source";
  return null;
}

/** Proposals per reason (first match); the rest is manual. */
const PROPOSALS: { re: RegExp; proposal: Proposal }[] = [
  { re: /^no (heightMm|widthMm|depthMm|weightKg)$/, proposal: { kind: "data", text: "Dimensions and weight from the data sheet; room-mounted devices (by category, type or mounting words in the name) need none — rule v0.9 applied." } },
  { re: /^no powerDrawW\/voltage/, proposal: { kind: "data", text: "Power draw and voltage from the data sheet. Proposed rules R1 (slots-only chassis) and R2 (voltage from the power notes) close a few; the rest needs the data sheet." } },
  { re: /^no power port$/, proposal: { kind: "data", text: "Add the power input from the data sheet, or the bus-power note (\"PoE\", \"bus-powered (USB)\") on the port that powers it." } },
  { re: /^label longer than 28 characters$/, proposal: { kind: "rule", text: "Proposed rule R3 (In / Out wording, a long qualifier to notes) closes these without new data; otherwise shorten by hand to the silkscreen." } },
  { re: /^label in all caps$/, proposal: { kind: "rule", text: "The normalizer already rewrites all-caps labels: run normalize:library on these." } },
  { re: /^(no section|section … is not in the vocabulary)$/, proposal: { kind: "rule", text: "The normalizer puts the port into the section of its signal when it can tell; the rest by hand." } },
  { re: /must be input or output, not bidirectional$/, proposal: { kind: "manual", text: "Check the direction on the panel (the normalizer sets it only when the label says In / Out)." } },
  { re: /must be (contact-closure|ebus|hdbaset)$|marked as rs422$/, proposal: { kind: "manual", text: "Signal type against the label: check the panel and correct the signal (or the label)." } },
  { re: /must be bidirectional/, proposal: { kind: "rule", text: "The normalizer makes LAN / Dante / AVB / serial / GPIO / buses bidirectional: run normalize:library." } },
  { re: /^no referenceUrl$/, proposal: { kind: "data", text: "Product page URL from the manufacturer's site." } },
  { re: /^no searchTerms$|^no shortName$/, proposal: { kind: "rule", text: "Derivable from the label and part number without new data (catalog cards have them; generate the same way)." } },
  { re: /^db$/, proposal: { kind: "manual", text: "Community ports: an engineer compares them with the data sheet in Review, then Verify — or ports from the data sheet (portsSource datasheet) and approve:catalog." } },
  { re: /^variant of db$/, proposal: { kind: "manual", text: "Follows the variant it copied: review that one (or give it data-sheet ports), then fill:catalog-ports again." } },
  { re: /^no source$/, proposal: { kind: "data", text: "Ports from the data sheet with portsSource datasheet." } },
  { re: /^easyschematic\.live$/, proposal: { kind: "manual", text: "Upstream import: review against the data sheet." } },
];

export function proposalFor(reason: string): Proposal {
  return PROPOSALS.find((p) => p.re.test(reason))?.proposal ?? { kind: "manual", text: "Review by hand." };
}

function top(m: Map<string, number>, n = 100): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Reasons of an item: the lint rules for level B, the ports source for A (both when both apply). */
export function reasonsOf(item: QueueItem): { reason: string; kind: "lint" | "source" }[] {
  const out: { reason: string; kind: "lint" | "source" }[] = [];
  if (item.level === "B") for (const r of new Set(item.warnings.map(lintRule))) out.push({ reason: r, kind: "lint" });
  const src = sourceReason(item.origin);
  if (src) out.push({ reason: src, kind: "source" });
  return out;
}

export function reviewQueue(items: readonly QueueItem[]): ReviewQueueReport {
  const groups = new Map<string, { kind: "lint" | "source"; items: QueueItem[]; only: number }>();
  const sources = new Map<string, number>();
  for (const it of items) {
    const rs = reasonsOf(it);
    bump(sources, sourceReason(it.origin) ?? `manufacturer (${it.origin.via?.kind ?? it.origin.kind ?? "?"})`);
    for (const r of rs) {
      const key = `${r.kind}: ${r.reason}`;
      const g = groups.get(key) ?? { kind: r.kind, items: [], only: 0 };
      g.items.push(it);
      if (rs.length === 1) g.only++;
      groups.set(key, g);
    }
  }
  const out: QueueGroup[] = [...groups.entries()].map(([key, g]) => {
    const reason = key.replace(/^(lint|source): /, "");
    const fam = new Map<string, number>();
    const ven = new Map<string, number>();
    const dt = new Map<string, number>();
    for (const it of g.items) {
      bump(fam, `${it.manufacturer} ${seriesOf(it)}`);
      bump(ven, it.manufacturer);
      bump(dt, it.deviceType);
    }
    return {
      reason,
      kind: g.kind,
      count: g.items.length,
      only: g.only,
      vendors: top(ven),
      families: top(fam, 12),
      deviceTypes: top(dt, 8),
      examples: g.items.slice(0, 5).map((i) => i.label),
      proposal: proposalFor(reason),
    };
  });
  out.sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === "lint" ? -1 : 1));
  return {
    total: items.length,
    byLevel: { A: items.filter((i) => i.level === "A").length, B: items.filter((i) => i.level === "B").length },
    bySource: top(sources),
    groups: out,
  };
}

const PROPOSAL_LABEL: Record<ProposalKind, string> = { rule: "rule", data: "data", manual: "manual" };

const esc = (s: string) => s.replace(/\|/g, "\\|");

/** docs/avail/review-queue.md. `extra` — sections the CLI adds (the v0.9 rule effect, proposed rules). */
export function formatReviewQueue(r: ReviewQueueReport, meta: { source: string; date: string }, extra: string[] = []): string {
  const lines = [
    "# Review queue",
    "",
    `Draft catalog templates that \`approve:catalog\` leaves for an engineer. Source: ${meta.source}; generated ${meta.date} by \`npm run report:review-queue\` (api-avail).`,
    "",
    `In the queue: **${r.total}** — level B ${r.byLevel.B}, level A with ports not from the manufacturer ${r.byLevel.A}.`,
    "",
    "By ports source: " + r.bySource.map(([k, n]) => `${k} ${n}`).join(", ") + ".",
    "",
    "A template is counted under every reason it has; **only** — templates for which this is the only reason (closing it moves them on: B → A, or to approval).",
    "",
    "| Group | Reason | Templates | Only | Families (top) | Proposal |",
    "|---|---|---:|---:|---|---|",
  ];
  for (const g of r.groups) {
    const fam = g.families.slice(0, 4).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(`| ${g.kind === "lint" ? "Level B" : "Ports source"} | ${esc(g.reason)} | ${g.count} | ${g.only} | ${esc(fam)} | **${PROPOSAL_LABEL[g.proposal.kind]}** — ${esc(g.proposal.text)} |`);
  }
  for (const g of r.groups) {
    lines.push("", `## ${g.kind === "lint" ? "Level B" : "Ports source"}: ${g.reason} (${g.count})`, "");
    lines.push(`Proposal: **${PROPOSAL_LABEL[g.proposal.kind]}** — ${g.proposal.text}`, "");
    lines.push(`- Vendors: ${g.vendors.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`- Device types: ${g.deviceTypes.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`- Families: ${g.families.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    lines.push(`- Examples: ${g.examples.join("; ")}`);
  }
  if (extra.length) lines.push("", ...extra);
  return lines.join("\n") + "\n";
}
