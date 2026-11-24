/**
 * The curated library directory (library/avail; in the image /app/library/avail,
 * AVAIL_LIBRARY_DIR) and the template ids it holds, for CLIs that must never touch them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Source (api-avail/src) and bundle (api-avail/dist) both sit two levels below the repo root.
export function libraryDir(): string {
  return process.env.AVAIL_LIBRARY_DIR ?? path.join(here, "../../library/avail");
}

/** Ids of the curated library: never touched, even before import:avail has run. */
export function libraryIds(dir: string = libraryDir()): string[] {
  if (!existsSync(dir)) throw new Error(`${dir}: curated library not found (set AVAIL_LIBRARY_DIR)`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}
