/**
 * AVAIL product catalog (library/catalog/<vendor>/*.json, step 1.9): cards of Extron and Biamp
 * products by part number, ports filled in later. This module fills the ports from what we
 * already have, without touching the card:
 *
 *   1. library/avail (curated, level A) — the priority source for its own models;
 *   2. the database snapshot: same manufacturer + part number, then same model name; best
 *      candidate first (verified > draft > raw, then higher lint level, then more ports);
 *   3. a variant of the same model (same label without the variant: "(Black, MM)", or a
 *      trailing colour) that already has ports.
 *
 * Only `ports` and `slots` are copied; the card (dimensions, power, category, slotFamily, …)
 * stays as in the catalog — the catalog is the more authoritative data. Ports added by hand
 * from a datasheet (`_avail.portsSource.kind = "datasheet"`, or ports without a portsSource)
 * are never replaced; they are a variant source for the other variants.
 *
 * Pure functions, no Node or browser dependencies: the CLI (api-avail/src/fillCatalogPortsCli.ts)
 * reads the files and the snapshot itself.
 */
import { lintBlock, type BlockLevel } from "./blockLint";
import { normalizeManufacturer } from "./library";
import { slug } from "./libraryFiles";

type Obj = Record<string, unknown>;

export type PortsSourceKind = "library" | "db" | "variant" | "datasheet";
export type TemplateStatusName = "verified" | "draft" | "raw" | "hidden";

/** Where the ports of a catalog file came from (`_avail.portsSource`). */
export interface PortsSource {
  kind: PortsSourceKind;
  /** library: file name; db: template id; variant: catalog file; datasheet: document URL. */
  from?: string;
  label?: string;
  /** How the source was found (library, db). */
  match?: "part-number" | "model-name";
  status?: TemplateStatusName;
  level?: BlockLevel;
  /** datasheet: what the ports were read from when not a datasheet PDF (official product name). */
  note?: string;
}

/** `_avail` of a catalog file: free-form, these are the fields this module reads or writes. */
export interface CatalogAvail extends Obj {
  status?: string;
  variant?: string;
  altPartNumber?: string;
  slotFamilies?: string[];
  portsSource?: PortsSource;
  /** What a datasheet did not tell (step 3): ports or slots left out on purpose. */
  portsMissing?: string;
}

export interface CatalogTemplate extends Obj {
  id: string;
  label: string;
  manufacturer: string;
  modelNumber: string;
  deviceType: string;
  ports: unknown[];
  slots?: unknown[];
  _avail: CatalogAvail;
}

export interface CatalogFile {
  /** Path inside library/catalog, "extron/extron-dtp3-t-203.json". */
  file: string;
  template: CatalogTemplate;
}

/** A template that can lend its ports: from library/avail or the database snapshot. */
export interface PortDonor {
  id: string;
  label: string;
  manufacturer?: string | null;
  modelNumber?: string | null;
  ports: unknown[];
  slots?: unknown[] | null;
  /** Database status (library/avail templates count as verified). */
  status: TemplateStatusName;
  level: BlockLevel;
  /** library: file name in library/avail. */
  file?: string;
}

export const AWAITING_PORTS = "awaiting-ports";
export const PORTS_FILLED = "ports-filled";

const STATUS_RANK: Record<TemplateStatusName, number> = { verified: 0, draft: 1, raw: 2, hidden: 3 };
const LEVEL_RANK: Record<BlockLevel, number> = { A: 0, B: 1, FIX: 2 };
const COLOUR_RE = /\s+(black|white|grey|gray|silver)$/i;

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

function vendorKey(man: unknown): string {
  return norm(normalizeManufacturer(typeof man === "string" ? man : undefined) ?? man);
}

/** Label without the manufacturer: "Extron DTP3 T 203" → "dtp3 t 203". */
export function modelName(label: unknown, manufacturer: unknown): string {
  const l = norm(label);
  const m = norm(manufacturer);
  return m && l.startsWith(`${m} `) ? l.slice(m.length + 1) : l;
}

