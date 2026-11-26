/**
 * A proposal must change something (step 2.6): POST /submissions with action "update" whose data,
 * as the library would store it, equals the current template is refused — 400 with
 * NO_CHANGE_ERROR, before upstream queues it. Covers the editor's Propose change, the MCP
 * propose_change and direct API calls. The answer goes out through an internal route of the app
 * (CORS and security headers), as the duplicate guard's does.
 */
import type Database from "better-sqlite3";
import type { app as UpstreamAppValue } from "../../api/src/index";
import { rowToTemplate, templateToRow, type TemplateRow } from "../../api/src/db";
import { validateTemplate } from "../../api/src/validate";
import { editChanges, NO_CHANGE_ERROR, noChanges } from "../../src/avail/templatePatch";

type UpstreamApp = typeof UpstreamAppValue;

export const EMPTY_PROPOSAL_PATH = "/avail/internal/empty-proposal";
export const pendingEmptyProposals = new WeakMap<Request, { error: string; templateId: string }>();

/** The refusal for an update proposal that changes nothing; null otherwise (and for anything else). */
export async function emptyProposal(sqlite: Database.Database, request: Request): Promise<{ error: string; templateId: string } | null> {
  if (request.method !== "POST" || new URL(request.url).pathname.replace(/\/$/, "") !== "/submissions") return null;
  let body: { action?: unknown; templateId?: unknown; data?: unknown };
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (body?.action !== "update" || typeof body.templateId !== "string") return null;
  const row = sqlite.prepare("SELECT * FROM templates WHERE id = ?").get(body.templateId) as TemplateRow | undefined;
  if (!row) return null;
  const v = validateTemplate(body.data);
  if (!v.ok) return null; // upstream answers with the validation error
  // As approval would store it: the same row round trip.
  const proposed = rowToTemplate({ ...templateToRow({ ...v.data, id: row.id }), version: row.version } as TemplateRow);
  return noChanges(editChanges(rowToTemplate(row), proposed)) ? { error: NO_CHANGE_ERROR, templateId: row.id } : null;
}

export function registerProposalGuardRoutes(app: UpstreamApp): void {
  app.all(EMPTY_PROPOSAL_PATH, (c) => {
    const refusal = pendingEmptyProposals.get(c.req.raw);
    return refusal ? c.json(refusal, 400, { "Cache-Control": "no-store" }) : c.json({ error: "Not found" }, 404);
  });
}
