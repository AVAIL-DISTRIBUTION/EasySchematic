/** Markdown and table rows of the duplicates report (report:duplicates, docs/avail/duplicates.md). Pure. */
import type { DupGroup } from "./duplicates";

const STATUS: Record<string, string> = { verified: "Verified", draft: "Draft", raw: "Unverified", hidden: "Hidden" };
const ORIGIN: Record<string, string> = { manufacturer: "document", community: "database", none: "none" };

export const DUPLICATE_COLUMNS = ["Group", "Role", "Template id", "Label", "Manufacturer", "Model number", "Status", "Source", "Ports from", "Level", "Ports", "Why"] as const;

/** One line per template: the primary first in each group, then the others ("merge into the primary"). */
export function duplicateRows(groups: readonly DupGroup[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  groups.forEach((g, i) => {
    for (const c of g.members) {
      rows.push([
        i + 1, c.id === g.primary ? "primary" : "duplicate", c.id, c.label, c.manufacturer, c.modelNumber, STATUS[c.status] ?? c.status,
        c.source ?? "", ORIGIN[c.portsOrigin] ?? c.portsOrigin, c.level ?? "", c.ports, g.reasons.join(", "),
      ]);
    }
  });
  return rows;
}

export function formatDuplicates(groups: readonly DupGroup[], meta: { source: string; date: string; total: number; notDuplicates?: number }): string {
  const dups = groups.reduce((n, g) => n + g.members.length - 1, 0);
  const by = (r: string) => groups.filter((g) => g.reasons.includes(r as never)).length;
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "# Possible duplicates",
    "",
    `Source: ${meta.source}; ${meta.total} templates (hidden ones left out). Generated ${meta.date} by \`npm run report:duplicates\` (api-avail); the same table — \`duplicates.xlsx\`.`,
    "",
    `**${groups.length}** groups, **${dups}** templates to merge into a primary. Same manufacturer + part number: ${by("same part number")} groups; same normalized model: ${by("same model")}.` +
      (meta.notDuplicates ? ` Pairs marked "not duplicates" by a librarian, left out: ${meta.notDuplicates}.` : ""),
    "",
    "A pair is a duplicate when the manufacturer and modelNumber match, or the label without the manufacturer, punctuation, case and variant words " +
      "(colour, MM / SM, region, LinkLicense…) matches — and the variant is the same; templates that differ only by the variant are variants, not duplicates. " +
      "The proposed primary: verified > draft > unverified; catalog / curated library > community; ports from a document > database; then level and ports. " +
      "In the library workspace: filter \"Possible duplicates\", select, \"Merge into…\" (the others become hidden with the reason \"duplicate of <id>\").",
    "",
    "| # | Primary | Duplicates | Why |",
    "|---:|---|---|---|",
  ];
  const show = (c: DupGroup["members"][number]) => `${esc(c.label)} (\`${c.id}\`, ${STATUS[c.status] ?? c.status}, ${c.source ?? "—"}, ports: ${ORIGIN[c.portsOrigin]}${c.level ? `, ${c.level}` : ""})`;
  groups.forEach((g, i) => {
    const primary = g.members[0];
    lines.push(`| ${i + 1} | ${show(primary)} | ${g.members.slice(1).map(show).join("<br>")} | ${g.reasons.join(", ")} |`);
  });
  return lines.join("\n") + "\n";
}