/**
 * The model a variant belongs to: label without the variant in brackets or a trailing colour.
 * "Extron NAV 10E 201 D (Black, MM)" → "extron nav 10e 201 d"; "Biamp BMA 360D White" → "biamp bma 360d".
 */
export function variantBase(label: unknown): string {
  let l = typeof label === "string" ? label.trim() : "";
  l = l.replace(/\s*\([^()]*\)\s*$/, "");
  l = l.replace(COLOUR_RE, "");
  return norm(l);
}

function hasPorts(t: { ports?: unknown; slots?: unknown }): boolean {
  return (Array.isArray(t.ports) && t.ports.length > 0) || (Array.isArray(t.slots) && t.slots.length > 0);
}

/** Ports entered by hand: from a datasheet, or present without a recorded automatic source. */
export function hasManualPorts(t: CatalogTemplate): boolean {
  const src = t._avail?.portsSource;
  if (src?.kind === "datasheet") return true;
  return !src && hasPorts(t);
}

function better(a: PortDonor, b: PortDonor): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    b.ports.length - a.ports.length ||
    a.id.localeCompare(b.id)
  );
}

/** Index of donors by manufacturer + part number / model name. */
class DonorIndex {
  private byNumber = new Map<string, PortDonor[]>();
  private byName = new Map<string, PortDonor[]>();

  constructor(donors: readonly PortDonor[]) {
    for (const d of donors) {
      if (d.status === "hidden" || !hasPorts(d)) continue;
      const v = vendorKey(d.manufacturer);
      const add = (map: Map<string, PortDonor[]>, k: string) => {
        if (!k) return;
        const key = `${v}|${k}`;
        const list = map.get(key) ?? [];
        if (!list.includes(d)) list.push(d);
        map.set(key, list);
      };
      add(this.byNumber, norm(d.modelNumber));
      add(this.byName, modelName(d.label, d.manufacturer));
      // Upstream model_number often holds the model name ("DTP CrossPoint 84 4K").
      add(this.byName, modelName(d.modelNumber, d.manufacturer));
    }
  }

  find(t: CatalogTemplate): { donor: PortDonor; match: "part-number" | "model-name" } | undefined {
    const v = vendorKey(t.manufacturer);
    const pick = (lists: (PortDonor[] | undefined)[]) => lists.flatMap((l) => l ?? []).sort(better)[0];
    const numbers = [t.modelNumber, t._avail?.altPartNumber].map(norm).filter(Boolean);
    const byNumber = pick(numbers.map((n) => this.byNumber.get(`${v}|${n}`)));
    if (byNumber) return { donor: byNumber, match: "part-number" };
    const names = [modelName(t.label, t.manufacturer), modelName(variantBase(t.label), t.manufacturer)].filter(Boolean);
    const byName = pick([...new Set(names)].map((n) => this.byName.get(`${v}|${n}`)));
    if (byName) return { donor: byName, match: "model-name" };
    return undefined;
  }
}

export interface FillRow {
  file: string;
  label: string;
  vendor: string;
  deviceType: string;
  /** Source of the ports after the run; "none" — still without ports. */
  source: PortsSourceKind | "none";
  from?: string;
  level: BlockLevel;
  changed: boolean;
}

export interface FillReport {
  rows: FillRow[];
  /** Files whose content changed (only these are written). */
  changed: CatalogFile[];
  /** Chassis whose copied slots took none of the catalog's _avail.slotFamilies: set from the catalog. */
  slotFamilyFixes: { file: string; catalog: string[]; copied: string[] }[];
}

function slotFamiliesOf(slots: unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const s of slots ?? []) {
    const o = s as Obj;
    if (typeof o?.slotFamily === "string") out.add(o.slotFamily);
    if (Array.isArray(o?.slotFamilies)) for (const f of o.slotFamilies) if (typeof f === "string") out.add(f);
  }
  return [...out];
}

