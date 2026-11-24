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
