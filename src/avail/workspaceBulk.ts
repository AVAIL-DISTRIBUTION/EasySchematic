/**
 * Library workspace bulk actions in batches. The API takes at most 500 template ids per request
 * (api-avail: routes.ts MAX_BATCH for status, workspace.ts MAX_CATEGORY_BATCH for category), so a
 * larger selection is sent in batches of BULK_BATCH, one after another, with progress
 * ("batch N of M"); a failed batch does not stop the rest; the results add up to one report.
 *
 * Pure (the request is passed in), for the page and the tests.
 */
import { BULK_LABELS, type BulkPlan } from "./workspaceModel";

/** Most template ids per request; equal to the API's limits (checked by api-avail/test/workspace.test.ts). */
export const BULK_BATCH = 500;

export function chunks<T>(items: readonly T[], size: number = BULK_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What one request returns, for status and category alike. */
export interface BatchAnswer {
  updated: string[];
  unchanged?: string[];
  failed: { id: string; label?: string | null; reason: string; level?: string }[];
}

export interface BulkOutcome {
  batches: number;
  updated: string[];
  unchanged: string[];
  /** Refused by the server (not level A, not found). */
  refused: { id: string; label: string | null; reason: string }[];
  /** Requests that failed as a whole (network, HTTP error): their ids were not changed. */
  failedBatches: { batch: number; ids: string[]; error: string }[];
}

/**
 * Sends the plan's changes in batches. `send` makes one request; `onProgress(n, m)` is called
 * before batch n of m goes out.
 */
export async function runBulk(
  plan: BulkPlan,
  send: (ids: string[]) => Promise<BatchAnswer>,
  onProgress: (batch: number, of: number) => void = () => {},
  size: number = BULK_BATCH,
): Promise<BulkOutcome> {
  const parts = chunks(plan.change.map((c) => c.row.id), size);
  const out: BulkOutcome = { batches: parts.length, updated: [], unchanged: [], refused: [], failedBatches: [] };
  for (let i = 0; i < parts.length; i++) {
    onProgress(i + 1, parts.length);
    try {
      const r = await send(parts[i]);
      out.updated.push(...r.updated);
      out.unchanged.push(...(r.unchanged ?? []));
      for (const f of r.failed) {
        const reason = f.reason === "not_level_a" ? `level ${f.level ?? "?"}, verified needs A` : f.reason === "not_found" ? "not found" : f.reason;
        out.refused.push({ id: f.id, label: f.label ?? null, reason });
      }
    } catch (e) {
      out.failedBatches.push({ batch: i + 1, ids: parts[i], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const MAX_LINES = 50;

/** The report after a bulk action: totals over all batches, then what was refused or failed. */
export function bulkReport(plan: BulkPlan, o: BulkOutcome): string[] {
  const what = plan.action === "category" ? `Category set to ${plan.category}` : BULK_LABELS[plan.action];
  const notSent = o.failedBatches.reduce((n, b) => n + b.ids.length, 0);
  const lines = [
    `${what}: ${o.updated.length} changed` +
      (o.unchanged.length ? `, ${o.unchanged.length} already there` : "") +
      `, ${o.refused.length} refused` +
      (notSent ? `, ${notSent} not changed (failed batches)` : "") +
      ` — ${o.batches} ${o.batches === 1 ? "batch" : "batches"} of up to ${BULK_BATCH}.`,
  ];
  for (const b of o.failedBatches) lines.push(`Batch ${b.batch} of ${o.batches} failed (${b.ids.length} templates, unchanged): ${b.error}. Run the action again for them.`);
  const label = (id: string, l: string | null) => l ?? plan.change.find((c) => c.row.id === id)?.row.template.label ?? id;
  for (const f of o.refused.slice(0, MAX_LINES)) lines.push(`Refused: ${label(f.id, f.label)}: ${f.reason}`);
  if (o.refused.length > MAX_LINES) lines.push(`…and ${o.refused.length - MAX_LINES} more refused.`);
  for (const x of plan.refused.slice(0, MAX_LINES)) lines.push(`Not sent: ${x.row.template.label}: ${x.reason}`);
  if (plan.refused.length > MAX_LINES) lines.push(`…and ${plan.refused.length - MAX_LINES} more not sent.`);
  lines.push("Every change is in the audit log.");
  return lines;
}
