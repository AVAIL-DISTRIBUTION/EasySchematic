/**
 * Duplicate guard on save (step 2.4), run by server.ts before upstream's routes:
 *
 *   POST /templates                  a new template (also POST /avail/templates/draft, an AI
 *                                    Assistant's draft)
 *   PUT  /templates/:id              a saved template (Edit → Save to library), when its
 *                                    manufacturer or modelNumber changes
 *   POST /submissions/:id/approve    an accepted proposal (create; update as for PUT), with the
 *                                    librarian's edited data when the request carries it
 *
 * If another template (not hidden, not flagged, not decided "not duplicates" with this one) has the same manufacturer + modelNumber and the
 * same variant (src/avail/duplicates.ts findDuplicate), the request is refused with 409 and a link
 * to it. A template whose variant differs (colour, MM / SM, the catalog's variant field) is allowed.
 * Existing duplicates can still be edited as long as their manufacturer and part number stay.
 */
import type Database from "better-sqlite3";
import { findDuplicate } from "../../src/avail/duplicates";
import { loadCandidates } from "./duplicates";
import { loadNotDuplicates } from "./notDuplicates";

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

interface Planned {
  /** The template's own id (an update), or null (a new one). */
  id: string | null;
  data: Obj;
}

async function body(request: Request): Promise<Obj | null> {
  try {
    const v = (await request.clone().json()) as unknown;
    return v && typeof v === "object" ? (v as Obj) : null;
  } catch {
    return null;
  }
}

/** What the request would write, or null when it is not a template save. */
async function planned(sqlite: Database.Database, request: Request): Promise<Planned | null> {
  const p = new URL(request.url).pathname.replace(/\/+$/, "");
  // A new template: upstream's POST /templates, or an AI Assistant's draft (assistant.ts).
  if (request.method === "POST" && (p === "/templates" || p === "/avail/templates/draft")) {
    const b = await body(request);
    return b ? { id: null, data: b } : null;
  }
  const put = /^\/templates\/([^/]+)$/.exec(p);
  if (request.method === "PUT" && put) {
    const b = await body(request);
    return b ? { id: decodeURIComponent(put[1]), data: b } : null;
  }
  const approve = /^\/submissions\/([^/]+)\/approve$/.exec(p);
  if (request.method === "POST" && approve) {
    const s = sqlite.prepare("SELECT action, template_id, data FROM submissions WHERE id = ?").get(decodeURIComponent(approve[1])) as
      | { action: string; template_id: string | null; data: string }
      | undefined;
    if (!s) return null;
    const b = await body(request);
    let data: Obj;
    try {
      data = (b?.data && typeof b.data === "object" ? b.data : JSON.parse(s.data)) as Obj;
    } catch {
      return null;
    }
    return { id: s.action === "update" ? s.template_id : null, data };
  }
  return null;
}

export interface DuplicateConflict {
  error: string;
  duplicateOf: { id: string; label: string };
  /** The library workspace with that template open. */
  link: string;
}

/** The 409 answer for a request that would create a duplicate, or null. */
export async function duplicateConflict(sqlite: Database.Database, request: Request): Promise<DuplicateConflict | null> {
  const plan = await planned(sqlite, request);
  if (!plan) return null;
  const man = str(plan.data.manufacturer);
  const pn = str(plan.data.modelNumber);
  if (!man.trim() || !pn.trim()) return null;
  if (plan.id) {
    // An update keeps its identity: only a changed manufacturer or part number is checked.
    const cur = sqlite.prepare("SELECT manufacturer, model_number FROM templates WHERE id = ?").get(plan.id) as
      | { manufacturer: string | null; model_number: string | null }
      | undefined;
    if (cur && str(cur.manufacturer).trim().toLowerCase() === man.trim().toLowerCase() && str(cur.model_number).trim().toLowerCase() === pn.trim().toLowerCase()) {
      return null;
    }
  }
  const variant = plan.data._avail && typeof plan.data._avail === "object" ? str((plan.data._avail as Obj).variant) : str(plan.data.variant);
  const dup = findDuplicate({ id: plan.id, label: str(plan.data.label), manufacturer: man, modelNumber: pn, variant: variant || null }, loadCandidates(sqlite), loadNotDuplicates(sqlite));
  if (!dup) return null;
  return {
    error: `A template for ${man} ${pn} already exists: ${dup.label}. Edit that one, or mark this one as a variant.`,
    duplicateOf: dup,
    link: `/library?template=${encodeURIComponent(dup.id)}`,
  };
}
