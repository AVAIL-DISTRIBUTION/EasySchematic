/**
 * The curated AVAIL library in the repository: library/avail/*.json, one template per
 * file, named after manufacturer and model in Latin letters (extron-dtp3-t-203.json).
 *
 * Every file there must be at standard level A (src/avail/blockLint.ts); CI runs
 * checkLibrary() through `npm run avail:check-library`. Templates that cannot reach A
 * yet (missing official data) live in library/avail-pending/, which CI does not check
 * for level and import:avail does not load.
 *
 * library/hidden.json lists library templates (by id) to keep hidden, e.g. duplicates.
 *
 * Pure functions, no Node or browser dependencies: the CLI, the tests and the API
 * importer (api-avail/src/importAvail.ts) read the files themselves.
 */
import { isLifecycle, isLifecycleDate, LIFECYCLES } from "./lifecycle";
import { lintBlock, type BlockLintResult } from "./blockLint";
import { normalizeManufacturer } from "./library";

/** File name of a template: its label (manufacturer + model) in lower-case Latin, words joined by "-". */
export function libraryFileName(template: { label?: unknown }): string {
  return `${slug(typeof template.label === "string" ? template.label : "")}.json`;
}

/** "Biamp TesiraFORTÉ X 400" → "biamp-tesiraforte-x-400"; "SLXD4QDAN+A" → "slxd4qdan-a". */
export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface LibraryEntry {
  /** File name, e.g. "extron-dtp3-t-203.json". */
  file: string;
  /** Parsed file content (whatever JSON it held). */
  template: unknown;
}

export interface LibraryFileReport {
  file: string;
  label: string;
  lint: BlockLintResult;
  /** Problems that make the file unacceptable besides the lint level. */
  problems: string[];
}

