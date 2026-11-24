/**
 * The engineers' worklist file for apply:worklist and export:vendor-requests: --file, else
 * AVAIL_WORKLIST_FILE, else the workbook in tools/avail/incoming (in the image: /app/incoming).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorklistRowInput } from "./applyWorklist";
import { readXlsx, sheetObjects } from "./xlsx";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKLIST = "Library_worklist_engineers_solutions.xlsx";

export function worklistPath(file?: string): string {
  if (file) return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  if (process.env.AVAIL_WORKLIST_FILE) return process.env.AVAIL_WORKLIST_FILE;
  return path.join(here, "../../tools/avail/incoming", DEFAULT_WORKLIST);
}

/** Rows of the "Worklist" sheet. */
export function readWorklist(file: string): WorklistRowInput[] {
  if (!existsSync(file)) throw new Error(`${file}: no such file`);
  const sheet = readXlsx(readFileSync(file)).get("Worklist");
  if (!sheet) throw new Error(`${file}: no "Worklist" sheet`);
  return sheetObjects(sheet) as WorklistRowInput[];
}
