/**
 * Partial edits of a template (step 2.6, MCP propose_change) and what an edit really changes.
 *
 *   storedForm(t)            the template as the library stores it: no id / version / workspace or
 *                            API extras (avail, lastEditedBy…), no empty values (null, "", [] — the
 *                            database keeps none of them), ports likewise
 *   applyTemplatePatch(t, p) a patch over the current template: top-level fields (null removes one);
 *                            `ports: { update: [{id, …fields}], add: [port], remove: [id] }` by port id;
 *                            everything else stays as it is
 *   editChanges(a, b)        the fields and ports that differ between two templates in stored form
 *
 * Pure, no Node or browser dependencies (API, MCP and the library workspace).
 */

type Obj = Record<string, unknown>;

/**
 * Keys that are not template data: identity, version, what the API and the workspace add. The
 * lifecycle (availLifecycle) is set with Set lifecycle, not by an edit of the template.
 */
const NOT_DATA = new Set([
  "id", "version", "avail", "lastEditedBy", "submittedBy", "createdAt", "updatedAt", "availStatus", "availLevel", "availPortsOrigin", "availLifecycle",
]);

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function clean(o: Obj, skip: ReadonlySet<string>, top = false): Obj {
  const out: Obj = {};
  // At the top level false is not stored either (isVenueProvided is kept only when true).
  for (const [k, v] of Object.entries(o)) if (!skip.has(k) && !isEmpty(v) && !(top && v === false)) out[k] = v;
  return out;
}

const NONE = new Set<string>();

/** The template as stored: data fields only, no empty values; ports without empty fields. */
export function storedForm(t: object): Obj {
  const out = clean(t as Obj, NOT_DATA, true);
  out.ports = (Array.isArray((t as Obj).ports) ? ((t as Obj).ports as unknown[]) : []).map((p) => (p && typeof p === "object" ? clean(p as Obj, NONE) : p));
  return out;
}

const json = (v: unknown) => JSON.stringify(v ?? null);
/** Equal as stored (key order of objects does not count). */
function same(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as Obj).sort();
    const kb = Object.keys(b as Obj).sort();
    return json(ka) === json(kb) && ka.every((k) => same((a as Obj)[k], (b as Obj)[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return json(a) === json(b);
}

export interface PortsPatch {
  /** Ports to change, by id: the listed fields replace the port's (null removes a field). */
  update?: Obj[];
  /** New ports (an id is required, unique in the template). */
  add?: Obj[];
  /** Ids of ports to remove. */
  remove?: string[];
}

/** Applies a patch to a copy of the template; an error names what does not fit. */
export function applyTemplatePatch(current: object, patch: Obj): { template: Obj } | { error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "patch must be an object of fields" };
  const t: Obj = structuredClone(storedForm(current));
  for (const [k, v] of Object.entries(patch)) {
    if (k === "ports") continue;
    if (NOT_DATA.has(k)) return { error: `patch cannot change ${k}` };
    if (v === null) delete t[k];
    else t[k] = structuredClone(v);
  }
  if (patch.ports === undefined) return { template: storedForm(t) };
  const pp = patch.ports as PortsPatch;
  if (!pp || typeof pp !== "object" || Array.isArray(pp)) return { error: "patch.ports must be { update, add, remove }" };
  for (const k of Object.keys(pp)) if (!["update", "add", "remove"].includes(k)) return { error: `patch.ports.${k}: use update, add or remove` };
  let ports = (t.ports as Obj[]).map((p) => ({ ...p }));
  const idOf = (p: Obj) => (typeof p.id === "string" ? p.id : "");
  const labelOf = (p: Obj) => (typeof p._label === "string" ? p._label : "");
  for (const id of pp.remove ?? []) {
    const match = (p: Obj) => (id.startsWith("label:") ? !idOf(p) && p.label === id.slice(6) : idOf(p) === id);
    if (!ports.some(match)) return { error: `patch.ports.remove: no port with id "${id}"` };
    ports = ports.filter((p) => !match(p));
  }
  for (const u of pp.update ?? []) {
    const id = u && typeof u === "object" ? idOf(u) : "";
    const lbl = !id && u && typeof u === "object" ? labelOf(u) : "";
    const i = id ? ports.findIndex((p) => idOf(p) === id) : lbl ? ports.findIndex((p) => !idOf(p) && p.label === lbl) : -1;
    if (i < 0) return { error: `patch.ports.update: no port with id "${id}" (get_template lists the ids in raw.ports)` };
    const next = { ...ports[i] };
    for (const [k, v] of Object.entries(u)) {
      if (k === "id" || k === "_label") continue;
      if (v === null) delete next[k];
      else next[k] = structuredClone(v);
    }
    ports[i] = next;
  }
  for (const a of pp.add ?? []) {
    const id = a && typeof a === "object" ? idOf(a) : "";
    if (!id) return { error: "patch.ports.add: every new port needs an id" };
    if (ports.some((p) => idOf(p) === id)) return { error: `patch.ports.add: a port with id "${id}" exists; use update` };
    ports.push(structuredClone(a));
  }
  t.ports = ports;
  return { template: storedForm(t) };
}

export interface EditChanges {
  /** Top-level fields that differ (ports excluded). */
  fields: string[];
  /** Ports by id (else label): added, removed, changed with the fields that differ. */
  ports: { added: string[]; removed: string[]; changed: { port: string; fields: string[] }[] };
}

/** What really differs between two templates, both in stored form. */
export function editChanges(before: object, after: object): EditChanges {
  const b = storedForm(before);
  const a = storedForm(after);
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "ports" && !same(b[k], a[k])).sort();
  const bp = b.ports as Obj[];
  const ap = a.ports as Obj[];
  const name = (p: Obj) => String(p.label ?? p.id ?? "?");
  const used = new Set<number>();
  const pair = (p: Obj) => {
    let j = p.id !== undefined ? bp.findIndex((q, n) => !used.has(n) && q.id === p.id) : -1;
    if (j < 0) j = bp.findIndex((q, n) => !used.has(n) && q.label === p.label && (q.id === undefined || p.id === undefined));
    if (j >= 0) used.add(j);
    return j;
  };
  const out: EditChanges = { fields, ports: { added: [], removed: [], changed: [] } };
  for (const p of ap) {
    const j = pair(p);
    if (j < 0) {
      out.ports.added.push(name(p));
      continue;
    }
    const q = bp[j];
    const diff = [...new Set([...Object.keys(q), ...Object.keys(p)])].filter((k) => !same(q[k], p[k])).sort();
    if (diff.length) out.ports.changed.push({ port: name(q), fields: diff });
  }
  bp.forEach((q, j) => {
    if (!used.has(j)) out.ports.removed.push(name(q));
  });
  return out;
}

