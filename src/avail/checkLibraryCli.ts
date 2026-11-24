/**
 * CI check of the curated library (src/avail/libraryFiles.ts):
 *
 *   npm run avail:check-library
 *
 * library/avail/*.json        — every file at standard level A, file name by label, unique ids
 * library/avail-pending/*.json — shape and file name only (level not required)
 * library/hidden.json         — well-formed
 * Exits with 1 when anything fails, so the build goes red.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLibrary, formatLibraryCheck, parseHiddenList, type LibraryEntry } from "./libraryFiles";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../library");

function readDir(dir: string): LibraryEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      try {
        return { file, template: JSON.parse(text) as unknown };
      } catch (err) {
        return { file, template: `invalid JSON: ${String(err)}` };
      }
    });
}

let ok = true;
const curated = checkLibrary(readDir(path.join(root, "avail")));
process.stdout.write(formatLibraryCheck(curated, "library/avail"));
ok &&= curated.ok;

const pendingEntries = readDir(path.join(root, "avail-pending"));
const pending = checkLibrary(pendingEntries, false);
process.stdout.write(`\nPending (level not required): ${pendingEntries.length} files\n`);
for (const f of pending.files) {
  process.stdout.write(`${f.lint.level.padEnd(4)} ${f.file}\n`);
  for (const p of f.problems) process.stdout.write(`      ! ${p}\n`);
}
for (const p of pending.problems) process.stdout.write(`! ${p}\n`);
ok &&= pending.ok;

const hiddenFile = path.join(root, "hidden.json");
if (existsSync(hiddenFile)) {
  try {
    const hidden = parseHiddenList(JSON.parse(readFileSync(hiddenFile, "utf8")));
    process.stdout.write(`\nHidden list: ${hidden.length} templates\n`);
  } catch (err) {
    process.stdout.write(`\n! library/hidden.json: ${err instanceof Error ? err.message : String(err)}\n`);
    ok = false;
  }
}

if (!ok) process.exitCode = 1;
