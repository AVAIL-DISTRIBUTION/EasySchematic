/**
 * Engineers' worklist solutions (tools/avail/incoming/Library_worklist_engineers_solutions.xlsx,
 * sheet Worklist: Template id, Issue 1–3, Solution, Solution status) turned into template edits.
 *
 * A Solution is numbered lines "1) … 2) …"; line N answers Issue N. Each line is classified:
 *   applied        — structured: `field = value; …`, port renames «Old» → «New» (notes: «…»),
 *                    port fields «Port»: connectorType = …, direction = …, section …, added ports;
 *   false-positive — "ложное срабатывание" / "оставить" / "не применимо": the template is not
 *                    changed; the issue must disappear under the linter rules (checked);
 *   no-data        — "[нет данных]": the manufacturer does not publish it; the field stays empty
 *                    and goes to export:vendor-requests;
 *   manual         — free text with no unambiguous reading: not applied, listed for a person.
 * A line can mix structured fields and a no-data part ("voltage = …; потребление не опубликовано
 * [нет данных]"): what is structured is applied, the rest is reported.
 */
import { isKnownConnector } from "../../src/typeRegistry";
import { BLOCK_SECTIONS, sectionByPurpose } from "../../src/avail/sections";
import { findCategory } from "../../src/avail/library";

export type LineKind = "applied" | "false-positive" | "no-data" | "manual";

export type Action =
  | { type: "set"; field: string; value: string | number | string[] }
  | { type: "portRename"; port: string; to: string; notes?: string }
  | { type: "portSet"; port: string; field: "connectorType" | "direction" | "section" | "signalType"; value: string; checkPanel?: boolean }
  | { type: "portNotes"; port: string; notes: string }
  | { type: "portAdd"; port: Record<string, string> };

export interface SolutionLine {
  n: number;
  text: string;
  kind: LineKind;
  actions: Action[];
  /** Fields the manufacturer does not publish (no-data parts). */
  missing: string[];
  /** No-data parts that name no field (e.g. "no cards in the library"): not a vendor request. */
  missingOther: string[];
  /** Parts of the line that were not understood (manual). */
  unparsed: string[];
}

const NUMERIC = new Set(["heightMm", "widthMm", "depthMm", "weightKg", "powerDrawW", "poeDrawW", "poeBudgetW", "thermalBtuh", "powerCapacityW"]);
const TEXT = new Set(["voltage", "referenceUrl", "shortName", "label", "modelNumber", "category", "deviceType"]);
const PORT_FIELDS = ["connectorType", "direction", "section", "signalType"] as const;
const DIRECTIONS = new Set(["input", "output", "bidirectional"]);
const CONNECTOR_ALIASES: Record<string, string> = { "powercon-20": "powercon", "powercon-32": "powercon", "powercon-blue": "powercon" };
export const CHECK_PANEL_NOTE = "connector: check against the panel";
export const POE_NOT_PUBLISHED_NOTE = "actual draw not published";

const FALSE_RE = /ложное срабатывание|не применимо/i;
// JavaScript's \b does not see Cyrillic letters as word characters: explicit lookarounds.
const KEEP_RE = /(?<![а-яё])оставить(?![а-яё])/i;
const NO_DATA_RE = /\[нет данных\]|не (?:указан[аоы]?|опубликован[аоы]?|найден[аоы]?)(?![а-яё])/i;
const CHECK_PANEL_RE = /сверить с панелью/i;

/** Split on ";" outside parentheses and «quotes». */
function segments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of text) {
    if (ch === "«") quote = true;
    if (ch === "»") quote = false;
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0 && !quote) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "1,3 (при питании по PoE)" → 1.3; null when the value does not start with a number. */
export function parseNumber(v: string): number | null {
  const m = /^\s*[~≈]?\s*(\d+(?:[.,]\d+)?)/.exec(v);
  return m ? Number(m[1].replace(",", ".")) : null;
}

export function normalizeConnector(v: string): string | null {
  const c = v.trim().toLowerCase();
  const mapped = CONNECTOR_ALIASES[c] ?? c;
  return isKnownConnector(mapped) ? mapped : null;
}

