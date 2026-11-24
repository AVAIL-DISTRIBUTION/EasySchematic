/**
 * CLI: what manufacturers do not publish ("Нет данных" in the engineers' worklist), per vendor,
 * as CSV on stdout — for the letters to vendors.
 *
 *   npm run -s export:vendor-requests [-- --file <worklist.xlsx>] > vendor-requests.csv
 *
 * On the server:
 *   docker compose exec -T api npm run -s export:vendor-requests > vendor-requests.csv
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { D1DatabaseShim } from "./d1";
import { vendorRequests, vendorRequestsCsv } from "./applyWorklist";
import { applyAllMigrations, configFromEnv } from "./server";
import { readWorklist, worklistPath } from "./worklistInput";

const { values } = parseArgs({ options: { file: { type: "string" } } });
const config = configFromEnv();
mkdirSync(config.dataDir, { recursive: true });
const db = new D1DatabaseShim(path.join(config.dataDir, "easyschematic.sqlite"));
try {
  applyAllMigrations(db.sqlite, config, (m) => console.error(m));
  const rows = vendorRequests(db.sqlite, readWorklist(worklistPath(values.file)));
  process.stdout.write(vendorRequestsCsv(rows));
  const byVendor = new Map<string, number>();
  for (const r of rows) byVendor.set(r.vendor, (byVendor.get(r.vendor) ?? 0) + 1);
  console.error(`vendor requests: ${rows.length} templates (${[...byVendor].map(([v, n]) => `${v} ${n}`).join(", ")})`);
} catch (err) {
  console.error(`export:vendor-requests failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