export function noChanges(c: EditChanges): boolean {
  return !c.fields.length && !c.ports.added.length && !c.ports.removed.length && !c.ports.changed.length;
}

/** One line per change, for answers and the audit log: 'thermalBtuh', 'port "HDMI In": notes', 'port "X" added'. */
export function describeEditChanges(c: EditChanges): string[] {
  return [
    ...c.fields,
    ...c.ports.changed.map((x) => `port "${x.port}": ${x.fields.join(", ")}`),
    ...c.ports.added.map((x) => `port "${x}" added`),
    ...c.ports.removed.map((x) => `port "${x}" removed`),
  ];
}

/** The refusal of a proposal that changes nothing (API and MCP). */
export const NO_CHANGE_ERROR = "The proposal changes nothing: it matches the current template. Change at least one field or port.";

// ---------------------------------------------------------------------------- proposals as patches

export interface TemplatePatch extends Obj {
  ports?: PortsPatch;
}

const portKey = (p: Obj) => (typeof p.id === "string" && p.id ? p.id : `label:${String(p.label ?? "")}`);
const findPortByKey = (ports: Obj[], key: string) => ports.findIndex((p) => portKey(p) === key);

/**
 * The patch that turns `before` into `after` (both in stored form): changed top-level fields (null
 * removes one), ports by id — changed fields, added and removed ports. What a proposal stores.
 */
export function patchFromEdit(before: object, after: object): TemplatePatch {
  const b = storedForm(before);
  const a = storedForm(after);
  const patch: TemplatePatch = {};
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (k === "ports" || same(b[k], a[k])) continue;
    patch[k] = a[k] === undefined ? null : structuredClone(a[k]);
  }
  const bp = b.ports as Obj[];
  const ap = a.ports as Obj[];
  const used = new Set<number>();
  const update: Obj[] = [];
  const add: Obj[] = [];
  for (const p of ap) {
    let j = bp.findIndex((q, n) => !used.has(n) && portKey(q) === portKey(p));
    if (j < 0 && !p.id) j = bp.findIndex((q, n) => !used.has(n) && q.label === p.label);
    if (j < 0) {
      add.push(structuredClone(p));
      continue;
    }
    used.add(j);
    const q = bp[j];
    const fields: Obj = {};
    for (const k of [...new Set([...Object.keys(q), ...Object.keys(p)])]) {
      if (k === "id" || same(q[k], p[k])) continue;
      fields[k] = p[k] === undefined ? null : structuredClone(p[k]);
    }
    if (Object.keys(fields).length) update.push(q.id ? { id: q.id, ...fields } : { _label: q.label, ...fields });
  }
  const remove = bp.filter((_, j) => !used.has(j)).map(portKey);
  if (update.length || add.length || remove.length) {
    patch.ports = { ...(update.length ? { update } : {}), ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  }
  return patch;
}

export function patchIsEmpty(p: TemplatePatch): boolean {
  const { ports, ...fields } = p;
  return !Object.keys(fields).length && !(ports?.update?.length || ports?.add?.length || ports?.remove?.length);
}

/** One spot where the template changed since the proposal was made, and the proposal changes it too. */
export interface PatchConflict {
  /** "field:voltage", "port:p3:notes", "port:p3". */
  key: string;
  /** What it is about: 'voltage', 'port "HDMI In": notes', 'port "HDMI In"'. */
  label: string;
  /** At the proposal's creation, now, what the proposal sets (null: absent / removed). */
  base: unknown;
  current: unknown;
  proposed: unknown;
}

