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
 * Extron Visio stencils (step 1.10, src/avail/extronStencil.ts) come between 1 and 2: a clean
 * stencil master with the card's part number gives the ports, the community port of the same
 * signal and direction lends its notes; curated and datasheet ports are only compared with it.
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
import { chassisSlotsFromDescription, comparePorts, indexStencils, normalizedPorts, stencilFor, stencilPortsFor, withExtronDcPower } from "./extronStencil";
import type { StencilBlock } from "./extronVisio";
import { normalizeManufacturer } from "./library";
import { slug } from "./libraryFiles";

type Obj = Record<string, unknown>;

export type PortsSourceKind = "library" | "stencil" | "db" | "variant" | "datasheet";
export type TemplateStatusName = "verified" | "draft" | "raw" | "hidden";

/** Where the ports of a catalog file came from (`_avail.portsSource`). */
export interface PortsSource {
  kind: PortsSourceKind;
  /** library: file name; stencil: stencil file; db: template id; variant: catalog file; datasheet: document URL. */
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
  /** Where a chassis got its slots when it had none (step 1.10): "variant: <file>", "description: …". */
  slotsSource?: string;
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

/** Manufacturer + model without the variant: "biamp|desono c-ic6" for "Biamp Desono C-IC6 Black". */
export function modelKey(label: unknown, manufacturer: unknown): string {
  const name = modelName(variantBase(label), manufacturer);
  return name ? `${vendorKey(manufacturer)}|${name}` : "";
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

/** What an Extron stencil did for a catalog card (step 1.10). */
export interface StencilRow {
  file: string;
  label: string;
  partNumber: string;
  /**
   * filled — the card had no ports; replaced — community ports gave way to the stencil;
   * compared — curated or datasheet ports kept, stencil compared; kept — community ports kept,
   * the stencil would lower the level (draws no connector or power port); skipped — the master
   * has issues.
   */
  action: "filled" | "replaced" | "compared" | "kept" | "skipped";
  stencil: string;
  master: string;
  /** Ports the card had (or the community donor) against the stencil, by signal and direction. */
  differences: string[];
  issues: string[];
  /** Notes / connectors taken from the community ports. */
  borrowed: number;
  levelBefore: BlockLevel | "none";
  levelAfter: BlockLevel;
}

export interface FillReport {
  rows: FillRow[];
  /** Extron stencils: one row per catalog card with a stencil master. */
  stencil: StencilRow[];
  /** Extron catalog cards whose part number no stencil master has. */
  stencilMissing: { file: string; label: string; deviceType: string; category: string }[];
  /** Extron chassis (catalog slotFamilies) without slots: slots set, or why not. */
  chassis: { file: string; label: string; slots?: number; from?: string; missing?: string }[];
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
  sources: { library: readonly PortDonor[]; db: readonly PortDonor[]; stencils?: readonly StencilBlock[] },
): FillReport {
  const library = new DonorIndex(sources.library);
  const db = new DonorIndex(sources.db);
  const stencils = indexStencils(sources.stencils ?? []);
  const result = new Map<string, CatalogTemplate>();
  const slotFamilyFixes: FillReport["slotFamilyFixes"] = [];
  const stencilRows: StencilRow[] = [];
  const stencilMissing: FillReport["stencilMissing"] = [];
  const chassis: FillReport["chassis"] = [];
  const isExtron = (t: CatalogTemplate) => vendorKey(t.manufacturer) === "extron";
  // Extron 12 V DC supply on a 2-pole captive screw (decision 2026-11): a card's ports with the rule.
  const dcPower = (t: CatalogTemplate): CatalogTemplate => {
    if (!isExtron(t) || hasManualPorts(t) || t._avail?.portsSource?.kind === "library" || !t.ports.length) return t;
    const ports = withExtronDcPower(t, t.ports);
    return ports === t.ports ? t : withPorts(t, ports, t.slots, t._avail.portsSource);
  };
  const levelBefore = (t: CatalogTemplate): BlockLevel | "none" => (hasPorts(t) ? lintBlock(t).level : "none");

  // Pass 1: manual ports stay; library, then a clean Extron stencil, then database.
  for (const { file, template: t } of files) {
    const block = sources.stencils?.length && vendorKey(t.manufacturer) === "extron" ? stencilFor(t, stencils) : undefined;
    if (sources.stencils?.length && vendorKey(t.manufacturer) === "extron" && !block) {
      stencilMissing.push({ file, label: t.label, deviceType: t.deviceType, category: String(t.category ?? "") });
    }
    // The card before the stencil: ports an earlier run took from the stencil do not count, so
    // a second run reports the same.
    const prior = t._avail?.portsSource?.kind === "stencil" ? undefined : hasPorts(t) ? t : undefined;
    // Level before: the card as it is, or the community block it would get without the stencil.
    const dbBefore = () => {
      const h = db.find(t);
      return h ? lintBlock(withPorts(t, h.donor.ports, h.donor.slots ?? undefined, undefined)).level : "none";
    };
    const row = (action: StencilRow["action"], cmp: readonly unknown[], after: CatalogTemplate, borrowed = 0): StencilRow => ({
      file,
      label: t.label,
      partNumber: t.modelNumber,
      action,
      stencil: block!.stencil,
      master: block!.master,
      differences: comparePorts(cmp, block!.ports),
      issues: block!.issues,
      borrowed,
      levelBefore: prior ? levelBefore(prior) : dbBefore(),
      levelAfter: lintBlock(after).level,
    });
    if (hasManualPorts(t)) {
      result.set(file, t);
      if (block) stencilRows.push(row("compared", t.ports, t));
      continue;
    }
    const lib = library.find(t);
    const dbHit = db.find(t);
    if (block && !lib && !block.issues.length && block.ports.length) {
      const donorPorts = dbHit?.donor.ports ?? [];
      const { ports, borrowed } = stencilPortsFor({ voltage: t.voltage, ports: donorPorts }, block);
      const source: PortsSource = { kind: "stencil", from: block.stencil, label: block.model, match: "part-number" };
      const slots = dbHit?.donor.slots?.length ? clone(dbHit.donor.slots) : undefined;
      let out = dcPower(withPorts(t, normalizedPorts(t, ports), slots, source));
      out = withPorts(out, out.ports, slots, { ...source, level: lintBlock(out).level });
      // The stencil must not lower the level (import:catalog loads level A only): where it draws
      // less than the community ports (a connector, a power port), they stay, and the card is
      // listed as "kept" with the differences for an engineer to merge.
      // The card as it was (ports from a variant, or an earlier run) counts as well.
      const before = [dbHit && dcPower(withPorts(t, clone(dbHit.donor.ports), slots, { kind: "db" })), prior && dcPower(prior)]
        .filter((x): x is CatalogTemplate => !!x)
        .map((x) => LEVEL_RANK[lintBlock(x).level]);
      if (!before.length || LEVEL_RANK[lintBlock(out).level] <= Math.min(...before)) {
        result.set(file, out);
        stencilRows.push(row(dbHit || prior ? "replaced" : "filled", dbHit ? donorPorts : (prior?.ports ?? []), out, borrowed));
        continue;
      }
    }
    const hit = lib ?? dbHit;
    if (!hit) {
      const out = withPorts(t, [], undefined, undefined);
      result.set(file, out);
      if (block) stencilRows.push(row("skipped", [], out));
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
    const out = withPorts(t, clone(donor.ports), slots, source);
    result.set(file, out);
    if (block) stencilRows.push(row(lib ? "compared" : block.issues.length || !block.ports.length ? "skipped" : "kept", donor.ports, out));
  }

  // Pass 2: variants without ports take them from a described variant of the same model.
  const groups = new Map<string, string[]>();
  for (const { file, template: t } of files) {
    const key = `${vendorKey(t.manufacturer)}|${variantBase(t.label)}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const rank = (t: CatalogTemplate): number => {
    const k = t._avail.portsSource?.kind;
    const base = hasManualPorts(t) ? 0 : k === "library" ? 1 : k === "stencil" ? 2 : k === "db" ? 3 : 9;
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

  // Extron 12 V DC rule on every card with automatic ports (db, variant; stencil already has it).
  for (const [f, t] of result) result.set(f, dcPower(t));

  // Extron chassis without slots: the slots of their variants (same model without region, AC
  // or colour) when all of them agree, else the count from the description, else the reason.
  const chassisKey = (t: CatalogTemplate) =>
    variantBase(t.label).replace(/(\s+(us|uk|eu|fr|aus|multi|multi-region|ac|no|usb|power|black|white|brushed|aluminum))+$/g, "");
  for (const { file } of files) {
    const t = result.get(file)!;
    const fams = t._avail.slotFamilies ?? [];
    if (!isExtron(t) || !fams.length || t.slots?.length || hasManualPorts(t)) continue;
    const key = chassisKey(t);
    const sib = [...result.entries()].filter(([g, x]) => g !== file && isExtron(x) && x.slots?.length && !x._avail.slotsSource && chassisKey(x) === key);
    const shapes = [...new Set(sib.map(([, x]) => JSON.stringify(x.slots)))];
    let found = shapes.length === 1 && sib.length ? { slots: JSON.parse(shapes[0]) as unknown[], from: `variant: ${sib[0][0]}` } : undefined;
    let missing: string | undefined;
    if (!found) {
      const d = chassisSlotsFromDescription(t);
      if (d.slots) found = { slots: d.slots, from: d.from! };
      else missing = d.missing;
    }
    if (found) {
      const out = withPorts(t, t.ports, found.slots, t._avail.portsSource);
      out._avail = { ...out._avail, slotsSource: found.from };
      delete out._avail.portsMissing;
      result.set(file, out);
    } else if (missing) {
      result.set(file, { ...t, _avail: { ...t._avail, portsMissing: missing } });
    }
  }
  // Reported from the files, so a second run lists the same chassis.
  for (const [file, t] of result) {
    if (!isExtron(t) || !(t._avail.slotFamilies ?? []).length) continue;
    if (t._avail.slotsSource) chassis.push({ file, label: t.label, slots: t.slots?.length ?? 0, from: String(t._avail.slotsSource) });
    else if (!t.slots?.length && t._avail.portsMissing) chassis.push({ file, label: t.label, missing: t._avail.portsMissing });
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
  // Level after the variant pass for the stencil rows.
  for (const r of stencilRows) r.levelAfter = lintBlock(result.get(r.file)!).level;
  return { rows, changed, slotFamilyFixes, stencil: stencilRows, stencilMissing, chassis };
}

/** Series of a product for planning datasheet work: the first word of the model ("DTP3", "Desono"). */
export function seriesOf(t: { label?: unknown; manufacturer?: unknown }): string {
  const name = modelName(variantBase(t.label), t.manufacturer);
  return name.split(" ")[0] ?? name;
}

export function formatFillReport(r: FillReport, files: readonly CatalogFile[], dryRun: boolean): string {
  const lines = [`Catalog ports: ${r.rows.length} files${dryRun ? " (dry run, nothing written)" : ""}; changed ${r.changed.length}`, ""];
  const vendors = [...new Set(r.rows.map((x) => x.vendor))].sort();
  const kinds: (FillRow["source"])[] = ["library", "stencil", "db", "variant", "datasheet", "none"];
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

/** Markdown report of the Extron stencils against the catalog (step 1.10). */
export function formatStencilReport(r: FillReport, dryRun: boolean): string {
  const rows = r.stencil;
  const by = (a: StencilRow["action"]) => rows.filter((x) => x.action === a);
  const levels = ["none", "FIX", "B", "A"] as const;
  const lines = [
    "# Extron stencils → catalog",
    "",
    "Generated by `npm run fill:catalog-ports` (api-avail) from `tools/avail/extron-visio/extron-visio-blocks.json`" +
      (dryRun ? " — dry run, nothing written." : "."),
    "",
    `Extron cards with a stencil master: ${rows.length}; without: ${r.stencilMissing.length}.`,
    "",
    "| Action | Cards | Meaning |",
    "|---|---:|---|",
    `| filled | ${by("filled").length} | the card had no ports, the stencil's ports are written |`,
    `| replaced | ${by("replaced").length} | community ports gave way to the stencil (notes kept where the port agrees) |`,
    `| compared | ${by("compared").length} | curated or datasheet ports kept, compared with the stencil |`,
    `| kept | ${by("kept").length} | community ports kept: the stencil would lower the level (draws no connector or power port) |`,
    `| skipped | ${by("skipped").length} | the stencil master has issues: ports from elsewhere or none |`,
    "",
    "Levels of these cards before → after (rows: before, columns: after):",
    "",
    `| before \\ after | ${levels.slice(1).join(" | ")} |`,
    `|---|${levels.slice(1).map(() => "---:").join("|")}|`,
  ];
  for (const b of levels) {
    const n = (a: string) => rows.filter((x) => x.levelBefore === b && x.levelAfter === a).length;
    lines.push(`| ${b} | ${levels.slice(1).map(n).join(" | ")} |`);
  }
  const list = (title: string, items: StencilRow[], body: (x: StencilRow) => string) => {
    lines.push("", `## ${title} (${items.length})`, "");
    for (const x of items.sort((a, b) => a.label.localeCompare(b.label))) lines.push(`- ${x.label} (${x.partNumber}) — ${body(x)}`);
  };
  list("Filled", by("filled"), (x) => `level ${x.levelAfter}`);
  list("Replaced: community ports against the stencil", by("replaced"), (x) =>
    `${x.levelBefore} → ${x.levelAfter}; ${x.differences.length ? x.differences.join("; ") : "same ports by signal and direction"}`);
  list("Compared: curated or datasheet ports kept", by("compared"), (x) =>
    x.differences.length ? x.differences.join("; ") : "agrees by signal and direction");
  list("Kept: the stencil would lower the level — merge by hand", by("kept"), (x) =>
    `level ${x.levelAfter}; ${x.differences.length ? x.differences.join("; ") : "same ports by signal and direction"}`);
  list("Skipped: stencil master has issues", by("skipped"), (x) => `level ${x.levelAfter}; ${x.issues.slice(0, 4).join("; ")}${x.issues.length > 4 ? "; …" : ""}`);
  // Why masters were skipped: the issue kinds and the labels behind them.
  const skipped = by("skipped");
  const kinds = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const x of skipped) {
    const ks = new Set(x.issues.map((i) => i.split(/[":(]/)[0].trim()));
    for (const k of ks) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    for (const i of x.issues) {
      const m = /^(unknown label|unknown connector|pin-level drawing):? "(.*)"/.exec(i);
      if (m) labels.set(`${m[1]}: ${m[2]}`, (labels.get(`${m[1]}: ${m[2]}`) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  lines.push("", "### Skipped: reasons (cards; a card can have several)", "", "| Reason | Cards |", "|---|---:|");
  for (const [k, n] of top(kinds, 20)) lines.push(`| ${k} | ${n} |`);
  lines.push("", "Top labels and connectors behind them:", "", "| Issue | Cards |", "|---|---:|");
  for (const [k, n] of top(labels, 25)) lines.push(`| ${k.replace(/\|/g, "\\|")} | ${n} |`);

  // Extron chassis without slots.
  if (r.chassis.length) {
    lines.push("", `## Chassis slots: set by this step or missing (${r.chassis.length})`, "");
    for (const c of [...r.chassis].sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`- ${c.label} — ${c.slots ? `${c.slots} slots (${c.from})` : `no slots: ${c.missing}`}`);
    }
  }

  const missing = r.stencilMissing;
  const count = (key: (x: (typeof missing)[number]) => string) => {
    const m = new Map<string, number>();
    for (const x of missing) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return top(m, 100);
  };
  lines.push("", `## Not found in the stencils (${missing.length})`, "", "By device type:", "", "| Device type | Cards |", "|---|---:|");
  for (const [k, n] of count((x) => x.deviceType)) lines.push(`| ${k} | ${n} |`);
  lines.push("", "By category:", "", "| Category | Cards |", "|---|---:|");
  for (const [k, n] of count((x) => x.category || "(none)")) lines.push(`| ${k} | ${n} |`);
  lines.push("", "Cards:", "");
  for (const x of [...missing].sort((a, b) => a.file.localeCompare(b.file))) lines.push(`- ${x.label} — ${x.deviceType}`);
  return lines.join("\n") + "\n";
}
