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

/** Keys that are not template data: identity, version, what the API and the workspace add. */
const NOT_DATA = new Set(["id", "version", "avail", "lastEditedBy", "submittedBy", "createdAt", "updatedAt", "availStatus", "availLevel", "availPortsOrigin"]);

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
  for (const id of pp.remove ?? []) {
    if (!ports.some((p) => idOf(p) === id)) return { error: `patch.ports.remove: no port with id "${id}"` };
    ports = ports.filter((p) => idOf(p) !== id);
  }
  for (const u of pp.update ?? []) {
    const id = u && typeof u === "object" ? idOf(u) : "";
    const i = ports.findIndex((p) => idOf(p) === id);
    if (!id || i < 0) return { error: `patch.ports.update: no port with id "${id}" (get_template lists the ids in raw.ports)` };
    const next = { ...ports[i] };
    for (const [k, v] of Object.entries(u)) {
      if (k === "id") continue;
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
