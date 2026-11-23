/**
 * AVAIL block linter CLI (src/avail/blockLint.ts).
 *
 *   npm run avail:lint -- <schematic.json | device-archive.json> [--verbose]
 *
 * Relative paths resolve against the directory npm was run from.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatBlockReport, lintDocument } from "./blockLint";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  process.stderr.write("usage: npm run avail:lint -- <schematic.json | device-archive.json> [--verbose]\n");
  process.exit(2);
}
const doc: unknown = JSON.parse(readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"));
process.stdout.write(formatBlockReport(lintDocument(doc), verbose));
