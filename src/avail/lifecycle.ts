/**
 * Product lifecycle of a template (AVAIL): upcoming (announced, not shipping yet; `availableFrom`,
 * e.g. "2027-Q3"), active (the default) or eol (end of life; `eolDate`, optional).
 *
 * Where it lives: the catalog card's `_avail.lifecycle` / `availableFrom` / `eolDate`
 * (library/catalog), the intake form's Lifecycle and Lifecycle date columns, and in the database
 * avail_template_meta.lifecycle / available_from / eol_date (migration 9012). The library
 * (GET /templates) carries it as `availLifecycle`, the workspace as `avail.lifecycle`.
 *
 * The linter (blockLint.ts) reads `_avail.lifecycle` of a block: values estimated from an analog
 * ("estimated from …" in notes) are a warning, except for an upcoming product, which has no
 * manufacturer document yet.
 *
 * Pure functions, no browser or Node dependencies.
 */

export const LIFECYCLES = ["upcoming", "active", "eol"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export interface LifecycleInfo {
  lifecycle: Lifecycle;
  /** Upcoming only: when it ships, "2027-Q3", "2027-09", "2027-09-15" or "2027". */
  availableFrom?: string;
  /** EoL only (optional): when it went or goes end of life, same formats. */
  eolDate?: string;
}

export const ACTIVE: LifecycleInfo = { lifecycle: "active" };

/** One whole label per state (ready for a translation table). */
export const LIFECYCLE_LABELS: Readonly<Record<Lifecycle, string>> = { upcoming: "Upcoming", active: "Active", eol: "EoL" };

export function isLifecycle(v: unknown): v is Lifecycle {
  return typeof v === "string" && (LIFECYCLES as readonly string[]).includes(v);
}

/** "2027", "2027-Q3", "2027-09", "2027-09-15". */
const DATE_RE = /^\d{4}(?:-Q[1-4]|-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;

export function isLifecycleDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v);
}

/** A date as typed ("2027 q3", " 2027-q3 ") in the stored form ("2027-Q3"); unchanged when it is not one. */
export function normalizeLifecycleDate(v: string): string {
  const t = v.trim().replace(/\s+/g, "-").replace(/-q([1-4])$/i, "-Q$1");
  return t;
}

/**
 * Lifecycle of anything that carries it: `{lifecycle, availableFrom, eolDate}` (catalog `_avail`,
 * workspace info, availLifecycle of the library). Missing or unknown → active; a date that does not
 * belong to the state is dropped.
 */
export function lifecycleOf(v: unknown): LifecycleInfo {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const lifecycle = isLifecycle(o.lifecycle) ? o.lifecycle : "active";
  if (lifecycle === "upcoming" && isLifecycleDate(o.availableFrom)) return { lifecycle, availableFrom: o.availableFrom };
  if (lifecycle === "eol" && isLifecycleDate(o.eolDate)) return { lifecycle, eolDate: o.eolDate };
  return { lifecycle };
}

/** Same lifecycle (state and its date). */
export function sameLifecycle(a: LifecycleInfo, b: LifecycleInfo): boolean {
  return a.lifecycle === b.lifecycle && (a.availableFrom ?? "") === (b.availableFrom ?? "") && (a.eolDate ?? "") === (b.eolDate ?? "");
}

/**
 * Checks a lifecycle someone asks to set (bulk action, API): the state, and the date that goes with
 * it in a known format. Returns the clean value or the reason it is refused.
 */
export function parseLifecycleInput(v: unknown): { ok: true; value: LifecycleInfo } | { ok: false; error: string } {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  if (!isLifecycle(o.lifecycle)) return { ok: false, error: `lifecycle must be one of ${LIFECYCLES.join(", ")}` };
  const date = (k: "availableFrom" | "eolDate") => {
    const x = o[k];
    if (x === undefined || x === null || x === "") return { ok: true as const, value: undefined };
    if (typeof x !== "string" || !isLifecycleDate(normalizeLifecycleDate(x))) {
      return { ok: false as const, error: `${k} must be a year, quarter, month or day: 2027, 2027-Q3, 2027-09 or 2027-09-15` };
    }
    return { ok: true as const, value: normalizeLifecycleDate(x) };
  };
  if (o.lifecycle === "upcoming") {
    const d = date("availableFrom");
    if (!d.ok) return d;
    if (o.eolDate) return { ok: false, error: "eolDate is only for eol" };
    return { ok: true, value: { lifecycle: "upcoming", ...(d.value ? { availableFrom: d.value } : {}) } };
  }
  if (o.lifecycle === "eol") {
    const d = date("eolDate");
    if (!d.ok) return d;
    if (o.availableFrom) return { ok: false, error: "availableFrom is only for upcoming" };
    return { ok: true, value: { lifecycle: "eol", ...(d.value ? { eolDate: d.value } : {}) } };
  }
  if (o.availableFrom || o.eolDate) return { ok: false, error: "active takes no date" };
  return { ok: true, value: { lifecycle: "active" } };
}