/** Field names a no-data part is about. */
export function missingFields(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const f of ["heightMm", "widthMm", "depthMm", "weightKg", "powerDrawW", "poeDrawW", "voltage", "thermalBtuh", "referenceUrl", "searchTerms"]) {
    if (t.includes(f.toLowerCase())) out.add(f);
  }
  if (/данные о питании|питани[ея] .*не найден/.test(t)) {
    out.add("powerDrawW");
    out.add("voltage");
  }
  if (/потреблени|\bвт\b|мощност/.test(t)) out.add(/poe/.test(t) ? "poeDrawW" : "powerDrawW");
  if (/габарит|размер/.test(t)) ["heightMm", "widthMm", "depthMm"].forEach((f) => out.add(f));
  if (/\bвес\b|масс/.test(t)) out.add("weightKg");
  if (/ссылк|страниц[аыу]? (?:продукта|модели)/.test(t)) out.add("referenceUrl");
  return [...out];
}

function deviceAssignments(seg: string): Action[] | null {
  // "field = value" (one per segment)
  const m = /^\s*([A-Za-z]+)\s*=\s*([\s\S]+)$/.exec(seg);
  if (!m) return null;
  const field = m[1];
  const raw = m[2].trim();
  if (NUMERIC.has(field)) {
    const v = parseNumber(raw);
    return v === null ? null : [{ type: "set", field, value: v }];
  }
  if (field === "searchTerms") {
    const terms = raw.replace(/\.$/, "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return terms.length ? [{ type: "set", field, value: terms }] : null;
  }
  if (TEXT.has(field)) {
    let v = raw.replace(/^«|»$/g, "").trim();
    if (field === "category") {
      v = v.replace(/\s*\([^)]*\)\s*\.?$/, "").replace(/\.$/, "").trim();
      if (!findCategory(v)?.leaf) return null;
    }
    if (field === "referenceUrl" && !/^https?:\/\//i.test(v)) return null;
    if (field === "voltage") v = v.replace(/\.$/, "");
    return v ? [{ type: "set", field, value: v }] : null;
  }
  return null;
}

/** "connectorType = barrel (12 V DC)", "direction = input, connectorType phoenix", "section Power". */
function portAssignments(rest: string): { field: (typeof PORT_FIELDS)[number]; value: string }[] {
  const out: { field: (typeof PORT_FIELDS)[number]; value: string }[] = [];
  for (const f of PORT_FIELDS) {
    const re = new RegExp(`\\b${f}\\s*(?:=|:)?\\s*([A-Za-z][A-Za-z0-9/ +-]*?)(?=\\s*(?:[,;(.]|→|$))`, "g");
    for (const m of rest.matchAll(re)) out.push({ field: f, value: m[1].trim() });
  }
  return out;
}

export function parseSolution(text: string): SolutionLine[] {
  const lines = text
    .split(/\n|(?=\s\d+\)\s)/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: SolutionLine[] = [];
  for (const line of lines) {
    const m = /^(\d+)\)\s*([\s\S]*)$/.exec(line);
    const n = m ? Number(m[1]) : out.length + 1;
    const body = (m ? m[2] : line).trim();
    const res: SolutionLine = { n, text: body, kind: "manual", actions: [], missing: [], missingOther: [], unparsed: [] };
    out.push(res);

    if (FALSE_RE.test(body) || (/^«[^»]+»:/.test(body) && KEEP_RE.test(body) && !/→/.test(body))) {
      res.kind = "false-positive";
      continue;
    }
    const checkPanel = CHECK_PANEL_RE.test(body);
    for (const seg of segments(body)) {
      // "field = value (… не опубликовано)": an assignment with a comment, not a no-data part
      const assignment = /^\s*[A-Za-z]+\s*=/.test(seg) ? deviceAssignments(seg) : null;
      if (assignment) {
        res.actions.push(...assignment);
        continue;
      }
      if (NO_DATA_RE.test(seg)) {
        const fields = missingFields(seg);
        if (fields.length) res.missing.push(...fields);
        else res.missingOther.push(seg.replace(NO_DATA_RE, "").trim());
        continue;
      }
      // "… оставить …": keep as is, nothing to do
      if (KEEP_RE.test(seg) && !/=|→/.test(seg)) continue;
      // «Port»: section «Old» → New
      const sec = /^«([^»]+)»\s*:\s*section\s*«[^»]*»\s*→\s*([A-Za-z][A-Za-z /]*?)\s*\.?$/.exec(seg);
      if (sec) {
        res.actions.push({ type: "portSet", port: sec[1].trim(), field: "section", value: sec[2].trim(), checkPanel });
        continue;
      }
      // add a port
      const add = /добавить порт\s*«([^»]+)»\s*:?\s*([\s\S]*)$/i.exec(seg);
      if (add) {
        const port: Record<string, string> = { label: add[1].trim() };
        for (const a of portAssignments(add[2].split(/альтернативно/i)[0])) port[a.field] = a.value;
        if (port.signalType && port.direction) res.actions.push({ type: "portAdd", port });
        else res.unparsed.push(seg);
        continue;
      }
      // label «X» (a new device label in prose)
      const lbl = /\blabel\s*«([^»]+)»/.exec(seg);
      if (lbl && !/=/.test(seg)) {
        res.actions.push({ type: "set", field: "label", value: lbl[1].trim() });
        continue;
      }
      // port rename «Old» → «New» (, notes: «…»)
      const ren = /«([^»]+)»\s*→\s*«([^»]+)»(?:\s*,\s*notes:\s*«([^»]+)»)?/.exec(seg);
      if (ren) {
        res.actions.push({ type: "portRename", port: ren[1].trim(), to: ren[2].trim(), ...(ren[3] ? { notes: ren[3].trim() } : {}) });
        const after = seg.slice((ren.index ?? 0) + ren[0].length);
        for (const a of portAssignments(after)) {
          if (!KEEP_RE.test(after)) res.actions.push({ type: "portSet", port: ren[2].trim(), field: a.field, value: a.value, checkPanel });
        }
        continue;
      }
      // port fields «Port»: …
      const pf = /^«([^»]+)»\s*:\s*([\s\S]*)$/.exec(seg);
      if (pf) {
        const assigns = portAssignments(pf[2]);
        if (assigns.length) {
          for (const a of assigns) res.actions.push({ type: "portSet", port: pf[1].trim(), field: a.field, value: a.value, checkPanel });
          const notes = /notes:\s*«([^»]+)»/.exec(pf[2]);
          if (notes) res.actions.push({ type: "portNotes", port: pf[1].trim(), notes: notes[1].trim() });
        } else res.unparsed.push(seg);
        continue;
      }
      // device fields, possibly several "a = 1, b = 2" joined by commas
      const parts = seg.split(/,\s*(?=[A-Za-z]+\s*=)/);
      let ok = true;
      const acts: Action[] = [];
      for (const p of parts) {
        const a = deviceAssignments(p);
        if (!a) ok = false;
        else acts.push(...a);
      }
      if (ok && acts.length) res.actions.push(...acts);
      else {
        // a category stated inside prose: "…: category = Integration Tools / Adapters (schematic=true)."
        const cat = /\bcategory\s*=\s*([^;(]+?)\s*(?:\(|\.?$)/.exec(seg);
        const v = cat?.[1].trim().replace(/\.$/, "");
        if (v && findCategory(v)?.leaf) res.actions.push({ type: "set", field: "category", value: v });
        else res.unparsed.push(seg);
      }
    }
    if (res.actions.length) res.kind = "applied";
    else if (res.missing.length || res.missingOther.length) res.kind = "no-data";
    // A note that the actual PoE draw is not published travels with poeDrawW.
    if (/фактическое потребление не опубликовано|actual draw not published/i.test(body)) {
      for (const a of res.actions) if (a.type === "set" && a.field === "poeDrawW") (a as { notPublished?: boolean }).notPublished = true;
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
type Port = Obj & { id?: string; label?: string; notes?: string };

export interface ApplyResult {
  template: Obj;
  applied: string[];
  skipped: string[];
}

function appendNote(p: Port, note: string): void {
  const cur = typeof p.notes === "string" ? p.notes : "";
  if (!cur.toLowerCase().includes(note.toLowerCase())) p.notes = cur ? `${cur}; ${note}` : note;
}

function findPorts(ports: Port[], label: string): Port[] {
  const exact = ports.filter((p) => (p.label ?? "").trim() === label);
  return exact.length ? exact : ports.filter((p) => (p.label ?? "").trim().toLowerCase() === label.toLowerCase());
}

/** Our section for an engineer's one: the vocabulary as is; "Control" split by the port's signal. */
export function mapSection(section: string, port: Port): string | null {
  const s = section.trim();
  const base = s.replace(/\s*\([^)]*\)\s*$/, "");
  if (base === "Control") {
    const bySignal = sectionByPurpose(port);
    return bySignal && /^(Serial|IR|Relays|Digital I\/O|Control|Sync)/.test(bySignal) ? bySignal : "Control";
  }
  return (BLOCK_SECTIONS as readonly string[]).includes(base) ? s : null;
}

/** Applies the actions of one template's solution lines; nothing that is not understood. */
export function applyActions(input: Obj, actions: Action[]): ApplyResult {
  const t: Obj = structuredClone(input);
  const ports = (Array.isArray(t.ports) ? t.ports : []) as Port[];
  t.ports = ports;
  const applied: string[] = [];
  const skipped: string[] = [];
  // Renames first (a later line may already call the port by its new label), then signal and
  // direction, sections last: "Control" is split by the port's (final) signal.
  const rank = (a: Action) =>
    a.type === "portRename" ? 0 : a.type === "portSet" && (a.field === "signalType" || a.field === "direction") ? 1 : a.type === "portSet" && a.field === "section" ? 3 : 2;
  const ordered = actions.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
  for (const a of ordered) {
    if (a.type === "set") {
      if (a.field === "searchTerms") {
        const cur = Array.isArray(t.searchTerms) ? (t.searchTerms as string[]) : [];
        t.searchTerms = [...new Set([...cur, ...(a.value as string[])])];
      } else t[a.field] = a.value;
      if (a.field === "poeDrawW" && (a as { notPublished?: boolean }).notPublished) {
        // The note goes on the port that takes PoE (a LAN port), when there is one.
        const lan = ports.find((p) => /poe/i.test(`${p.label ?? ""} ${p.notes ?? ""}`)) ?? ports.find((p) => p.signalType === "ethernet" && p.direction !== "output");
        if (lan) appendNote(lan, `PoE: ${POE_NOT_PUBLISHED_NOTE}`);
      }
      applied.push(`${a.field} = ${Array.isArray(a.value) ? a.value.join(", ") : a.value}`);
      continue;
    }
    if (a.type === "portAdd") {
      const p = a.port;
      if (findPorts(ports, p.label).length) {
        skipped.push(`add port "${p.label}": a port with this label exists`);
        continue;
      }
      const port: Port = { id: `worklist-${ports.length + 1}`, label: p.label, signalType: p.signalType, direction: p.direction };
      if (p.connectorType) {
        const c = normalizeConnector(p.connectorType);
        if (c) port.connectorType = c;
      }
      if (p.section) port.section = mapSection(p.section, port) ?? undefined;
      ports.push(port);
      applied.push(`add port "${p.label}"`);
      continue;
    }
    const targets = findPorts(ports, a.port);
    if (!targets.length) {
      skipped.push(`port "${a.port}" not found (${a.type})`);
      continue;
    }
    for (const p of targets) {
      if (a.type === "portRename") {
        p.label = a.to;
        if (a.notes) appendNote(p, a.notes);
      } else if (a.type === "portNotes") {
        appendNote(p, a.notes);
      } else if (a.field === "connectorType") {
        const c = normalizeConnector(a.value);
        if (!c) {
          skipped.push(`port "${a.port}": unknown connector "${a.value}"`);
          continue;
        }
        p.connectorType = c;
        if (a.checkPanel) appendNote(p, CHECK_PANEL_NOTE);
      } else if (a.field === "direction") {
        if (!DIRECTIONS.has(a.value)) {
          skipped.push(`port "${a.port}": direction "${a.value}"`);
          continue;
        }
        p.direction = a.value;
      } else if (a.field === "section") {
        const s = mapSection(a.value, p);
        if (!s) {
          skipped.push(`port "${a.port}": section "${a.value}" is not in the vocabulary`);
          continue;
        }
        p.section = s;
      } else if (a.field === "signalType") {
        p.signalType = a.value;
      }
    }
    applied.push(
      a.type === "portRename" ? `"${a.port}" → "${a.to}"` : a.type === "portNotes" ? `"${a.port}" notes` : `"${a.port}" ${a.field} = ${a.value}`,
    );
  }
  return { template: t, applied, skipped };
}
