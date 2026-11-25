/**
 * Reading and writing the product catalog (library/catalog/<vendor>/*.json, step 1.9) for the
 * CLIs: fill:catalog-ports writes ports into the files, import:catalog loads level A files.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogFile, CatalogTemplate } from "../../src/avail/catalogPorts";

const here = path.dirname(fileURLToPath(import.meta.url));

// Source (api-avail/src) and bundle (api-avail/dist) both sit two levels below the repo root.
export function catalogDir(): string {
  return process.env.AVAIL_CATALOG_DIR ?? path.join(here, "../../library/catalog");
}

export interface CatalogFileText extends CatalogFile {
  /** Exact file content (its sha-256 tells import:catalog whether the file changed). */
  text: string;
}

/** Every <vendor>/*.json of the catalog (index.json and README are not templates), sorted. */
export function readCatalog(dir: string): CatalogFileText[] {
  if (!existsSync(dir)) throw new Error(`${dir}: catalog not found (set AVAIL_CATALOG_DIR or --dir)`);
  const out: CatalogFileText[] = [];
  for (const vendor of readdirSync(dir).sort()) {
    const vdir = path.join(dir, vendor);
    if (!statSync(vdir).isDirectory()) continue;
    for (const f of readdirSync(vdir).filter((x) => x.endsWith(".json")).sort()) {
      const text = readFileSync(path.join(vdir, f), "utf8");
      out.push({ file: `${vendor}/${f}`, text, template: JSON.parse(text) as CatalogTemplate });
    }
  }
  return out;
}

/** Writes a catalog file in the catalog's format (2-space JSON, trailing newline kept as it was). */
export function writeCatalogFile(dir: string, file: CatalogFile, previousText?: string): void {
  const newline = previousText?.endsWith("\n") ? "\n" : "";
  writeFileSync(path.join(dir, file.file), JSON.stringify(file.template, null, 2) + newline);
}