/** Badge of a template or block: "Upcoming · 2027-Q3", "Upcoming", "EoL"; null for active. */
export function lifecycleBadge(v: LifecycleInfo | null | undefined): string | null {
  if (!v || v.lifecycle === "active") return null;
  if (v.lifecycle === "upcoming") return v.availableFrom ? `Upcoming · ${v.availableFrom}` : "Upcoming";
  return "EoL";
}

/** Short text with the date (the workspace column): "Upcoming · 2027-Q3", "EoL · 2026-06", "Active". */
export function lifecycleShort(v: LifecycleInfo | null | undefined): string {
  if (!v || v.lifecycle === "active") return "Active";
  const date = v.lifecycle === "upcoming" ? v.availableFrom : v.eolDate;
  return date ? `${LIFECYCLE_LABELS[v.lifecycle]} · ${date}` : LIFECYCLE_LABELS[v.lifecycle];
}

/** Longer text (tooltips, the workspace column, reports): "Upcoming, available from 2027-Q3", "EoL since 2026-06". */
export function lifecycleText(v: LifecycleInfo | null | undefined): string {
  if (!v || v.lifecycle === "active") return "Active";
  if (v.lifecycle === "upcoming") return v.availableFrom ? `Upcoming, available from ${v.availableFrom}` : "Upcoming";
  return v.eolDate ? `EoL since ${v.eolDate}` : "EoL";
}

/** Stored columns (avail_template_meta) of a lifecycle. */
export function lifecycleColumns(v: LifecycleInfo): { lifecycle: Lifecycle; available_from: string | null; eol_date: string | null } {
  return { lifecycle: v.lifecycle, available_from: v.availableFrom ?? null, eol_date: v.eolDate ?? null };
}

/** Lifecycle of stored columns. */
export function lifecycleOfColumns(r: { lifecycle?: string | null; available_from?: string | null; eol_date?: string | null }): LifecycleInfo {
  return lifecycleOf({ lifecycle: r.lifecycle, availableFrom: r.available_from, eolDate: r.eol_date });
}

/**
 * The block as the linter must see it: its lifecycle in `_avail` (what blockLint reads), so values
 * "estimated from …" of an upcoming product do not lower its level. Active: the block unchanged.
 */
export function withLifecycle<T extends object>(block: T, lc: LifecycleInfo): T {
  if (lc.lifecycle === "active") return block;
  const avail = (block as { _avail?: unknown })._avail;
  return { ...block, _avail: { ...(avail && typeof avail === "object" ? avail : {}), ...lc } };
}

/**
 * The lifecycle a block carries itself: `_avail` (catalog card), `availLifecycle` (library, MCP raw)
 * or `avail` (workspace); null when it carries none.
 */
export function carriedLifecycle(block: object): LifecycleInfo | null {
  const b = block as { _avail?: { lifecycle?: unknown }; availLifecycle?: unknown; avail?: { lifecycle?: unknown } };
  if (b._avail && isLifecycle(b._avail.lifecycle)) return lifecycleOf(b._avail);
  if (b.availLifecycle && typeof b.availLifecycle === "object") return lifecycleOf(b.availLifecycle);
  if (b.avail && isLifecycle(b.avail.lifecycle)) return lifecycleOf(b.avail);
  return null;
}

// ---------------------------------------------------------------------------- estimates (linter)

/** "estimated from DTP3 T 202" in notes: a value taken from an analog product. */
export const ESTIMATED_FROM_RE = /\bestimated from\b/i;

// ---------------------------------------------------------------------------- intake form

/** Lifecycle column values of the intake form (Lists sheet) → state. */
export const INTAKE_LIFECYCLES: Readonly<Record<string, Lifecycle>> = { Active: "active", Upcoming: "upcoming", EoL: "eol" };

// ---------------------------------------------------------------------------- schematic

export interface LifecycleBlock {
  nodeId: string;
  label: string;
  lifecycle: LifecycleInfo;
}

/** Device blocks of a schematic whose template is upcoming or EoL (for the reports' warning). */
export function lifecycleBlocks(
  nodes: readonly { id: string; type?: string; data: unknown }[],
  lifecycleOfTemplate: (templateId: string | undefined) => LifecycleInfo | null,
): LifecycleBlock[] {
  const out: LifecycleBlock[] = [];
  for (const n of nodes) {
    if (n.type !== "device") continue;
    const d = n.data as { templateId?: string; label?: string };
    const lc = lifecycleOfTemplate(d.templateId);
    if (lc && lc.lifecycle !== "active") out.push({ nodeId: n.id, label: d.label ?? n.id, lifecycle: lc });
  }
  return out;
}
