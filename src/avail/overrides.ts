/**
 * Overrides: decided values of a template that imports must not lose (step 2.7).
 *
 * An accepted proposal (library workspace → Proposals → Accept, or POST /submissions/:id/approve)
 * records every field and port it changed as an override; the port decisions of AVAIL engineers
 * (formerly docs/avail/port-decisions.json) are overrides too. import:catalog, fill:catalog-ports and
 * normalize:library apply them over the catalog and the database, so a catalog file or a port copied
 * again from the database does not undo a decision. When the catalog file itself changes an
 * overridden field, the override stays and the import reports it (overrideConflicts).
 *
 * Kinds:
 *   field — a top-level template field (label, powerDrawW, slots…): value replaces it, null removes it;
 *   port  — one port, by its label as it was (or its id): op "set" replaces the listed port fields
 *           (null removes a field), "add" adds the port when the template has none with that label,
 *           "remove" drops it.
 * `base` is what the field or the port fields were before the decision (absent = unknown): the catalog
 * "changed" an overridden value when it is neither the base nor the override.
 *
 * Stored in the database (avail_overrides, api-avail/src/overrides.ts) and in the repository
 * (docs/avail/overrides.json, written by export:overrides). Pure, no Node or browser dependencies.
 */
import { manufacturerKey, partKey } from "./duplicates";
import { BLOCK_SECTIONS, sectionBase } from "./sections";

type Obj = Record<string, unknown>;

export type OverrideKind = "field" | "port";
export type PortOp = "set" | "add" | "remove";

export interface Override {
  /** Row id in avail_overrides (absent for an override only in the file). */
  id?: number;
  /** Template it was decided on; with manufacturer + modelNumber and label it matches copies too. */
  templateId?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  /** Template label ("Extron UCS 303"). */
  label?: string | null;
  kind: OverrideKind;
  /** kind field: the template field. */
  field?: string;
  /** kind port: the port's label as it was. */
  port?: string;
  portId?: string | null;
  /** kind port: set (default), add or remove. */
  op?: PortOp;
  value: unknown;
  base?: unknown;
  /** "proposal <id>" or "port decision". */
  source: string;
  /** Why, with the source document (the proposal's comment, the engineers' decision). */
  comment: string;
  acceptedBy: string;
  acceptedAt?: string;
}

export interface OverridesFile {
  about?: string;
  overrides: Override[];
}

/** Fields an override never covers: identity and bookkeeping. */
export const NOT_OVERRIDDEN = new Set(["id", "version", "flaggedForDeletion", "sortOrder", "submittedBy", "createdAt", "updatedAt"]);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const low = (v: unknown) => str(v).trim().replace(/\s+/g, " ").toLowerCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const hasBase = (o: Override) => o.base !== undefined;

/** "field powerDrawW", "port HDMI In" — what an override is about. */
export function overrideTarget(o: Pick<Override, "kind" | "field" | "port" | "op">): string {
  return o.kind === "field" ? `field ${o.field}` : `port ${o.port}`;
}

/** The text of an override for a list or a report: 'port "HDMI In": connectorType = "hdmi"'. */
export function describeOverride(o: Override): string {
  if (o.kind === "field") return o.value === null ? `${o.field}: removed` : `${o.field} = ${JSON.stringify(o.value)}`;
  const op = o.op ?? "set";
  if (op === "add") return `port "${o.port}": added`;
  if (op === "remove") return `port "${o.port}": removed`;
  const fields = Object.entries((o.value ?? {}) as Obj).map(([k, v]) => (v === null ? `${k} removed` : `${k} = ${JSON.stringify(v)}`));
  return `port "${o.port}": ${fields.join(", ")}`;
}

/** Whether the override was decided on this template (by id, manufacturer + part number, or label). */
export function overrideMatches(o: Override, block: Obj): boolean {
  if (o.templateId && o.templateId === block.id) return true;
  const man = o.manufacturer ? manufacturerKey(o.manufacturer) : "";
  if (man && man !== manufacturerKey(str(block.manufacturer))) return false;
  const pk = o.modelNumber ? partKey(o.modelNumber) : "";
  if (pk && pk === partKey(str(block.modelNumber))) return true;
  return !!o.label && low(o.label) === low(block.label);
}

/** The overrides of this template. */
export function overridesFor(block: Obj, list: readonly Override[]): Override[] {
  return list.filter((o) => overrideMatches(o, block));
}

/** Same override (same source, what, and template): the database row of a file entry. */
export function sameOverride(a: Override, b: Override): boolean {
  if (a.source !== b.source || a.kind !== b.kind || overrideTarget(a) !== overrideTarget(b)) return false;
  if (a.templateId && b.templateId && a.templateId === b.templateId) return true;
  const ident = (o: Override) => ({ templateId: o.templateId ?? undefined, manufacturer: o.manufacturer ?? undefined, modelNumber: o.modelNumber ?? undefined, label: o.label ?? undefined });
  return overrideMatches(a, ident(b)) || overrideMatches(b, ident(a));
}

