/**
 * CLI: apply the vendors' answers (vendorResponses.ts): delete templates for good, write the
 * published values and notes.
 *
 *   npm run apply:vendor-responses -- --dry-run [--file <vendor-responses.json>]
 *   npm run apply:vendor-responses [-- --file <vendor-responses.json>]
 *
 * Default file: AVAIL_VENDOR_RESPONSES_FILE, else tools/avail/incoming/vendor-responses.json
 * (in the image: /app/incoming/vendor-responses.json). Exit code 1 when the file names a
 * curated template (nothing written).
 *
 * On the server, after a backup:
 *   ./backup.sh
 *   docker compose exec api npm run apply:vendor-responses -- --dry-run
 *   docker compose exec api npm run apply:vendor-responses
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { libraryIds } from "./libraryDir";
import { applyAllMigrations, configFromEnv } from "./server";
import { applyVendorResponses, formatVendorResponsesReport, type VendorResponses } from "./vendorResponses";
import { cliArgs, writeRunAudit } from "./audit";
import { vendorResponsesRunCounts } from "./runCounts";

const USAGE = "usage: npm run apply:vendor-responses [-- --dry-run] [-- --file <vendor-responses.json>]";
const here = path.dirname(fileURLToPath(import.meta.url));

let values: { "dry-run"?: boolean; file?: string };
try {
  ({ values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, file: { type: "string" } } }));
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(2);
}

const file = values.file
  ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values.file)
  : (process.env.AVAIL_VENDOR_RESPONSES_FILE ?? path.join(here, "../../tools/avail/incoming/vendor-responses.json"));

const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  if (!existsSync(file)) throw new Error(`${file}: no such file`);
  const input = JSON.parse(readFileSync(file, "utf8")) as VendorResponses;
  if (!Array.isArray(input.delete) || typeof input.update !== "object" || !input.update) throw new Error(`${file}: expected { delete: [...], update: {...} }`);
  applyAllMigrations(db.sqlite, config, (m) => console.error(m));
  const report = applyVendorResponses(db.sqlite, input, { dryRun: values["dry-run"], libraryIds: libraryIds() });
  process.stdout.write(formatVendorResponsesReport(report, file));
  // Blocked (curated templates in the file): nothing was written.
  if (!report.dryRun && !report.blocked.length) {
    writeRunAudit(db.sqlite, { command: "apply:vendor-responses", args: cliArgs(), counts: vendorResponsesRunCounts(report) });
  }
  if (report.blocked.length) process.exitCode = 1;
} catch (err) {
  console.error(`apply:vendor-responses failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
