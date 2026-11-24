/**
 * Worklist follow-ups (tools/avail/incoming/worklist-followups.json): the engineers' decisions
 * that the solution texts do not spell out as "field = value", written down as operations:
 *
 *   portNote   append a note to a port (power markers of standard 3.1: "bus-powered (eBUS)",
 *              "passive", "PoE 802.3af", "phantom +48 V", "battery", "powered by host")
 *   set        a template field (slotFamily of a card by its chassis, a corrected part number,
 *              poeDrawW = PoE class maximum); onlyIfEmpty keeps a value someone already entered
 *   splitPort  a combo port ("HDMI In 4 (or DTP3)") → one port per connector, sharing an
 *              exclusiveGroup (the editor's mutually exclusive ports)
 *   addSlots   slots of a form factor (QSFP cages of a switch, by its datasheet)
 *
 * Pure: applyFollowups(template, ops) → { template, applied, skipped }. Applying the same ops
 * to the result changes nothing (an op already in place is neither applied nor skipped).
 */
import followupsJson from "../../tools/avail/incoming/worklist-followups.json";

interface OpBase {
  id: string;
  model: string;
  why?: string;
}

export interface SplitInto {
  label: string;
  signalType: string;
  direction: string;
  connectorType?: string;
  section?: string;
}

export type FollowupOp =
  | (OpBase & { op: "portNote"; port: string; note: string })
  | (OpBase & { op: "set"; field: string; value: unknown; onlyIfEmpty?: boolean })
  | (OpBase & { op: "splitPort"; port: string; into: SplitInto[]; exclusiveGroup: string })
  | (OpBase & { op: "addSlots"; family: string; labels: string[] });

export interface FollowupsFile {
  version: number;
  rule?: string;
  operations: FollowupOp[];
  /** Decided not to do now (next step), shown in the report. */
  notDone: string[];
}

export const WORKLIST_FOLLOWUPS = followupsJson as unknown as FollowupsFile;

/** Fields a follow-up may set: nothing structural (ports, slots) goes through "set". */
const SETTABLE = new Set(["slotFamily", "modelNumber", "poeDrawW", "powerDrawW", "voltage", "category", "deviceType"]);

type Port = Record<string, unknown>;

const empty = (v: unknown) => v === undefined || v === null || v === "";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function describeOp(op: FollowupOp): string {
  switch (op.op) {
    case "portNote":
      return `port "${op.port}": note "${op.note}"`;
    case "set":
      return `${op.field} = ${JSON.stringify(op.value)}`;
    case "splitPort":
      return `port "${op.port}" → ${op.into.map((p) => `"${p.label}"`).join(" + ")} (exclusive group "${op.exclusiveGroup}")`;
    case "addSlots":
      return `${op.family} slots ${op.labels.join(", ")}`;
  }
}

export function applyFollowups(
  template: Record<string, unknown>,
  ops: FollowupOp[],
): { template: Record<string, unknown>; applied: string[]; skipped: string[] } {
  const t: Record<string, unknown> = { ...template };
  let ports = (Array.isArray(t.ports) ? t.ports : []).map((p) => ({ ...(p as Port) }));
  const applied: string[] = [];
  const skipped: string[] = [];
  const portBy = (label: string) => ports.find((p) => p.label === label);

  for (const op of ops) {
    if (op.op === "portNote") {
      const p = portBy(op.port);
      if (!p) {
        skipped.push(`${describeOp(op)}: port not found`);
        continue;
      }
      const notes = typeof p.notes === "string" ? p.notes.trim() : "";
      if (notes.toLowerCase().includes(op.note.toLowerCase())) continue;
      p.notes = notes ? `${notes}; ${op.note}` : op.note;
      applied.push(describeOp(op));
    } else if (op.op === "set") {
      if (!SETTABLE.has(op.field)) {
        skipped.push(`${describeOp(op)}: field not settable by a follow-up`);
        continue;
      }
      if (op.onlyIfEmpty && !empty(t[op.field])) continue;
      if (t[op.field] === op.value) continue;
      t[op.field] = op.value;
      applied.push(describeOp(op));
    } else if (op.op === "splitPort") {
      const at = ports.findIndex((p) => p.label === op.port);
      if (at < 0) {
        if (op.into.every((i) => portBy(i.label)?.exclusiveGroup === op.exclusiveGroup)) continue; // already split
        skipped.push(`${describeOp(op)}: port not found`);
        continue;
      }
      if (op.into.some((i) => portBy(i.label))) {
        skipped.push(`${describeOp(op)}: a port with the new label already exists`);
        continue;
      }
      const old = ports[at];
      const base = typeof old.id === "string" && old.id ? old.id : slug(op.port);
      const made = op.into.map((i, n) => {
        const p: Port = { ...old, id: n === 0 ? base : `${base}-${slug(i.label)}`, ...i, exclusiveGroup: op.exclusiveGroup };
        if (!i.connectorType) delete p.connectorType;
        if (!i.section && old.section) p.section = old.section;
        return p;
      });
      ports = [...ports.slice(0, at), ...made, ...ports.slice(at + 1)];
      applied.push(describeOp(op));
    } else if (op.op === "addSlots") {
      const slots = (Array.isArray(t.slots) ? t.slots : []).map((s) => ({ ...(s as Record<string, unknown>) }));
      const missing = op.labels.filter((l) => !slots.some((s) => s.label === l));
      if (!missing.length) continue;
      for (const label of missing) slots.push({ id: `slot-${op.family}-${slug(label)}`, label, slotFamily: op.family });
      t.slots = slots;
      applied.push(`${op.family} slots ${missing.join(", ")}`);
    }
  }
  t.ports = ports;
  return { template: t, applied, skipped };
}

/** Ops grouped by template id, in file order. */
export function followupsById(file: FollowupsFile): Map<string, FollowupOp[]> {
  const out = new Map<string, FollowupOp[]>();
  for (const op of file.operations) out.set(op.id, [...(out.get(op.id) ?? []), op]);
  return out;
}