export type Resolution = "current" | "proposed";

const updKey = (u: Obj) => (typeof u.id === "string" && u.id ? u.id : `label:${String(u._label ?? "")}`);
const portName = (p: Obj | undefined, key: string) => String(p?.label ?? key.replace(/^label:/, ""));

/**
 * Three-way check of a patch built on `base` against the template as it is now: a field or port the
 * patch changes that has changed since (and not to the proposed value) is a conflict.
 */
export function patchConflicts(baseRaw: object, currentRaw: object, patch: TemplatePatch): PatchConflict[] {
  const base = storedForm(baseRaw);
  const cur = storedForm(currentRaw);
  const out: PatchConflict[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "ports") continue;
    if (same(cur[k], base[k]) || same(cur[k], v)) continue;
    out.push({ key: `field:${k}`, label: k, base: base[k] ?? null, current: cur[k] ?? null, proposed: v });
  }
  const bp = base.ports as Obj[];
  const cp = cur.ports as Obj[];
  const pp = patch.ports ?? {};
  for (const u of pp.update ?? []) {
    const key = updKey(u);
    const b = bp[findPortByKey(bp, key)];
    const c = cp[findPortByKey(cp, key)];
    const name = portName(b ?? c, key);
    if (!c) {
      out.push({ key: `port:${key}`, label: `port "${name}"`, base: b ?? null, current: null, proposed: { ...(b ?? {}), ...stripMeta(u) } });
      continue;
    }
    for (const [f, v] of Object.entries(stripMeta(u))) {
      if (same(c[f], b?.[f]) || same(c[f], v)) continue;
      out.push({ key: `port:${key}:${f}`, label: `port "${name}": ${f}`, base: b?.[f] ?? null, current: c[f] ?? null, proposed: v });
    }
  }
  for (const a of pp.add ?? []) {
    const key = portKey(a);
    const c = cp[findPortByKey(cp, key)];
    if (c && !same(storedForm({ ports: [c] }).ports, storedForm({ ports: [a] }).ports)) {
      out.push({ key: `port:${key}`, label: `port "${portName(a, key)}" (added)`, base: null, current: c, proposed: a });
    }
  }
  for (const key of pp.remove ?? []) {
    const b = bp[findPortByKey(bp, key)];
    const c = cp[findPortByKey(cp, key)];
    if (c && b && !same(c, b)) out.push({ key: `port:${key}`, label: `port "${portName(b, key)}" (removed)`, base: b, current: c, proposed: null });
  }
  return out;
}

function stripMeta(u: Obj): Obj {
  const { id: _i, _label: _l, ...rest } = u;
  return rest;
}

/**
 * The template after accepting a patch: the patch over the template as it is now; a conflict takes
 * the chosen side (default: the proposal's value).
 */
export function applyPatchResolved(currentRaw: object, baseRaw: object, patch: TemplatePatch, resolutions: Readonly<Record<string, Resolution>> = {}): Obj {
  const keep = (key: string) => resolutions[key] === "current";
  const t: Obj = structuredClone(storedForm(currentRaw));
  const base = storedForm(baseRaw);
  for (const [k, v] of Object.entries(patch)) {
    if (k === "ports" || keep(`field:${k}`)) continue;
    if (v === null) delete t[k];
    else t[k] = structuredClone(v);
  }
  let ports = (t.ports as Obj[]).map((p) => ({ ...p }));
  const bp = base.ports as Obj[];
  const pp = patch.ports ?? {};
  for (const key of pp.remove ?? []) {
    if (keep(`port:${key}`)) continue;
    ports = ports.filter((p) => portKey(p) !== key);
  }
  for (const u of pp.update ?? []) {
    const key = updKey(u);
    let i = findPortByKey(ports, key);
    if (i < 0) {
      // Gone since: put back (base port + the proposal's fields) unless the current state is kept.
      if (keep(`port:${key}`)) continue;
      const b = bp[findPortByKey(bp, key)];
      if (!b) continue;
      ports.push({ ...b });
      i = ports.length - 1;
    }
    const next = { ...ports[i] };
    for (const [f, v] of Object.entries(stripMeta(u))) {
      if (keep(`port:${key}:${f}`)) continue;
      if (v === null) delete next[f];
      else next[f] = structuredClone(v);
    }
    ports[i] = next;
  }
  for (const a of pp.add ?? []) {
    const key = portKey(a);
    const i = findPortByKey(ports, key);
    if (i >= 0) {
      if (!keep(`port:${key}`)) ports[i] = structuredClone(a);
    } else ports.push(structuredClone(a));
  }
  t.ports = ports;
  return storedForm(t);
}

/** The fields and port ids a patch touches (overrides are recorded only for these). */
export function patchScope(p: TemplatePatch): { fields: Set<string>; ports: Set<string> } {
  const { ports, ...fields } = p;
  return {
    fields: new Set(Object.keys(fields)),
    ports: new Set([...(ports?.update ?? []).map(updKey), ...(ports?.add ?? []).map(portKey), ...(ports?.remove ?? [])]),
  };
}