export interface LibraryCheckReport {
  files: LibraryFileReport[];
  /** Problems across files: duplicate ids, duplicate manufacturer + model. */
  problems: string[];
  ok: boolean;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Manufacturer + model key used to spot two files describing the same product. */
export function productKey(t: { manufacturer?: unknown; modelNumber?: unknown; label?: unknown }): string {
  const norm = (s: unknown) => (typeof s === "string" ? s : "").trim().replace(/\s+/g, " ").toLowerCase();
  const man = normalizeManufacturer(typeof t.manufacturer === "string" ? t.manufacturer : undefined);
  return `${norm(man)}|${norm(t.modelNumber || t.label)}`;
}

/**
 * Checks one file of library/avail/. `requireLevelA` is false for library/avail-pending/,
 * where only the shape is checked.
 */
export function checkLibraryFile(entry: LibraryEntry, requireLevelA = true): LibraryFileReport {
  const problems: string[] = [];
  const t = entry.template;
  if (!isObj(t)) {
    return { file: entry.file, label: "?", lint: { level: "FIX", errors: [], warnings: [] }, problems: ["not a JSON object"] };
  }
  const lint = lintBlock(t);
  const label = typeof t.label === "string" ? t.label : "?";
  if (typeof t.id !== "string" || !t.id.trim()) problems.push("no id");
  if (!Array.isArray(t.ports)) problems.push("no ports array");
  const expected = libraryFileName(t);
  if (entry.file !== expected) problems.push(`file name must be ${expected}`);
  if (requireLevelA && lint.level !== "A") problems.push(`standard level ${lint.level}, library/avail/ needs A`);
  return { file: entry.file, label, lint, problems };
}

export function checkLibrary(entries: readonly LibraryEntry[], requireLevelA = true): LibraryCheckReport {
  const files = entries.map((e) => checkLibraryFile(e, requireLevelA));
  const problems: string[] = [];
  const seen = (key: (t: Obj) => string | null, what: string) => {
    const first = new Map<string, string>();
    for (const e of entries) {
      if (!isObj(e.template)) continue;
      const k = key(e.template);
      if (!k) continue;
      const prev = first.get(k);
      if (prev) problems.push(`${e.file}: same ${what} as ${prev}`);
      else first.set(k, e.file);
    }
  };
  seen((t) => (typeof t.id === "string" && t.id ? t.id : null), "id");
  seen((t) => productKey(t), "manufacturer + model");
  const ok = problems.length === 0 && files.every((f) => f.problems.length === 0);
  return { files, problems, ok };
}

export function formatLibraryCheck(r: LibraryCheckReport, dir: string): string {
  const lines = [`Curated library: ${dir} (${r.files.length} files)`];
  for (const f of r.files) {
    lines.push(`${f.lint.level.padEnd(4)} ${f.file}`);
    for (const p of f.problems) lines.push(`      ! ${p}`);
    if (f.lint.level !== "A") {
      for (const m of f.lint.errors) lines.push(`      E ${m}`);
      for (const m of f.lint.warnings) lines.push(`      W ${m}`);
    }
  }
  for (const p of r.problems) lines.push(`! ${p}`);
  lines.push("", r.ok ? "OK: every file is at level A" : "FAILED: fix the files above or move them to library/avail-pending/");
  return lines.join("\n") + "\n";
}

/** One entry of library/hidden.json. */
export interface HiddenEntry {
  id: string;
  label?: string;
  reason: string;
}

/** Parses library/hidden.json ({ "hidden": [{ id, label, reason }] }); throws on a malformed file. */
export function parseHiddenList(doc: unknown): HiddenEntry[] {
  const list = isObj(doc) ? doc.hidden : undefined;
  if (!Array.isArray(list)) throw new Error('hidden list: expected { "hidden": [...] }');
  return list.map((e, i) => {
    if (!isObj(e) || typeof e.id !== "string" || !e.id || typeof e.reason !== "string" || !e.reason) {
      throw new Error(`hidden list: entry ${i} needs a string id and reason`);
    }
    return { id: e.id, reason: e.reason, ...(typeof e.label === "string" ? { label: e.label } : {}) };
  });
}

/** One file of the product catalog: path "<vendor>/<file>.json" inside library/catalog. */
export interface CatalogCheckReport {
  files: LibraryFileReport[];
  problems: string[];
  /** Level counts per manufacturer, and files without ports. */
  levels: Record<string, Record<BlockLintResult["level"], number> & { noPorts: number }>;
  ok: boolean;
}

/**
 * Problems of a catalog card's lifecycle (`_avail.lifecycle`, src/avail/lifecycle.ts): a known
 * state, a date in a known format, and only the date that goes with the state.
 */
export function catalogLifecycleProblems(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (a.lifecycle !== undefined && !isLifecycle(a.lifecycle)) out.push(`_avail.lifecycle must be one of ${LIFECYCLES.join(", ")}`);
  for (const k of ["availableFrom", "eolDate"] as const) {
    if (a[k] !== undefined && !isLifecycleDate(a[k])) out.push(`_avail.${k} must be 2027, 2027-Q3, 2027-09 or 2027-09-15`);
  }
  if (a.availableFrom !== undefined && a.lifecycle !== "upcoming") out.push("_avail.availableFrom is only for lifecycle upcoming");
  if (a.eolDate !== undefined && a.lifecycle !== "eol") out.push("_avail.eolDate is only for lifecycle eol");
  return out;
}

/**
 * Checks the product catalog (library/catalog, step 1.9). The catalog is work in progress:
 * any level is allowed (FIX included) and only reported. Required: a JSON object with id,
 * ports array and _avail, file "<vendor>/<slug(label)>.json" (or "…-<slug(part number)>.json" when
 * two labels share a slug), unique ids and part numbers,
 * every file listed in index.json with its id (when the index is given).
 */
export function checkCatalog(entries: readonly LibraryEntry[], index?: unknown): CatalogCheckReport {
  const files: LibraryFileReport[] = [];
  const levels: CatalogCheckReport["levels"] = {};
  for (const e of entries) {
    const t = e.template;
    if (!isObj(t)) {
      files.push({ file: e.file, label: "?", lint: { level: "FIX", errors: [], warnings: [] }, problems: ["not a JSON object"] });
      continue;
    }
    const lint = lintBlock(t);
    const problems: string[] = [];
    if (typeof t.id !== "string" || !t.id.trim()) problems.push("no id");
    if (!Array.isArray(t.ports)) problems.push("no ports array");
    if (!isObj(t._avail)) problems.push("no _avail");
    else problems.push(...catalogLifecycleProblems(t._avail));
    const vendor = slug(typeof t.manufacturer === "string" ? t.manufacturer : "");
    const expected = `${vendor}/${libraryFileName(t)}`;
    // Two labels with the same slug ("Modena Hub", "Modena Hub+"): the part number tells them apart.
    const withNumber = expected.replace(/\.json$/, `-${slug(typeof t.modelNumber === "string" ? t.modelNumber : "")}.json`);
    if (e.file !== expected && e.file !== withNumber) problems.push(`file name must be ${expected}`);
    const man = typeof t.manufacturer === "string" && t.manufacturer ? t.manufacturer : "?";
    const lv = (levels[man] ??= { A: 0, B: 0, FIX: 0, noPorts: 0 });
    lv[lint.level]++;
    if (!(Array.isArray(t.ports) && t.ports.length) && !(Array.isArray(t.slots) && t.slots.length)) lv.noPorts++;
    files.push({ file: e.file, label: typeof t.label === "string" ? t.label : "?", lint, problems });
  }
  const report = checkLibrary(entries, false);
  // checkLibrary's per-file problems (flat file names) do not apply here: only the cross-file ones.
  const problems = [...report.problems];
  if (index !== undefined) {
    const listed = isObj(index) && Array.isArray(index.templates) ? index.templates.filter(isObj) : null;
    if (!listed) problems.push('index.json: expected { "templates": [...] }');
    else {
      const byFile = new Map(listed.map((x) => [String(x.file), x]));
      for (const e of entries) {
        const x = byFile.get(e.file);
        const id = isObj(e.template) ? e.template.id : undefined;
        if (!x) problems.push(`${e.file}: not in index.json`);
        else if (x.id !== id) problems.push(`${e.file}: id differs from index.json (${String(x.id)})`);
      }
      const files = new Set(entries.map((e) => e.file));
      for (const f of byFile.keys()) if (!files.has(f)) problems.push(`index.json: ${f} does not exist`);
    }
  }
  const ok = problems.length === 0 && files.every((f) => f.problems.length === 0);
  return { files, problems, levels, ok };
}

export function formatCatalogCheck(r: CatalogCheckReport, dir: string): string {
  const lines = [`Catalog: ${dir} (${r.files.length} files; any level allowed, work in progress)`];
  for (const [man, lv] of Object.entries(r.levels).sort()) {
    lines.push(`  ${man.padEnd(10)} A ${lv.A} / B ${lv.B} / FIX ${lv.FIX}; without ports ${lv.noPorts}`);
  }
  for (const f of r.files) for (const p of f.problems) lines.push(`! ${f.file}: ${p}`);
  for (const p of r.problems) lines.push(`! ${p}`);
  lines.push(r.ok ? "OK: catalog files are well-formed" : "FAILED: fix the catalog files above");
  return lines.join("\n") + "\n";
}
