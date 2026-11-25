/**
 * CLI: ports of Extron products from the Extron Visio stencils (Engineering Drawings, logical
 * view), see src/avail/extronVisio.ts. Reads every .vssx under the stencil folder and writes
 * tools/avail/extron-visio/extron-visio-blocks.json — the parsed blocks fill:catalog-ports
 * applies to the catalog. The stencils themselves are not in git (22 MB, from extron.com).
 *
 *   npm run parse:extron-visio [-- --dir <stencils>] [-- --out <blocks.json>] [-- --verbose]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mastersOfXml, stencilPorts, type StencilBlock } from "../../src/avail/extronVisio";
import { readZipText } from "./xlsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: npm run parse:extron-visio [-- --dir <stencils>] [-- --out <blocks.json>] [-- --verbose]";

let values: { dir?: string; out?: string; verbose?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: "string", default: path.join(here, "../../tools/avail/incoming/extron-visio") },
      out: { type: "string", default: path.join(here, "../../tools/avail/extron-visio/extron-visio-blocks.json") },
      verbose: { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : f.toLowerCase().endsWith(".vssx") ? [p] : [];
    });
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const dir = path.resolve(cwd, values.dir!);
const out = path.resolve(cwd, values.out!);

try {
  if (!existsSync(dir)) throw new Error(`${dir}: stencil folder not found (--dir)`);
  const blocks: StencilBlock[] = [];
  const files = walk(dir);
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    const parts = readZipText(readFileSync(file), (n) => /^visio\/masters\/master\d+\.xml$/.test(n));
    const names = [...parts.keys()].sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    for (const n of names) for (const m of mastersOfXml(parts.get(n)!, rel)) blocks.push(stencilPorts(m));
  }
  const withPart = blocks.filter((b) => b.partNumbers.length);
  // One master per line: compact, and a re-parse shows in a diff as the masters that changed.
  writeFileSync(
    out,
    `{"source": "Extron Engineering Drawings Library (Visio, logical view)",\n"blocks": [\n${withPart.map((b) => JSON.stringify(b)).join(",\n")}\n]}\n`,
  );

  const clean = withPart.filter((b) => !b.issues.length);
  const lines = [
    `Extron stencils: ${files.length} files, ${blocks.length} masters, ${withPart.length} with a part number`,
    `  clean (no issues): ${clean.length}; with issues: ${withPart.length - clean.length}; ports in clean: ${clean.reduce((n, b) => n + b.ports.length, 0)}`,
    `  written: ${path.relative(cwd, out)}`,
    "",
  ];
  const tally = (re: RegExp) => {
    const m = new Map<string, number>();
    for (const b of withPart) for (const i of b.issues) {
      const x = re.exec(i);
      if (x) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const kinds = new Map<string, number>();
  for (const b of withPart) for (const i of b.issues) {
    const k = i.replace(/[:(].*$/, "").replace(/ "[^"]*"/g, "").trim();
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  lines.push("Issues by kind:");
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(n).padStart(5)}  ${k}`);
  const show = (title: string, list: [string, number][]) => {
    if (!list.length) return;
    lines.push("", title);
    for (const [k, n] of list.slice(0, values.verbose ? 1000 : 40)) lines.push(`  ${String(n).padStart(5)}  ${k}`);
  };
  show("Unknown labels:", tally(/^unknown label "([^"]*)"/));
  show("Unknown connectors:", tally(/^unknown connector "([^"]*)"/));
  show("Pin-level rows:", tally(/^pin-level drawing: "([^"]*)"/));
  process.stdout.write(lines.join("\n") + "\n");
} catch (err) {
  console.error(`parse:extron-visio failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