/** The file with new ports/slots and _avail, keys kept in place (slots go before _avail). */
function withPorts(t: CatalogTemplate, ports: unknown[], slots: unknown[] | undefined, source: PortsSource | undefined): CatalogTemplate {
  const avail: CatalogAvail = { ...t._avail, status: ports.length || slots?.length ? PORTS_FILLED : AWAITING_PORTS };
  if (source) avail.portsSource = source;
  else delete avail.portsSource;
  const out: Obj = {};
  for (const [k, v] of Object.entries(t)) {
    if (k === "slots") continue;
    if (k === "_avail") {
      if (slots?.length) out.slots = slots;
      out._avail = avail;
    } else if (k === "ports") out.ports = ports;
    else out[k] = v;
  }
  if (!("_avail" in out)) {
    if (slots?.length) out.slots = slots;
    out._avail = avail;
  }
  if (!("ports" in out)) out.ports = ports;
  return out as CatalogTemplate;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Fills ports of catalog files from the curated library, the database snapshot and variants.
 * Returns every file's row and the files that changed. Idempotent: a second run with the same
 * inputs changes nothing.
 */
export function fillCatalogPorts(
  files: readonly CatalogFile[],
  sources: { library: readonly PortDonor[]; db: readonly PortDonor[] },
): FillReport {
  const library = new DonorIndex(sources.library);
  const db = new DonorIndex(sources.db);
  const result = new Map<string, CatalogTemplate>();
  const slotFamilyFixes: FillReport["slotFamilyFixes"] = [];

  // Pass 1: manual ports stay; library, then database.
  for (const { file, template: t } of files) {
    if (hasManualPorts(t)) {
      result.set(file, t);
      continue;
    }
    const lib = library.find(t);
    const hit = lib ?? db.find(t);
    if (!hit) {
      result.set(file, withPorts(t, [], undefined, undefined));
      continue;
    }
    const { donor, match } = hit;
    const source: PortsSource = lib
      ? { kind: "library", from: donor.file ?? donor.id, label: donor.label, match, level: donor.level }
      : { kind: "db", from: donor.id, label: donor.label, match, status: donor.status, level: donor.level };
    let slots = donor.slots?.length ? clone(donor.slots) : undefined;
    // The catalog knows the chassis' slot family better (Cable Cubby: AAP, MAAP or Flex55):
    // copied slots that take none of its families get the catalog's.
    const want = t._avail?.slotFamilies ?? [];
    const got = slotFamiliesOf(slots);
    if (slots && want.length && got.length && !want.some((f) => got.includes(f))) {
      slots = slots.map((s) => {
        const { slotFamilies: _drop, ...rest } = s as Obj;
        return { ...rest, slotFamily: want[0], ...(want.length > 1 ? { slotFamilies: want.slice(1) } : {}) };
      });
      slotFamilyFixes.push({ file, catalog: want, copied: got });
    }
    result.set(file, withPorts(t, clone(donor.ports), slots, source));
  }

  // Pass 2: variants without ports take them from a described variant of the same model.
  const groups = new Map<string, string[]>();
  for (const { file, template: t } of files) {
    const key = `${vendorKey(t.manufacturer)}|${variantBase(t.label)}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const rank = (t: CatalogTemplate): number => {
    const k = t._avail.portsSource?.kind;
    const base = hasManualPorts(t) ? 0 : k === "library" ? 1 : k === "db" ? 2 : 9;
    return base * 10 + LEVEL_RANK[lintBlock(t).level];
  };
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const donors = members
      .map((f) => ({ file: f, t: result.get(f)! }))
      .filter(({ t }) => hasPorts(t) && t._avail.portsSource?.kind !== "variant")
      .sort((a, b) => rank(a.t) - rank(b.t) || a.file.localeCompare(b.file));
    const donor = donors[0];
    if (!donor) continue;
    for (const f of members) {
      const t = result.get(f)!;
      if (hasPorts(t)) continue;
      const source: PortsSource = { kind: "variant", from: donor.file, label: donor.t.label, level: lintBlock(donor.t).level };
      result.set(f, withPorts(t, clone(donor.t.ports), donor.t.slots?.length ? clone(donor.t.slots) : undefined, source));
    }
  }

  const rows: FillRow[] = [];
  const changed: CatalogFile[] = [];
  for (const { file, template: before } of files) {
    const t = result.get(file)!;
    const isChanged = JSON.stringify(t) !== JSON.stringify(before);
    if (isChanged) changed.push({ file, template: t });
    const src = t._avail.portsSource;
    rows.push({
      file,
      label: t.label,
      vendor: t.manufacturer,
      deviceType: t.deviceType,
      source: hasPorts(t) ? (src?.kind ?? "datasheet") : "none",
      ...(src?.from ? { from: src.from } : {}),
      level: lintBlock(t).level,
      changed: isChanged,
    });
  }
  return { rows, changed, slotFamilyFixes };
}

/** Series of a product for planning datasheet work: the first word of the model ("DTP3", "Desono"). */
export function seriesOf(t: { label?: unknown; manufacturer?: unknown }): string {
  const name = modelName(variantBase(t.label), t.manufacturer);
  return name.split(" ")[0] ?? name;
}

export function formatFillReport(r: FillReport, files: readonly CatalogFile[], dryRun: boolean): string {
  const lines = [`Catalog ports: ${r.rows.length} files${dryRun ? " (dry run, nothing written)" : ""}; changed ${r.changed.length}`, ""];
  const vendors = [...new Set(r.rows.map((x) => x.vendor))].sort();
  const kinds: (FillRow["source"])[] = ["library", "db", "variant", "datasheet", "none"];
  lines.push(`${"vendor".padEnd(10)} ${kinds.map((k) => k.padStart(9)).join(" ")}   A / B / FIX`);
  for (const v of [...vendors, "total"]) {
    const rows = v === "total" ? r.rows : r.rows.filter((x) => x.vendor === v);
    const n = (k: FillRow["source"]) => rows.filter((x) => x.source === k).length;
    const lv = (l: BlockLevel) => rows.filter((x) => x.level === l).length;
    lines.push(`${v.padEnd(10)} ${kinds.map((k) => String(n(k)).padStart(9)).join(" ")}   ${lv("A")} / ${lv("B")} / ${lv("FIX")}`);
  }
  const withPortsRows = r.rows.filter((x) => x.source !== "none");
  const lv = (l: BlockLevel) => withPortsRows.filter((x) => x.level === l).length;
  lines.push("", `With ports: ${withPortsRows.length} — A ${lv("A")} / B ${lv("B")} / FIX ${lv("FIX")}`);

  // Without ports: by series (datasheet work plan, biggest first) and by device type.
  const byFile = new Map(files.map((f) => [f.file, f.template]));
  const none = r.rows.filter((x) => x.source === "none");
  const count = (key: (x: FillRow) => string) => {
    const m = new Map<string, number>();
    for (const x of none) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  lines.push("", `Without ports: ${none.length}. By device type:`);
  for (const [k, n] of count((x) => x.deviceType)) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  lines.push("", "By series (one datasheet often covers a series):");
  for (const [k, n] of count((x) => `${x.vendor} ${seriesOf(byFile.get(x.file) ?? x)}`).slice(0, 40)) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  if (r.slotFamilyFixes.length) {
    lines.push("", "Chassis whose copied slots got the catalog slot family:");
    for (const m of r.slotFamilyFixes) lines.push(`  ${m.file}: ${m.copied.join(", ")} → ${m.catalog.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

/** Catalog file name: "<vendor>/<slug(label)>.json". */
export function catalogFileName(t: { label?: unknown; manufacturer?: unknown }): string {
  return `${slug(typeof t.manufacturer === "string" ? t.manufacturer : "")}/${slug(typeof t.label === "string" ? t.label : "")}.json`;
}