/**
 * The overrides in force: the database's active ones, plus the file's entries the database does
 * not know (an entry removed in the workspace has a removed row there, so it stays out).
 */
export function mergeOverrides(db: readonly (Override & { removed?: boolean })[], file: readonly Override[]): Override[] {
  const active = db.filter((o) => !o.removed);
  return [...active, ...file.filter((f) => !db.some((d) => sameOverride(d, f)))];
}

type Port = Obj;

function findPort(ports: readonly Port[], o: Override): number {
  if (o.portId) {
    const i = ports.findIndex((p) => p && p.id === o.portId);
    if (i >= 0) return i;
  }
  const names = [low(o.port)];
  const v = o.value as Obj | null;
  if ((o.op ?? "set") !== "remove" && v && typeof v === "object" && typeof v.label === "string") names.push(low(v.label));
  return ports.findIndex((p) => p && names.includes(low(p.label)));
}

export interface OverrideChange {
  /** "powerDrawW", 'ports["HDMI In"].connectorType', 'ports["HDMI In"]' (added / removed). */
  field: string;
  from: unknown;
  to: unknown;
  override: Override;
}

const portPath = (o: Override, k?: string) => `ports[${JSON.stringify(o.port ?? "")}]${k ? `.${k}` : ""}`;

/**
 * Applies the overrides of this template to a copy of it. `missed` — port overrides whose port the
 * template does not have (set / remove): nothing to apply, listed in reports.
 */
export function applyOverrides<T extends object>(input: T, list: readonly Override[]): { block: T; changes: OverrideChange[]; missed: Override[] } {
  const block = input as unknown as Obj;
  const mine = overridesFor(block, list);
  const changes: OverrideChange[] = [];
  const missed: Override[] = [];
  if (!mine.length) return { block: input, changes, missed };
  const out: Obj = { ...block };
  let ports: Port[] | null = Array.isArray(block.ports) ? [...(block.ports as Port[])] : null;
  let addedOrMoved = false;
  for (const o of mine) {
    if (o.kind === "field") {
      if (!o.field || NOT_OVERRIDDEN.has(o.field) || o.field === "ports") continue;
      if (same(out[o.field], o.value)) continue;
      changes.push({ field: o.field, from: out[o.field] ?? null, to: o.value, override: o });
      if (o.value === null) delete out[o.field];
      else out[o.field] = structuredClone(o.value);
      continue;
    }
    ports ??= [];
    const i = findPort(ports, o);
    const op = o.op ?? "set";
    if (op === "remove") {
      if (i < 0) continue;
      changes.push({ field: portPath(o), from: ports[i], to: null, override: o });
      ports.splice(i, 1);
      continue;
    }
    if (op === "add" && i < 0) {
      changes.push({ field: portPath(o), from: null, to: o.value, override: o });
      ports.push(structuredClone(o.value) as Port);
      addedOrMoved = true;
      continue;
    }
    if (i < 0) {
      missed.push(o);
      continue;
    }
    const want = o.value as Obj;
    const next: Port = { ...ports[i] };
    for (const [k, v] of Object.entries(want ?? {})) {
      if (k === "id" && op === "add") continue;
      if (same(next[k], v)) continue;
      changes.push({ field: portPath(o, k), from: next[k] ?? null, to: v, override: o });
      if (v === null) delete next[k];
      else next[k] = structuredClone(v);
      if (k === "section") addedOrMoved = true;
    }
    ports[i] = next;
  }
  if (!changes.length) return { block: input, changes, missed };
  if (ports) out.ports = addedOrMoved ? inSectionOrder(ports) : ports;
  return { block: out as T, changes, missed };
}

/**
 * Ports with a vocabulary section put in the standard's section order (stable); the others (slot
 * ports, unknown sections) keep their places — what the linter's order check reads.
 */
export function inSectionOrder<P extends Obj>(ports: P[]): P[] {
  const rank = (p: P) => (BLOCK_SECTIONS as readonly string[]).indexOf(sectionBase(str(p?.section)));
  const at = ports.map((p, i) => (rank(p) >= 0 && !str(p?.section).startsWith("Slot") ? i : -1)).filter((i) => i >= 0);
  const sorted = at.map((i) => ports[i]).map((p, k) => ({ p, k })).sort((a, b) => rank(a.p) - rank(b.p) || a.k - b.k).map((x) => x.p);
  const out = [...ports];
  at.forEach((i, k) => (out[i] = sorted[k]));
  return out;
}

export interface OverrideConflict {
  override: Override;
  /** "powerDrawW", 'ports["HDMI In"].connectorType'. */
  field: string;
  /** What the catalog (the incoming data) has. */
  catalog: unknown;
  /** What the override keeps. */
  kept: unknown;
}

/**
 * Where the incoming data (a catalog file) changed what an override decides: neither the value
 * before the decision (base) nor the override. Without a base, any difference counts.
 */
export function overrideConflicts(incoming: object, list: readonly Override[]): OverrideConflict[] {
  const block = incoming as Obj;
  const out: OverrideConflict[] = [];
  const ports = Array.isArray(block.ports) ? (block.ports as Port[]) : [];
  for (const o of overridesFor(block, list)) {
    if (o.kind === "field") {
      if (!o.field) continue;
      const cur = block[o.field];
      if (same(cur, o.value) || (hasBase(o) && same(cur, o.base))) continue;
      out.push({ override: o, field: o.field, catalog: cur ?? null, kept: o.value });
      continue;
    }
    const i = findPort(ports, o);
    const op = o.op ?? "set";
    if (op === "remove") {
      if (i < 0 || !hasBase(o) || same(ports[i], o.base)) continue;
      out.push({ override: o, field: portPath(o), catalog: ports[i], kept: null });
      continue;
    }
    if (i < 0) continue;
    const want = (o.value ?? {}) as Obj;
    const base = (hasBase(o) ? o.base : undefined) as Obj | null | undefined;
    for (const [k, v] of Object.entries(want)) {
      if (k === "id") continue;
      const cur = ports[i][k];
      if (same(cur, v)) continue;
      if (op === "set" && base && typeof base === "object" && same(cur, base[k])) continue;
      out.push({ override: o, field: portPath(o, k), catalog: cur ?? null, kept: v });
    }
  }
  return out;
}

/** 'catalog changed a field overridden by proposal 12: powerDrawW — catalog 30, kept 25'. */
export function describeConflict(c: OverrideConflict): string {
  return `catalog changed a field overridden by ${c.override.source}: ${c.field} — catalog ${JSON.stringify(c.catalog)}, kept ${JSON.stringify(c.kept)}`;
}

/**
 * The overrides an accepted proposal makes: every top-level field and every port that differs
 * between the template before and after. Ports pair by id, else by label.
 */
export function overridesFromChange(
  before: object,
  after: object,
  meta: Pick<Override, "source" | "comment" | "acceptedBy"> & { acceptedAt?: string },
): Override[] {
  const b = before as Obj;
  const a = after as Obj;
  const who = {
    templateId: str(a.id) || str(b.id) || null,
    manufacturer: str(a.manufacturer) || str(b.manufacturer) || null,
    modelNumber: str(a.modelNumber) || str(b.modelNumber) || null,
    label: str(a.label) || str(b.label) || null,
    ...meta,
  };
  const out: Override[] = [];
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !NOT_OVERRIDDEN.has(k) && k !== "ports").sort();
  for (const k of keys) {
    if (same(b[k], a[k])) continue;
    out.push({ ...who, kind: "field", field: k, value: a[k] ?? null, base: b[k] ?? null });
  }
  const bp = Array.isArray(b.ports) ? (b.ports as Port[]) : [];
  const ap = Array.isArray(a.ports) ? (a.ports as Port[]) : [];
  const used = new Set<number>();
  const pair = (p: Port) => {
    let j = p.id != null ? bp.findIndex((q, n) => !used.has(n) && q.id === p.id) : -1;
    if (j < 0) j = bp.findIndex((q, n) => !used.has(n) && low(q.label) === low(p.label));
    if (j >= 0) used.add(j);
    return j;
  };
  for (const p of ap) {
    const j = pair(p);
    if (j < 0) {
      out.push({ ...who, kind: "port", port: str(p.label), portId: str(p.id) || null, op: "add", value: p });
      continue;
    }
    const q = bp[j];
    const value: Obj = {};
    const base: Obj = {};
    for (const k of [...new Set([...Object.keys(q), ...Object.keys(p)])].sort()) {
      if (k === "id" || same(q[k], p[k])) continue;
      value[k] = p[k] ?? null;
      base[k] = q[k] ?? null;
    }
    if (Object.keys(value).length) out.push({ ...who, kind: "port", port: str(q.label), portId: str(q.id) || null, op: "set", value, base });
  }
  bp.forEach((q, j) => {
    if (!used.has(j)) out.push({ ...who, kind: "port", port: str(q.label), portId: str(q.id) || null, op: "remove", value: null, base: q });
  });
  return out;
}

/**
 * A new override replacing an older one on the same thing: port "set" overrides merge their fields
 * (the newer value wins, the older base stays — it is what the catalog had).
 */
export function combineOverrides(older: Override, newer: Override): Override {
  if (older.kind !== "port" || newer.kind !== "port" || (older.op ?? "set") !== "set" || (newer.op ?? "set") !== "set") return newer;
  const base = { ...((newer.base ?? {}) as Obj), ...((older.base ?? {}) as Obj) };
  return { ...newer, value: { ...((older.value ?? {}) as Obj), ...((newer.value ?? {}) as Obj) }, ...(hasBase(older) || hasBase(newer) ? { base } : {}) };
}
